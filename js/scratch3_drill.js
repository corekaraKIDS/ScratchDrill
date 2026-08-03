(function(Scratch) {
    'use strict';

    // サンドボックスモードのチェック
    if (typeof window === 'undefined' || !Scratch.vm) {
        const errorMsg = "【自動採点ドリル】\nこの拡張機能は「サンドボックスなし」で読み込む必要があります。";
        // 1. もし画面がある環境（通常のブラウザ画面）ならアラートを出す
        if (typeof window !== 'undefined') {
            alert(errorMsg);
        }
        // 2. 画面がない環境（サンドボックス内）でも、TurboWarpのUIにエラーを強制表示させる
        throw new Error(errorMsg);
    }

    const runtime = Scratch.vm.runtime;

    // ドリルの正誤判定で使う機能をまとめたクラス
    class DrillValidators {
        /**
         * くり返しや条件分岐の中身（子ブロック配列）を取得する
         * @param {Object} block - 親ブロック
         * @param {Object} allBlocks - ブロック全体
         * @param {string} inputKey - 'SUBSTACK' (if/repeatの中身) または 'SUBSTACK2' (elseの中身)
         */
        static getInnerBlocks(block, allBlocks, inputKey = 'SUBSTACK') {
            if (!block || !block.inputs) return [];
            const firstBlockId = block.inputs[inputKey]?.block;
            if (!firstBlockId) return [];

            const inner = [];
            let currId = firstBlockId;
            while (currId && allBlocks[currId]) {
                const current = allBlocks[currId];
                inner.push(current);
                currId = current.next;
            }
            return inner;
        }

        // メッセージブロックから送信するメッセージ名を取得
        static getBroadcastMessage(block, allBlocks) {
            if (!block || !block.inputs) return null;
            const msgId = block.inputs.BROADCAST_INPUT?.block;
            return allBlocks[msgId]?.fields?.BROADCAST_OPTION?.value || null;
        }

        // ずっと5歩動いて、もし端についたらはねかえる
        static checkForeverMoveAndBounce(foreverBlockId, allBlocks) {
            const foreverBlock = allBlocks[foreverBlockId];

            const innerBlocks = this.getInnerBlocks(foreverBlock, allBlocks)
            if (innerBlocks.length !== 2) return false;

            // 順不同
            const moveBlock = innerBlocks.find(b => b.opcode === 'motion_movesteps');
            const bounceBlock = innerBlocks.find(b => b.opcode === 'motion_ifonedgebounce');
            if (!moveBlock || !bounceBlock) return false;

            const stepsId = moveBlock.inputs.STEPS.block;
            return allBlocks[stepsId].fields.NUM.value === '5';
        }

        /**
         * 「〇座標を △ずつ変える」処理を ◇回繰り返す構造かを判定
         * @param {Object} block - 繰り返しのトップレベルブロック (allBlocks[item.blockId])
         * @param {Object} allBlocks - すべてのブロック情報
         * @param {'x'|'y'} axis - 軸 ('x' または 'y')
         * @param {number|string} delta - 変化量 (例: -2, 2)
         * @param {number|string} times - 繰り返す回数 (例: 50)
         */
        static checkRepeatChangeCoord(block, allBlocks, axis, delta, times) {
            if (!block || block.opcode !== 'control_repeat') return false;

            // 回数チェック
            const timesId = block.inputs.TIMES?.block;
            if (!timesId || allBlocks[timesId]?.fields?.NUM?.value !== String(times)) return false;

            // くり返しの中身チェック (1個ちょうど)
            const innerBlocks = this.getInnerBlocks(block, allBlocks);
            if (innerBlocks.length !== 1) return false;

            const isX = axis.toLowerCase() === 'x';
            const expectedOpcode = isX ? 'motion_changexby' : 'motion_changeyby';
            const inputKey = isX ? 'DX' : 'DY';

            const [inner] = innerBlocks;
            if (inner.opcode !== expectedOpcode) return false;

            const deltaId = inner.inputs[inputKey]?.block;
            return allBlocks[deltaId]?.fields?.NUM?.value === String(delta);
        }

        // 「〇〇キーが押されたら 座標を △ずつ変える」ifブロックかを判定
        static checkIfKeyPressedMove(block, allBlocks, key, axis, delta) {
            if (!block || block.opcode !== 'control_if' || !block.inputs) return false;

            const condId = block.inputs.CONDITION?.block;
            const condBlock = allBlocks[condId];
            if (!condBlock || condBlock.opcode !== 'sensing_keypressed' || !condBlock.inputs) return false;

            const keyId = condBlock.inputs.KEY_OPTION?.block;
            if (allBlocks[keyId]?.fields?.KEY_OPTION?.value !== key) return false;

            const inner = this.getInnerBlocks(block, allBlocks);
            if (inner.length !== 1) return false;

            const isX = axis.toLowerCase() === 'x';
            const expectedOpcode = isX ? 'motion_changexby' : 'motion_changeyby';
            const inputKey = isX ? 'DX' : 'DY';

            const [innerBlock] = inner;
            if (innerBlock.opcode !== expectedOpcode || !innerBlock.inputs) return false;

            const deltaId = innerBlock.inputs[inputKey]?.block;
            return allBlocks[deltaId]?.fields?.NUM?.value === String(delta);
        }

        // 「〇〇キーが押されたら 表示する、でなければ 隠す」if-elseブロックかを判定
        static checkIfElseKeyPressedShowHide(block, allBlocks, key = 'space') {
            if (!block || block.opcode !== 'control_if_else' || !block.inputs) return false;

            // 1. 条件式（<スペース キーがおされた>）の検証
            const condId = block.inputs.CONDITION?.block;
            const condBlock = allBlocks[condId];
            if (!condBlock || condBlock.opcode !== 'sensing_keypressed') return false;

            const keyId = condBlock.inputs.KEY_OPTION?.block;
            if (allBlocks[keyId]?.fields?.KEY_OPTION?.value !== key) return false;

            // 2. then（もし）側: ひょうじする
            const thenBlocks = this.getInnerBlocks(block, allBlocks, 'SUBSTACK');
            if (thenBlocks.length !== 1 || thenBlocks[0].opcode !== 'looks_show') return false;

            // 3. else（でなければ）側: かくす
            const elseBlocks = this.getInnerBlocks(block, allBlocks, 'SUBSTACK2');
            if (elseBlocks.length !== 1 || elseBlocks[0].opcode !== 'looks_hide') return false;

            return true;
        }

        // 〇度回すブロックかを判定 (右回り・左回り不問)
        static checkTurn(block, allBlocks, degrees) {
            if (!block || !block.inputs) return false;
            if (block.opcode !== 'motion_turnright' && block.opcode !== 'motion_turnleft') return false;

            const degId = block.inputs.DEGREES?.block;
            return allBlocks[degId]?.fields?.NUM?.value === String(degrees);
        }
    }

    // ドリル本体
    class Scratch3Drill {
        constructor (runtime) {
            this.runtime = runtime;
            
            // 現在の問題番号（0 = 1問目）
            this.currentQuestionIndex = 0;

            // 問題リストの定義
            this.questions = [
                {
                    id: 1,
                    title: 'ネコを 100ほ うごかそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        if (first.opcode !== 'motion_movesteps') return false;
                        const numBlockId = allBlocks[first.blockId].inputs.STEPS.block;
                        return allBlocks[numBlockId].fields.NUM.value === '100';
                    }
                },
                {
                    id: 2,
                    title: 'ネコを 200ほ うごかそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        if (first.opcode !== 'motion_movesteps') return false;
                        const numBlockId = allBlocks[first.blockId].inputs.STEPS.block;
                        return allBlocks[numBlockId].fields.NUM.value === '200';
                    }
                },
                {
                    id: 3,
                    title: 'ネコを うしろに100ほ うごかそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        if (first.opcode !== 'motion_movesteps') return false;
                        const numBlockId = allBlocks[first.blockId].inputs.STEPS.block;
                        return allBlocks[numBlockId].fields.NUM.value === '-100';
                    }
                },
                {
                    id: 4,
                    title: 'まえに100ほ うごかして、\n1びょう まってから\nうしろに50ほ うごかそう！',
                    validate: (userSequence, allBlocks) => {
                        // 3つのブロックが並んでいるかチェック
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;
                        
                        if (first.opcode !== 'motion_movesteps') return false;
                        const firstStepsId = allBlocks[first.blockId].inputs.STEPS.block;
                        if (allBlocks[firstStepsId].fields.NUM.value !== '100') return false;

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;

                        if (third.opcode !== 'motion_movesteps') return false;
                        const thirdStepsId = allBlocks[third.blockId].inputs.STEPS.block;
                        if (allBlocks[thirdStepsId].fields.NUM.value !== '-50') return false;

                        return true;
                    }
                },
                {
                    id: 5,
                    title: 'まえに100ほ うごかして、\n1びょう まってから\nうしろに うごかそう！\nもとのばしょに もどってこよう！',
                    validate: (userSequence, allBlocks) => {
                        // 3つのブロックが並んでいるかチェック
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;
                        
                        if (first.opcode !== 'motion_movesteps') return false;
                        const firstStepsId = allBlocks[first.blockId].inputs.STEPS.block;
                        if (allBlocks[firstStepsId].fields.NUM.value !== '100') return false;

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;

                        if (third.opcode !== 'motion_movesteps') return false;
                        const thirdStepsId = allBlocks[third.blockId].inputs.STEPS.block;
                        if (allBlocks[thirdStepsId].fields.NUM.value !== '-100') return false;

                        return true;
                    }
                },
                {
                    id: 6,
                    title: 'ネコを みぎに15ど まわそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        
                        if (first.opcode == 'motion_turnright') {
                            const numBlockId = allBlocks[first.blockId].inputs.DEGREES.block;
                            return allBlocks[numBlockId].fields.NUM.value === '15';
                        } else if (first.opcode == 'motion_turnleft') {
                            const numBlockId = allBlocks[first.blockId].inputs.DEGREES.block;
                            return allBlocks[numBlockId].fields.NUM.value === '-15';
                        }
                        return false;
                    }
                },
                {
                    id: 7,
                    title: 'ネコを ひだりに45ど まわそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        
                        
                        if (first.opcode == 'motion_turnright') {
                            const numBlockId = allBlocks[first.blockId].inputs.DEGREES.block;
                            if (allBlocks[numBlockId].fields.NUM.value !== '-45') return false;
                        } else if (first.opcode == 'motion_turnleft') {
                            const numBlockId = allBlocks[first.blockId].inputs.DEGREES.block;
                            if (allBlocks[numBlockId].fields.NUM.value !== '45') return false;
                        }
                        return true;
                    }
                },
                {
                    id: 8,
                    title: 'ネコの むきを\n180ど（ました）に しよう！\n「まわす」は つかわないよ！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        
                        if (first.opcode !== 'motion_pointindirection') return false;
                        const numBlockId = allBlocks[first.blockId].inputs.DIRECTION.block;
                        return allBlocks[numBlockId].fields.NUM.value === '180';
                    }
                },
                {
                    id: 9,
                    title: 'みぎに90ど まわして、\n1びょう まってから\nひだりに90ど まわそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode == 'motion_turnright') {
                            const firstDegId = allBlocks[first.blockId].inputs.DEGREES.block;
                            if (allBlocks[firstDegId].fields.NUM.value !== '90') return false;
                        } else if (first.opcode == 'motion_turnleft') {
                            const firstDegId = allBlocks[first.blockId].inputs.DEGREES.block;
                            if (allBlocks[firstDegId].fields.NUM.value !== '-90') return false;
                        }

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;

                        if (third.opcode == 'motion_turnright') {
                            const thirdDegId = allBlocks[third.blockId].inputs.DEGREES.block;
                            if (allBlocks[thirdDegId].fields.NUM.value !== '-90') return false;
                        } else if (third.opcode == 'motion_turnleft') {
                            const thirdDegId = allBlocks[third.blockId].inputs.DEGREES.block;
                            if (allBlocks[thirdDegId].fields.NUM.value !== '90') return false;
                        }

                        return true;
                    }
                },
                {
                    id: 10,
                    title: 'みぎに45ど まわして、\n1びょう まってから\nむきを-90ど（ひだり）に しよう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode == 'motion_turnright') {
                            const firstDegId = allBlocks[first.blockId].inputs.DEGREES.block;
                            if (allBlocks[firstDegId].fields.NUM.value !== '45') return false;
                        } else if (first.opcode == 'motion_turnleft') {
                            const firstDegId = allBlocks[first.blockId].inputs.DEGREES.block;
                            if (allBlocks[firstDegId].fields.NUM.value !== '-45') return false;
                        }

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;

                        if (third.opcode !== 'motion_pointindirection') return false;
                        const dirId = allBlocks[third.blockId].inputs.DIRECTION.block;
                        if (allBlocks[dirId].fields.NUM.value !== '-90') return false;

                        return true;
                    }
                },
                {
                    id: 11,
                    title: 'ネコの xざひょうを 100 にしよう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        
                        if (first.opcode !== 'motion_setx') return false;
                        const xId = allBlocks[first.blockId].inputs.X.block;
                        return allBlocks[xId].fields.NUM.value === '100';
                    }
                },
                {
                    id: 12,
                    title: 'ネコの yざひょうを 100 にしよう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        
                        if (first.opcode !== 'motion_sety') return false;
                        const yId = allBlocks[first.blockId].inputs.Y.block;
                        return allBlocks[yId].fields.NUM.value === '100';
                    }
                },
                {
                    id: 13,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いこう！\nぶひんは 1つだけで できるよ！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        
                        if (first.opcode !== 'motion_gotoxy') return false;
                        const xId = allBlocks[first.blockId].inputs.X.block;
                        const yId = allBlocks[first.blockId].inputs.Y.block;
                        return allBlocks[xId].fields.NUM.value === '120' && allBlocks[yId].fields.NUM.value === '60';
                    }
                },
                {
                    id: 14,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nxざひょう: -120\nyざひょう: -60\nのばしょに いこう！',
                    validate: (userSequence, allBlocks) => {
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstX = allBlocks[first.blockId].inputs.X.block;
                        const firstY = allBlocks[first.blockId].inputs.Y.block;
                        if (allBlocks[firstX].fields.NUM.value !== '120' || allBlocks[firstY].fields.NUM.value !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;
                        
                        if (third.opcode !== 'motion_gotoxy') return false;
                        const xId = allBlocks[first.blockId].inputs.X.block;
                        const yId = allBlocks[first.blockId].inputs.Y.block;
                        return allBlocks[xId].fields.NUM.value === '-120' && allBlocks[yId].fields.NUM.value === '-60';
                    }
                },
                {
                    id: 15,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nxざひょうを 30 ふやそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstX = allBlocks[first.blockId].inputs.X.block;
                        const firstY = allBlocks[first.blockId].inputs.Y.block;
                        if (allBlocks[firstX].fields.NUM.value !== '120' || allBlocks[firstY].fields.NUM.value !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;

                        if (third.opcode !== 'motion_changexby') return false;
                        const dxId = allBlocks[third.blockId].inputs.DX.block;
                        return allBlocks[dxId].fields.NUM.value === '30';
                    }
                },
                {
                    id: 16,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nyざひょうを 40 へらそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstX = allBlocks[first.blockId].inputs.X.block;
                        const firstY = allBlocks[first.blockId].inputs.Y.block;
                        if (allBlocks[firstX].fields.NUM.value !== '120' || allBlocks[firstY].fields.NUM.value !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;

                        if (third.opcode !== 'motion_changeyby') return false;
                        const dyId = allBlocks[third.blockId].inputs.DY.block;
                        return allBlocks[dyId].fields.NUM.value === '-40';
                    }
                },
                {
                    id: 17,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nみぎに 80 うごこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstX = allBlocks[first.blockId].inputs.X.block;
                        const firstY = allBlocks[first.blockId].inputs.Y.block;
                        if (allBlocks[firstX].fields.NUM.value !== '120' || allBlocks[firstY].fields.NUM.value !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;

                        if (third.opcode !== 'motion_changexby') return false;
                        const dxId = allBlocks[third.blockId].inputs.DX.block;
                        return allBlocks[dxId].fields.NUM.value === '80';
                    }
                },
                {
                    id: 18,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nひだりに 80 うごこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstX = allBlocks[first.blockId].inputs.X.block;
                        const firstY = allBlocks[first.blockId].inputs.Y.block;
                        if (allBlocks[firstX].fields.NUM.value !== '120' || allBlocks[firstY].fields.NUM.value !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;

                        if (third.opcode !== 'motion_changexby') return false;
                        const dxId = allBlocks[third.blockId].inputs.DX.block;
                        return allBlocks[dxId].fields.NUM.value === '-80';
                    }
                },
                {
                    id: 19,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nうえに 40 うごこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstX = allBlocks[first.blockId].inputs.X.block;
                        const firstY = allBlocks[first.blockId].inputs.Y.block;
                        if (allBlocks[firstX].fields.NUM.value !== '120' || allBlocks[firstY].fields.NUM.value !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;

                        if (third.opcode !== 'motion_changeyby') return false;
                        const dyId = allBlocks[third.blockId].inputs.DY.block;
                        return allBlocks[dyId].fields.NUM.value === '40';
                    }
                },
                {
                    id: 20,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nしたに 100 うごこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstX = allBlocks[first.blockId].inputs.X.block;
                        const firstY = allBlocks[first.blockId].inputs.Y.block;
                        if (allBlocks[firstX].fields.NUM.value !== '120' || allBlocks[firstY].fields.NUM.value !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        const waitId = allBlocks[second.blockId].inputs.DURATION.block;
                        if (allBlocks[waitId].fields.NUM.value !== '1') return false;

                        if (third.opcode !== 'motion_changeyby') return false;
                        const dyId = allBlocks[third.blockId].inputs.DY.block;
                        return allBlocks[dyId].fields.NUM.value === '-100';
                    }
                },
                {
                    id: 21,
                    title: 'ずっと 10ど まわしつづける',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                        if (innerBlocks.length !== 1) return false;

                        return DrillValidators.checkTurn(innerBlocks[0], allBlocks, 10);
                    }
                },
                {
                    id: 22,
                    title: 'ずっと 5ほ うごきつづける',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;

                        if (first.opcode !== 'control_forever') return false;
                        const foreverBlock = allBlocks[first.blockId];
                        const innerBlocks = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                        if (innerBlocks.length !== 1) return false;
                        const innerBlock = innerBlocks[0];

                        if (innerBlock.opcode !== 'motion_movesteps') return false;
                        const stepsId = innerBlock.inputs.STEPS.block;
                        return allBlocks[stepsId].fields.NUM.value === '5';
                    }
                },
                {
                    id: 23,
                    title: 'ずっと\n1びょう ごとに\n5ほ うごきつづける',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;

                        if (first.opcode !== 'control_forever') return false;
                        const foreverBlock = allBlocks[first.blockId];

                        const innerBlocks = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                        if (innerBlocks.length !== 2) return false;

                        // 順不同
                        const waitBlock = innerBlocks.find(b => b.opcode === 'control_wait');
                        const moveBlock = innerBlocks.find(b => b.opcode === 'motion_movesteps');
                        if (!waitBlock || !moveBlock) return false;

                        // 1秒待つ
                        const durId = waitBlock.inputs.DURATION?.block;
                        if (!durId || allBlocks[durId]?.fields?.NUM?.value !== '1') return false;

                        // 5歩動く
                        const stepsId = moveBlock.inputs.STEPS?.block;
                        return stepsId && allBlocks[stepsId]?.fields?.NUM?.value === '5';
                    }
                },
                {
                    id: 24,
                    title: 'ずっと 5ほ うごきつづけて、\nはしに ついたら はねかえる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;

                        if (first.opcode !== 'control_forever') return false;
                        return DrillValidators.checkForeverMoveAndBounce(first.blockId, allBlocks);
                    }
                },
                {
                    id: 25,
                    title: 'かいてんほうほうを さゆうのみに してから\nずっと 5ほ うごきつづけて、\nはしに ついたら はねかえる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;
                        const [first, second] = userSequence;

                        if (first.opcode !== 'motion_setrotationstyle') return false;
                        const styleBlock = allBlocks[first.blockId];
                        if (styleBlock.fields.STYLE.value !== 'left-right') return false;

                        if (second.opcode !== 'control_forever') return false;
                        return DrillValidators.checkForeverMoveAndBounce(second.blockId, allBlocks);
                    }
                },
                {
                    id: 26,
                    title: 'yざひょうを 20ふやす ことを\n5かい くりかえす',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;

                        if (first.opcode !== 'control_repeat') return false;
                        const repeatBlock = allBlocks[first.blockId];

                        if (!repeatBlock.inputs.TIMES) return false;
                        const timesId = repeatBlock.inputs.TIMES.block;
                        if (!timesId || allBlocks[timesId]?.fields?.NUM?.value !== '5') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(repeatBlock, allBlocks);
                        if (innerBlocks.length !== 1) return false;

                        const [inner] = innerBlocks;
                        if (inner.opcode !== 'motion_changeyby') return false;

                        const dyId = inner.inputs.DY?.block;
                        return dyId && allBlocks[dyId]?.fields?.NUM?.value === '20';
                    }
                },
                {
                    id: 27,
                    title: '1びょう ごとに\nyざひょうを 20ふやす ことを\n5かい くりかえす',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;

                        if (first.opcode !== 'control_repeat') return false;
                        const repeatBlock = allBlocks[first.blockId];

                        if (!repeatBlock.inputs.TIMES) return false;
                        const timesId = repeatBlock.inputs.TIMES.block;
                        if (!timesId || allBlocks[timesId]?.fields?.NUM?.value !== '5') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(repeatBlock, allBlocks);
                        if (innerBlocks.length !== 2) return false;

                        // 順不同
                        const waitBlock = innerBlocks.find(b => b.opcode === 'control_wait');
                        const changeYBlock = innerBlocks.find(b => b.opcode === 'motion_changeyby');
                        if (!waitBlock || !changeYBlock) return false;

                        // 1秒
                        const durId = waitBlock.inputs.DURATION?.block;
                        if (!durId || allBlocks[durId]?.fields?.NUM?.value !== '1') return false;

                        // y座標 +20
                        const dyId = changeYBlock.inputs.DY?.block;
                        return dyId && allBlocks[dyId]?.fields?.NUM?.value === '20';
                    }
                },
                {
                    id: 28,
                    title: '1びょう ごとに\nyざひょうを 20ふやす ことを\n5かい くりかえし、\nそのあとで yざひょうを 0にする',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;
                        const [first, second] = userSequence;

                        if (first.opcode !== 'control_repeat') return false;
                        const repeatBlock = allBlocks[first.blockId];

                        if (!repeatBlock.inputs.TIMES) return false;
                        const timesId = repeatBlock.inputs.TIMES.block;
                        if (!timesId || allBlocks[timesId]?.fields?.NUM?.value !== '5') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(repeatBlock, allBlocks);
                        if (innerBlocks.length !== 2) return false;

                        // 順不同
                        const waitBlock = innerBlocks.find(b => b.opcode === 'control_wait');
                        const changeYBlock = innerBlocks.find(b => b.opcode === 'motion_changeyby');
                        if (!waitBlock || !changeYBlock) return false;

                        // 1秒
                        const durId = waitBlock.inputs.DURATION?.block;
                        if (!durId || allBlocks[durId]?.fields?.NUM?.value !== '1') return false;

                        // y座標 20
                        const dyId = changeYBlock.inputs.DY?.block;
                        if (!dyId || allBlocks[dyId]?.fields?.NUM?.value !== '20') return false;

                        // パターンA: 「yざひょうを 0 にする」
                        if (second.opcode === 'motion_sety') {
                            const setyBlock = allBlocks[second.blockId];
                            const yId = setyBlock.inputs.Y?.block;
                            if (!yId) return false;

                            const yVal = allBlocks[yId]?.fields?.NUM?.value;
                            return yVal === '0';
                        }

                        // パターンB: 「x: ◯ y: 0 にいく」 (y座標が0であれば正解)
                        if (second.opcode === 'motion_gotoxy') {
                            const gotoBlock = allBlocks[second.blockId];
                            const yId = gotoBlock.inputs.Y?.block;
                            if (!yId) return false;

                            const yVal = allBlocks[yId]?.fields?.NUM?.value;
                            return yVal === '0';
                        }

                        // どちらでもなければ不正解
                        return false;
                    }
                },
                {
                    id: 29,
                    title: 'xざひょうを 2へらす ことを\nスペースキーが おされるまで くりかえす',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;

                        if (first.opcode !== 'control_repeat_until') return false;
                        const repeatBlock = allBlocks[first.blockId];

                        if (!repeatBlock.inputs.CONDITION) return false;
                        const condId = repeatBlock.inputs.CONDITION.block;
                        const condBlock = allBlocks[condId];
                        if (!condBlock || condBlock.opcode !== 'sensing_keypressed') return false;

                        const keyMenuId = condBlock.inputs.KEY_OPTION?.block;
                        if (!keyMenuId || allBlocks[keyMenuId]?.fields?.KEY_OPTION?.value !== 'space') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(repeatBlock, allBlocks);
                        if (innerBlocks.length !== 1) return false;

                        const [inner] = innerBlocks;
                        if (inner.opcode !== 'motion_changexby') return false;

                        const dxId = inner.inputs.DX?.block;
                        return dxId && allBlocks[dxId]?.fields?.NUM?.value === '-2';
                    }
                },
                {
                    id: 30,
                    title: 'xざひょうを 2へらす ことを\nはしに つくまで くりかえし、\nそのあとで もとのばしょに もどる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;
                        const [first, second] = userSequence;

                        if (first.opcode !== 'control_repeat_until') return false;
                        const repeatBlock = allBlocks[first.blockId];

                        if (!repeatBlock.inputs.CONDITION) return false;
                        const condId = repeatBlock.inputs.CONDITION.block;
                        const condBlock = allBlocks[condId];
                        if (!condBlock || condBlock.opcode !== 'sensing_touchingobject') return false;

                        const menuId = condBlock.inputs.TOUCHINGOBJECTMENU?.block;
                        if (!menuId || allBlocks[menuId]?.fields?.TOUCHINGOBJECTMENU?.value !== '_edge_') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(repeatBlock, allBlocks);
                        if (innerBlocks.length !== 1) return false;

                        const [inner] = innerBlocks;
                        if (inner.opcode !== 'motion_changexby') return false;

                        const dxId = inner.inputs.DX?.block;
                        if (!dxId || allBlocks[dxId]?.fields?.NUM?.value !== '-2') return false;

                        // パターンA: 「x: 0 y: 0 にいく」
                        if (second.opcode === 'motion_gotoxy') {
                            const gotoBlock = allBlocks[second.blockId];
                            const xId = gotoBlock.inputs.X?.block;
                            const yId = gotoBlock.inputs.Y?.block;
                            if (!xId || !yId) return false;

                            const xVal = allBlocks[xId]?.fields?.NUM?.value;
                            const yVal = allBlocks[yId]?.fields?.NUM?.value;
                            return xVal === '0' && yVal === '0';
                        }

                        // パターンB: 「xざひょうを 0 にする」
                        if (second.opcode === 'motion_setx') {
                            const setxBlock = allBlocks[second.blockId];
                            const xId = setxBlock.inputs.X?.block;
                            if (!xId) return false;

                            const xVal = allBlocks[xId]?.fields?.NUM?.value;
                            return xVal === '0';
                        }

                        // どちらでもなければ不正解
                        return false;
                    }
                },
                {
                    id: 31,
                    title: 'xざひょうを 2へらす ことを\n50かい くりかえし、\nそのあとで\nメッセージ「かくだい」を おくる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;
                        const [first, second] = userSequence;

                        // 1個目: x座標を -2 変えるのを 50回繰り返す
                        if (!DrillValidators.checkRepeatChangeCoord(allBlocks[first.blockId], allBlocks, 'x', -2, 50)) return false;

                        // 2個目: メッセージ「かくだい」を送る
                        if (second.opcode !== 'event_broadcast') return false;
                        return DrillValidators.getBroadcastMessage(allBlocks[second.blockId], allBlocks) === 'かくだい';
                    }
                },
                {
                    id: 32,
                    title: 'xざひょうを 2へらす ことを\n50かい くりかえし、\nそのあとで\nメッセージ「１かいてん」を おくる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;
                        const [first, second] = userSequence;

                        // 1個目: x座標を -2 変えるのを 50回繰り返す
                        if (!DrillValidators.checkRepeatChangeCoord(allBlocks[first.blockId], allBlocks, 'x', -2, 50)) return false;

                        // 2個目: メッセージ「１かいてん」を送る
                        if (second.opcode !== 'event_broadcast') return false;
                        return DrillValidators.getBroadcastMessage(allBlocks[second.blockId], allBlocks) === '１かいてん';
                    }
                },
                {
                    id: 33,
                    title: 'xざひょうを 2へらす ことを\n50かい くりかえし、\nそのあとで\nメッセージ「１かいてん」を おくり、\nこんどは xざひょうを 2ふやす ことを\n50かい くりかえす',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        // 1個目: x座標を -2 変えるのを 50回繰り返す
                        if (!DrillValidators.checkRepeatChangeCoord(allBlocks[first.blockId], allBlocks, 'x', -2, 50)) return false;

                        // 2個目: メッセージ「１かいてん」を送る
                        if (second.opcode !== 'event_broadcast') return false;
                        if (DrillValidators.getBroadcastMessage(allBlocks[second.blockId], allBlocks) !== '１かいてん') return false;

                        // 3個目: x座標を 2 変えるのを 50回繰り返す
                        return DrillValidators.checkRepeatChangeCoord(allBlocks[third.blockId], allBlocks, 'x', 2, 50);
                    }
                },
                {
                    id: 34,
                    title: 'xざひょうを 2へらす ことを\n50かい くりかえし、\nそのあとで\nメッセージ「１かいてん」を おくって おわるまで まち、\nxざひょうを 2ふやす ことを\n50かい くりかえす',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        // 1個目: x座標を -2 変えるのを 50回繰り返す
                        if (!DrillValidators.checkRepeatChangeCoord(allBlocks[first.blockId], allBlocks, 'x', -2, 50)) return false;

                        // 2個目: メッセージ「１かいてん」を送って待つ
                        if (second.opcode !== 'event_broadcastandwait') return false;
                        if (DrillValidators.getBroadcastMessage(allBlocks[second.blockId], allBlocks) !== '１かいてん') return false;

                        // 3個目: x座標を 2 変えるのを 50回繰り返す
                        return DrillValidators.checkRepeatChangeCoord(allBlocks[third.blockId], allBlocks, 'x', 2, 50);
                    }
                },
                {
                    id: 35,
                    title: 'ねこは うごかさず、まず\nメッセージ「１かいてん」を おくり、\n1びょうごに\nメッセージ「かくだい」を おくる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        // 1個目: メッセージ「１かいてん」を送る
                        if (first.opcode !== 'event_broadcast') return false;
                        if (DrillValidators.getBroadcastMessage(allBlocks[first.blockId], allBlocks) !== '１かいてん') return false;

                        // 2個目: 1秒待つ
                        if (second.opcode !== 'control_wait') return false;
                        const waitBlock = allBlocks[second.blockId];
                        const durId = waitBlock?.inputs?.DURATION?.block;
                        if (!durId || allBlocks[durId]?.fields?.NUM?.value !== '1') return false;

                        // 3個目: メッセージ「かくだい」を送る
                        if (third.opcode !== 'event_broadcast') return false;
                        return DrillValidators.getBroadcastMessage(allBlocks[third.blockId], allBlocks) === 'かくだい';
                    }
                },
                {
                    id: 36,
                    title: '「ずっと」をつかって、\nうわむきやじるしキーを おしたとき\nyざひょうを 5ふやす',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                        if (inner.length !== 1) return false;

                        return DrillValidators.checkIfKeyPressedMove(inner[0], allBlocks, 'up arrow', 'y', 5);
                    }
                },
                {
                    id: 37,
                    title: '「ずっと」をつかって、\n上下左右（じょうげさゆう）やじるしで 上下左右に うごかす。\nすうじは 5 か -5 をつかう',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                        if (innerBlocks.length !== 4) return false;

                        const targets = [
                            { key: 'right arrow', axis: 'x', delta: 5 },
                            { key: 'left arrow', axis: 'x', delta: -5 },
                            { key: 'up arrow', axis: 'y', delta: 5 },
                            { key: 'down arrow', axis: 'y', delta: -5 }
                        ];

                        return targets.every(t => innerBlocks.some(b => DrillValidators.checkIfKeyPressedMove(b, allBlocks, t.key, t.axis, t.delta)));
                    }
                },
                {
                    id: 38,
                    title: '「ずっと」をつかって、\nスペースキーをおしたら ひょうじされて\nおさなかったら みえなくなる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                        if (inner.length !== 1) return false;
                        console.log("aaa");

                        return DrillValidators.checkIfElseKeyPressedShowHide(inner[0], allBlocks, 'space');
                    }
                },
                {
                    id: 39,
                    title: '「ずっと」をつかって、\n15ど まわしながら、\nスペースキーをおしたら ひょうじされて\nおさなかったら みえなくなる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                        if (inner.length !== 2) return false;

                        // 順不同
                        const hasTurn = inner.some(b => DrillValidators.checkTurn(b, allBlocks, 15));
                        const hasShowHide = inner.some(b => DrillValidators.checkIfElseKeyPressedShowHide(b, allBlocks, 'space'));

                        return hasTurn && hasShowHide;
                    }
                },
                {
                    id: 40,
                    title: '「ずっと」をつかって、\nスペースキーをおしたら ひょうじされて\nおさなかったら みえなくなる。\nスペースキーを おしながら みぎむきやじるしキーも おしたら\nメッセージ「かくだい」を おくる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 1) return false;

                        const ifElseBlock = inner[0];
                        if (ifElseBlock?.opcode !== 'control_if_else' || !ifElseBlock.inputs) return false;

                        // 1. 条件式（スペースキーがおされた）
                        const spaceCondId = ifElseBlock.inputs.CONDITION?.block;
                        const spaceCondBlock = allBlocks[spaceCondId];
                        if (!spaceCondBlock || spaceCondBlock.opcode !== 'sensing_keypressed' || !spaceCondBlock.inputs) return false;

                        const spaceKeyId = spaceCondBlock.inputs.KEY_OPTION?.block;
                        if (allBlocks[spaceKeyId]?.fields?.KEY_OPTION?.value !== 'space') return false;

                        // 2. でなければ（SUBSTACK2）: かくす 1個
                        const elseBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK2');
                        if (elseBlocks.length !== 1 || elseBlocks[0].opcode !== 'looks_hide') return false;

                        // 3. もし（SUBSTACK）: ひょうじする ＋ もし右向き矢印キーなら の計2個
                        const thenBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK');
                        if (thenBlocks.length !== 2) return false;

                        const hasShow = thenBlocks.some(b => b.opcode === 'looks_show');
                        if (!hasShow) return false;

                        const rightIfBlock = thenBlocks.find(b => b.opcode === 'control_if');
                        if (!rightIfBlock || !rightIfBlock.inputs) return false;

                        // 4. 内側の「もし右向き矢印キーがおされたなら」の判定
                        const rightCondId = rightIfBlock.inputs.CONDITION?.block;
                        const rightCondBlock = allBlocks[rightCondId];
                        if (!rightCondBlock || rightCondBlock.opcode !== 'sensing_keypressed' || !rightCondBlock.inputs) return false;

                        const rightKeyId = rightCondBlock.inputs.KEY_OPTION?.block;
                        if (allBlocks[rightKeyId]?.fields?.KEY_OPTION?.value !== 'right arrow') return false;

                        // 5. 内側の「メッセージ『かくだい』をおくる」の判定
                        const rightInner = DrillValidators.getInnerBlocks(rightIfBlock, allBlocks, 'SUBSTACK');
                        if (rightInner.length !== 1) return false;

                        const broadcastBlock = rightInner[0];
                        if (broadcastBlock?.opcode !== 'event_broadcast' || !broadcastBlock.inputs) return false;

                        const msgBlockId = broadcastBlock.inputs.BROADCAST_INPUT?.block;
                        const msgValue = allBlocks[msgBlockId]?.fields?.BROADCAST_OPTION?.value;

                        return msgValue === 'かくだい';
                    }
                }
            ];
        }

        // ブロックの定義
        getInfo () {
            return {
                id: 'drill',
                name: '自動採点ドリル',
                color1: '#000000',
                color2: '#000000',
                color3: '#000000',
                blocks: [
                    {
                        opcode: 'codeStart',
                        blockType: Scratch.BlockType.HAT,
                        text: 'ここから かきはじめる',
                        isEdgeActivated: false 
                    },
                    {
                        opcode: 'testRun',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'テストランする'
                    },
                    {
                        opcode: 'isValidQuestionId',
                        blockType: Scratch.BlockType.BOOLEAN,
                        text: 'もんだいばんごうOK'
                    },
                    {
                        opcode: 'startDrillWithId',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'ドリルをスタートする'
                    },
                    {
                        opcode: 'checkAnswer',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'こたえあわせをする'
                    }
                ]
            };
        }

        codeStart (args, util) {
            return true;
        }

        // 3つのスプライト（審査員、再生ボタン、ネコ）を自動識別
        getTargets (args, util) {
            let judge = null;
            let playButton = null;
            let cat = null;
            let post = null;

            for (const target of this.runtime.targets) {
                if (target.isStage) continue;
                
                const blocks = target.blocks._blocks;
                let hasCheckAnswer = false;
                let hasTestRun = false;
                let hasHat = false;

                for (const id in blocks) {
                    if (blocks[id].opcode === 'drill_checkAnswer') hasCheckAnswer = true;
                    if (blocks[id].opcode === 'drill_testRun') hasTestRun = true;
                    if (blocks[id].opcode === 'drill_codeStart') hasHat = true;
                }

                if (hasCheckAnswer) judge = target;
                else if (hasTestRun) playButton = target;
                else if (hasHat) cat = target;
                else post = target;
            }
            return { cat, playButton, judge, post };
        }

        // 変数名（文字列）を指定すると、その現在の値を返す関数
        getVariableValueByName(varName) {
            // ステージのグローバル変数（すべてのスプライト用）から探す
            const stage = this.runtime.getTargetForStage();
            if (stage && stage.variables) {
                for (const id in stage.variables) {
                    if (stage.variables[id].name === varName) {
                        return stage.variables[id].value; // 見つかったら数値を返す
                    }
                }
            }

            // 画面上に指定された変数が存在していない場合
            return null; 
        }

        isValidQuestionId (args) {
            const startQuestionId = this.getVariableValueByName('スタートばんごう');
            if (!this.questions || this.questions.length === 0) return false;
            const targetId = parseInt(startQuestionId, 10);
            // questions の中に、同じ id を持つ問題があれば true を返す
            return this.questions.some(q => q.id === targetId);
        }

        startDrillWithId (args) {
            const startQuestionId = this.getVariableValueByName('スタートばんごう');
            if (!this.questions || this.questions.length === 0) return;
            const targetId = parseInt(startQuestionId, 10);
            const targetIndex = this.questions.findIndex(q => q.id === targetId);
            
            if (targetIndex !== -1) {
                this.currentQuestionIndex = targetIndex;
            } else {
                this.currentQuestionIndex = 0; 
            }
            this.askCurrentQuestion();
        }

        askCurrentQuestion (args, util) {
            if (this.currentQuestionIndex >= this.questions.length) {
                this.sayFromJudge('ぜんもんせいかい！\nおめでとう！');
                return;
            }
            const q = this.questions[this.currentQuestionIndex];
            this.sayFromJudge(`【だい ${q.id} もん】\n${q.title}`);
        }

        sayFromJudge (text) {
            const { judge } = this.getTargets();
            if (judge) {
                this.runtime.emit('SAY', judge, 'say', text);
            }
        }

        initializeSprites () {
            const { cat, playButton, judge, post } = this.getTargets();
            if (cat) {
                this.runtime.stopForTarget(cat);
                cat.setXY(0, 0);
                cat.setDirection(90);
                cat.setSize(100);
                cat.setVisible(true);  
                cat.setRotationStyle(Scratch.BlockType.ALL_AROUND);
                cat.setCostume(0);
            }
            if (playButton) {
                playButton.setXY(-131, 146);
                playButton.setDirection(90);
                playButton.setSize(100);
                playButton.setVisible(true);  
                playButton.setCostume(0);
            }
            if (judge) {
                judge.setXY(181, -139);
                judge.setDirection(90);
                judge.setSize(30);
                judge.setVisible(true);  
                judge.setCostume(0);
            } if (post) {
                post.setXY(-190, -140);
                post.setDirection(90);
                post.setSize(25);
                post.setVisible(true);  
                post.setCostume(0);
            }
        }

        testRun (args, util) {
            const { cat, playButton } = this.getTargets();
            const activePlayButton = playButton || util.target;
            
            if (cat) {
                this.initializeSprites();

                this.sayFromJudge('')
                this.runtime.emit('SAY', activePlayButton, 'say', 'いくよ！せーの');

                setTimeout(() => {
                    this.runtime.emit('SAY', activePlayButton, 'say', '');
                    this.runtime.startHats('drill_codeStart', null, cat);
                }, 1500);
            }
        }

        checkAnswer (args, util) {
            const { cat, judge } = this.getTargets();
            const activeJudge = judge || util.target;

            if (!cat) {
                this.runtime.emit('SAY', activeJudge, 'say', 'ネコのスプライトが\nみつかりません');
                return;
            }

            if (this.currentQuestionIndex >= this.questions.length) {
                this.runtime.emit('SAY', activeJudge, 'say', 'すべての もんだいを\nクリアしています');
                return;
            }

            const currentQuestion = this.questions[this.currentQuestionIndex];
            const blocks = cat.blocks._blocks;

            let hatBlockId = null;
            for (const id in blocks) {
                if (blocks[id].opcode === 'drill_codeStart') {
                    hatBlockId = id;
                    break;
                }
            }

            if (!hatBlockId) {
                this.runtime.emit('SAY', activeJudge, 'say', 'ネコに「ここから かきはじめる」ブロックをおいて、\nそのしたにプログラムを つくってね！');
                return;
            }

            const userSequence = [];
            let currentId = blocks[hatBlockId].next;
            while (currentId) {
                const block = blocks[currentId];
                userSequence.push({opcode: block.opcode, blockId: currentId});
                currentId = block.next;
            }

            const isCorrect = currentQuestion.validate(userSequence, blocks);

            if (isCorrect) {
                this.runtime.emit('SAY', activeJudge, 'say', 'せいかい！\nつぎにすすむよ！');
                this.currentQuestionIndex++;
            } else {
                this.runtime.emit('SAY', activeJudge, 'say', 'ざんねん！\nもういちど かくにんしてみてね');
            }
                
            setTimeout(() => {
                this.initializeSprites();
                this.askCurrentQuestion();
            }, 2500);
        }
    }

    Scratch.extensions.register(new Scratch3Drill(runtime));

})(Scratch);