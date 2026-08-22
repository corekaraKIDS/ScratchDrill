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

        // 入力インプットの表示値・数値を安全に取得するヘルパー
        static getInputValue(block, inputName, allBlocks) {
            const input = block?.inputs?.[inputName];
            if (!input) return null;
            const targetBlock = allBlocks[input.block];
            if (!targetBlock?.fields) return null;
            const firstKey = Object.keys(targetBlock.fields)[0];
            return targetBlock.fields[firstKey]?.value;
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

        // 「〇〇キーが押されたら 大きさを1%ずつふやす、でなければ 1%ずつ減らす」if-elseブロックかを判定
        static checkIfElseKeyPressedChangeSize(block, allBlocks, key = 'space') {
            if (!block || block.opcode !== 'control_if_else' || !block.inputs) return false;

            // 1. 条件式（〇〇 キーがおされた）の検証
            const condId = block.inputs.CONDITION?.block;
            const condBlock = allBlocks[condId];
            if (!condBlock || condBlock.opcode !== 'sensing_keypressed') return false;

            const keyId = condBlock.inputs.KEY_OPTION?.block;
            if (allBlocks[keyId]?.fields?.KEY_OPTION?.value !== key) return false;

            // 2. then（もし）側: おおきさを 1 ずつかえる
            const thenBlocks = this.getInnerBlocks(block, allBlocks, 'SUBSTACK');
            if (thenBlocks.length !== 1 || thenBlocks[0].opcode !== 'looks_changesizeby') return false;
            if (String(this.getInputValue(thenBlocks[0], 'CHANGE', allBlocks)) !== '1') return false;

            // 3. else（でなければ）側: おおきさを -1 ずつかえる
            const elseBlocks = this.getInnerBlocks(block, allBlocks, 'SUBSTACK2');
            if (elseBlocks.length !== 1 || elseBlocks[0].opcode !== 'looks_changesizeby') return false;
            if (String(this.getInputValue(elseBlocks[0], 'CHANGE', allBlocks)) !== '-1') return false;

            return true;
        }

        // 〇度回すブロックかを判定 (右回り・左回り不問)
        static checkTurn(block, allBlocks, degrees) {
            if (!block || !block.inputs) return false;
            if (block.opcode !== 'motion_turnright' && block.opcode !== 'motion_turnleft') return false;

            const degId = block.inputs.DEGREES?.block;
            return allBlocks[degId]?.fields?.NUM?.value === String(degrees);
        }

        // 不等号・等号の向き（正順 / 逆順）に対応した数値比較判定ヘルパー
        // relation: 'gt' (大きければ), 'lt' (小さければ), 'eq' (等しければ)
        static checkComparison(block, allBlocks, targetOpcode, relation, expectedValue) {
            if (!block || !block.inputs) return false;

            const val1 = block.inputs.OPERAND1?.block;
            const val2 = block.inputs.OPERAND2?.block;

            const isVal1Target = allBlocks[val1]?.opcode === targetOpcode;
            const isVal2Target = allBlocks[val2]?.opcode === targetOpcode;

            const num1 = this.getInputValue(block, 'OPERAND1', allBlocks);
            const num2 = this.getInputValue(block, 'OPERAND2', allBlocks);

            const expectedStr = String(expectedValue);

            if (relation === 'gt') {
                // [xざひょう > 100] または [100 < xざひょう]
                if (block.opcode === 'operator_gt' && isVal1Target && String(num2) === expectedStr) return true;
                if (block.opcode === 'operator_lt' && isVal2Target && String(num1) === expectedStr) return true;
            } else if (relation === 'lt') {
                // [xざひょう < 100] または [100 > xざひょう]
                if (block.opcode === 'operator_lt' && isVal1Target && String(num2) === expectedStr) return true;
                if (block.opcode === 'operator_gt' && isVal2Target && String(num1) === expectedStr) return true;
            } else if (relation === 'eq' || relation === 'equals') {
                // [xざひょう = 100] または [100 = xざひょう]
                if (block.opcode === 'operator_equals') {
                    if (isVal1Target && String(num2) === expectedStr) return true;
                    if (isVal2Target && String(num1) === expectedStr) return true;
                }
            }
            return false;
        }

        /**
         * 変数の設定・変更ブロックの判定
         * @param {Object} block - 対象のブロック
         * @param {Object} allBlocks - ブロック全体
         * @param {string} opcode - 'data_setvariableto' または 'data_changevariableby'
         * @param {string} varName - 変数名 ('のこりじかん')
         * @param {number|string} value - 値 (例: 10, -1)
         */
        static checkVariable(block, allBlocks, opcode, varName, value) {
            if (!block || block.opcode !== opcode || !block.fields) return false;

            const varField = block.fields.VARIABLE;
            if (!varField || (varField.value !== varName && varField.id !== varName)) return false;

            const val = this.getInputValue(block, 'VALUE', allBlocks);
            return String(val) === String(value);
        }

        // 乱数ブロック (operator_random) の範囲判定
        static checkRandom(block, allBlocks, from, to) {
            if (!block || block.opcode !== 'operator_random' || !block.inputs) return false;
            const fromVal = this.getInputValue(block, 'FROM', allBlocks);
            const toVal = this.getInputValue(block, 'TO', allBlocks);
            return String(fromVal) === String(from) && String(toVal) === String(to);
        }

        // 変数を「〇〇から△△までの乱数」にする判定
        static checkSetVariableToRandom(block, allBlocks, varName, from, to) {
            if (!block || block.opcode !== 'data_setvariableto' || !block.fields) return false;
            const varField = block.fields.VARIABLE;
            if (!varField || (varField.value !== varName && varField.id !== varName)) return false;

            const valInputId = block.inputs?.VALUE?.block;
            const valBlock = allBlocks[valInputId];
            return this.checkRandom(valBlock, allBlocks, from, to);
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
                        return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) === '100';
                    }
                },
                {
                    id: 2,
                    title: 'ネコを 200ほ うごかそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        if (first.opcode !== 'motion_movesteps') return false;
                        return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) === '200';
                    }
                },
                {
                    id: 3,
                    title: 'ネコを うしろに100ほ うごかそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        if (first.opcode !== 'motion_movesteps') return false;
                        return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) === '-100';
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
                        if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) !== '100') return false;

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                        if (third.opcode !== 'motion_movesteps') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[third.blockId], 'STEPS', allBlocks)) !== '-50') return false;

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
                        if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) !== '100') return false;

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                        if (third.opcode !== 'motion_movesteps') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[third.blockId], 'STEPS', allBlocks)) !== '-100') return false;

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
                            return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) === '15';
                        } else if (first.opcode == 'motion_turnleft') {
                            return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) === '-15';
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
                            if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) !== '-45') return false;
                        } else if (first.opcode == 'motion_turnleft') {
                            if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) !== '45') return false;
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
                        return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DIRECTION', allBlocks)) === '180';
                    }
                },
                {
                    id: 9,
                    title: 'みぎに90ど まわして、\n1びょう まってから\nひだりに90ど まわそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode == 'motion_turnright') {
                            if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) !== '90') return false;
                        } else if (first.opcode == 'motion_turnleft') {
                            if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) !== '-90') return false;
                        }

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                        if (third.opcode == 'motion_turnright') {
                            if (String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DEGREES', allBlocks)) !== '-90') return false;
                        } else if (third.opcode == 'motion_turnleft') {
                            if (String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DEGREES', allBlocks)) !== '90') return false;
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
                            if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) !== '45') return false;
                        } else if (first.opcode == 'motion_turnleft') {
                            if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) !== '-45') return false;
                        }

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                        if (third.opcode !== 'motion_pointindirection') return false;
                        return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DIRECTION', allBlocks)) === '-90';
                    }
                },
                {
                    id: 11,
                    title: 'ネコの xざひょうを 100 にしよう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        
                        if (first.opcode !== 'motion_setx') return false;
                        return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'X', allBlocks)) === '100';
                    }
                },
                {
                    id: 12,
                    title: 'ネコの yざひょうを 100 にしよう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        
                        if (first.opcode !== 'motion_sety') return false;
                        return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'Y', allBlocks)) === '100';
                    }
                },
                {
                    id: 13,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いこう！\nぶひんは 1つだけで できるよ！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const [first] = userSequence;
                        
                        if (first.opcode !== 'motion_gotoxy') return false;
                        const gotoBlock = allBlocks[first.blockId];
                        return String(DrillValidators.getInputValue(gotoBlock, 'X', allBlocks)) === '120' &&
                            String(DrillValidators.getInputValue(gotoBlock, 'Y', allBlocks)) === '60';
                    }
                },
                {
                    id: 14,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nxざひょう: -120\nyざひょう: -60\nのばしょに いこう！',
                    validate: (userSequence, allBlocks) => {
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstBlock = allBlocks[first.blockId];
                        if (String(DrillValidators.getInputValue(firstBlock, 'X', allBlocks)) !== '120' ||
                            String(DrillValidators.getInputValue(firstBlock, 'Y', allBlocks)) !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;
                        
                        if (third.opcode !== 'motion_gotoxy') return false;
                        const thirdBlock = allBlocks[third.blockId];
                        return String(DrillValidators.getInputValue(thirdBlock, 'X', allBlocks)) === '-120' &&
                            String(DrillValidators.getInputValue(thirdBlock, 'Y', allBlocks)) === '-60';
                    }
                },
                {
                    id: 15,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nxざひょうを 30 ふやそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstBlock = allBlocks[first.blockId];
                        if (String(DrillValidators.getInputValue(firstBlock, 'X', allBlocks)) !== '120' ||
                            String(DrillValidators.getInputValue(firstBlock, 'Y', allBlocks)) !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                        if (third.opcode !== 'motion_changexby') return false;
                        return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DX', allBlocks)) === '30';
                    }
                },
                {
                    id: 16,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nyざひょうを 40 へらそう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstBlock = allBlocks[first.blockId];
                        if (String(DrillValidators.getInputValue(firstBlock, 'X', allBlocks)) !== '120' ||
                            String(DrillValidators.getInputValue(firstBlock, 'Y', allBlocks)) !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                        if (third.opcode !== 'motion_changeyby') return false;
                        return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DY', allBlocks)) === '-40';
                    }
                },
                {
                    id: 17,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nみぎに 80 うごこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstBlock = allBlocks[first.blockId];
                        if (String(DrillValidators.getInputValue(firstBlock, 'X', allBlocks)) !== '120' ||
                            String(DrillValidators.getInputValue(firstBlock, 'Y', allBlocks)) !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                        if (third.opcode !== 'motion_changexby') return false;
                        return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DX', allBlocks)) === '80';
                    }
                },
                {
                    id: 18,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nひだりに 80 うごこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstBlock = allBlocks[first.blockId];
                        if (String(DrillValidators.getInputValue(firstBlock, 'X', allBlocks)) !== '120' ||
                            String(DrillValidators.getInputValue(firstBlock, 'Y', allBlocks)) !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                        if (third.opcode !== 'motion_changexby') return false;
                        return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DX', allBlocks)) === '-80';
                    }
                },
                {
                    id: 19,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nうえに 40 うごこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstBlock = allBlocks[first.blockId];
                        if (String(DrillValidators.getInputValue(firstBlock, 'X', allBlocks)) !== '120' ||
                            String(DrillValidators.getInputValue(firstBlock, 'Y', allBlocks)) !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                        if (third.opcode !== 'motion_changeyby') return false;
                        return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DY', allBlocks)) === '40';
                    }
                },
                {
                    id: 20,
                    title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nしたに 100 うごこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;
                        const [first, second, third] = userSequence;

                        if (first.opcode !== 'motion_gotoxy') return false;
                        const firstBlock = allBlocks[first.blockId];
                        if (String(DrillValidators.getInputValue(firstBlock, 'X', allBlocks)) !== '120' ||
                            String(DrillValidators.getInputValue(firstBlock, 'Y', allBlocks)) !== '60') return false;

                        if (second.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                        if (third.opcode !== 'motion_changeyby') return false;
                        return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DY', allBlocks)) === '-100';
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
                        return String(DrillValidators.getInputValue(innerBlock, 'STEPS', allBlocks)) === '5';
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
                        if (String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                        // 5歩動く
                        return String(DrillValidators.getInputValue(moveBlock, 'STEPS', allBlocks)) === '5';
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

                        return DrillValidators.checkRepeatChangeCoord(
                            allBlocks[first.blockId], allBlocks, 'y', 20, 5
                        );
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

                        if (String(DrillValidators.getInputValue(repeatBlock, 'TIMES', allBlocks)) !== '5') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(repeatBlock, allBlocks);
                        if (innerBlocks.length !== 2) return false;

                        // 順不同
                        const waitBlock = innerBlocks.find(b => b.opcode === 'control_wait');
                        const changeYBlock = innerBlocks.find(b => b.opcode === 'motion_changeyby');
                        if (!waitBlock || !changeYBlock) return false;

                        // 1秒
                        if (String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                        // y座標 +20
                        return String(DrillValidators.getInputValue(changeYBlock, 'DY', allBlocks)) === '20';
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

                        if (String(DrillValidators.getInputValue(repeatBlock, 'TIMES', allBlocks)) !== '5') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(repeatBlock, allBlocks);
                        if (innerBlocks.length !== 2) return false;

                        // 順不同
                        const waitBlock = innerBlocks.find(b => b.opcode === 'control_wait');
                        const changeYBlock = innerBlocks.find(b => b.opcode === 'motion_changeyby');
                        if (!waitBlock || !changeYBlock) return false;

                        // 1秒
                        if (String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                        // y座標 20
                        if (String(DrillValidators.getInputValue(changeYBlock, 'DY', allBlocks)) !== '20') return false;

                        // パターンA: 「yざひょうを 0 にする」
                        if (second.opcode === 'motion_sety') {
                            const setyBlock = allBlocks[second.blockId];
                            return String(DrillValidators.getInputValue(setyBlock, 'Y', allBlocks)) === '0';
                        }

                        // パターンB: 「x: ◯ y: 0 にいく」 (y座標が0であれば正解)
                        if (second.opcode === 'motion_gotoxy') {
                            const gotoBlock = allBlocks[second.blockId];
                            return String(DrillValidators.getInputValue(gotoBlock, 'Y', allBlocks)) === '0';
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

                        if (DrillValidators.getInputValue(condBlock, 'KEY_OPTION', allBlocks) !== 'space') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(repeatBlock, allBlocks);
                        if (innerBlocks.length !== 1) return false;

                        const [inner] = innerBlocks;
                        if (inner.opcode !== 'motion_changexby') return false;

                        return String(DrillValidators.getInputValue(inner, 'DX', allBlocks)) === '-2';
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

                        if (DrillValidators.getInputValue(condBlock, 'TOUCHINGOBJECTMENU', allBlocks) !== '_edge_') return false;

                        const innerBlocks = DrillValidators.getInnerBlocks(repeatBlock, allBlocks);
                        if (innerBlocks.length !== 1) return false;

                        const [inner] = innerBlocks;
                        if (inner.opcode !== 'motion_changexby') return false;

                        if (String(DrillValidators.getInputValue(inner, 'DX', allBlocks)) !== '-2') return false;

                        // パターンA: 「x: 0 y: 0 にいく」
                        if (second.opcode === 'motion_gotoxy') {
                            const gotoBlock = allBlocks[second.blockId];
                            return String(DrillValidators.getInputValue(gotoBlock, 'X', allBlocks)) === '0' &&
                                String(DrillValidators.getInputValue(gotoBlock, 'Y', allBlocks)) === '0';
                        }

                        // パターンB: 「xざひょうを 0 にする」
                        if (second.opcode === 'motion_setx') {
                            const setxBlock = allBlocks[second.blockId];
                            return String(DrillValidators.getInputValue(setxBlock, 'X', allBlocks)) === '0';
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
                        if (String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

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
                    title: '「ずっと」をつかって、\nスペースキーをおしたら おおきさが 1ずつ ふえて\nおさなかったら おおきさが 1ずつ へる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                        if (inner.length !== 1) return false;

                        return DrillValidators.checkIfElseKeyPressedChangeSize(inner[0], allBlocks, 'space');
                    }
                },
                {
                    id: 39,
                    title: '「ずっと」をつかって、\n15ど まわしながら、\nスペースキーをおしたら おおきさが 1ずつ ふえて\nおさなかったら おおきさが 1ずつ へる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;
                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                        if (inner.length !== 2) return false;

                        // 順不同
                        const hasTurn = inner.some(b => DrillValidators.checkTurn(b, allBlocks, 15));
                        const hasChangeSize = inner.some(b => DrillValidators.checkIfElseKeyPressedChangeSize(b, allBlocks, 'space'));

                        return hasTurn && hasChangeSize;
                    }
                },
                {
                    id: 40,
                    title: '「ずっと」をつかって、\nスペースキーをおしたら おおきさが 1ずつ ふえて\nおさなかったら おおきさが 1ずつ へる。\nスペースキーを おしながら みぎむきやじるしキーも おしたら\nメッセージ「かくだい」を おくる',
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

                        if (DrillValidators.getInputValue(spaceCondBlock, 'KEY_OPTION', allBlocks) !== 'space') return false;

                        // 2. でなければ（SUBSTACK2）: おおきさを -1 ずつかえる 1個
                        const elseBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK2');
                        if (elseBlocks.length !== 1 || elseBlocks[0]?.opcode !== 'looks_changesizeby') return false;
                        if (String(DrillValidators.getInputValue(elseBlocks[0], 'CHANGE', allBlocks)) !== '-1') return false;

                        // 3. もし（SUBSTACK）: おおきさを 1 ずつかえる ＋ もし右向き矢印キーなら の計2個
                        const thenBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK');
                        if (thenBlocks.length !== 2) return false;

                        // 3-1. おおきさを 1 ずつかえる
                        const changeSizeBlock = thenBlocks.find(b => b.opcode === 'looks_changesizeby');
                        if (!changeSizeBlock) return false;
                        if (String(DrillValidators.getInputValue(changeSizeBlock, 'CHANGE', allBlocks)) !== '1') return false;

                        // 3-2. 右向き矢印キーの「もし」ブロック
                        const rightIfBlock = thenBlocks.find(b => b.opcode === 'control_if');
                        if (!rightIfBlock || !rightIfBlock.inputs) return false;

                        // 4. 内側の「もし右向き矢印キーがおされたなら」の判定
                        const rightCondId = rightIfBlock.inputs.CONDITION?.block;
                        const rightCondBlock = allBlocks[rightCondId];
                        if (!rightCondBlock || rightCondBlock.opcode !== 'sensing_keypressed' || !rightCondBlock.inputs) return false;

                        if (DrillValidators.getInputValue(rightCondBlock, 'KEY_OPTION', allBlocks) !== 'right arrow') return false;

                        // 5. 内側の「メッセージ『かくだい』をおくる」の判定
                        const rightInner = DrillValidators.getInnerBlocks(rightIfBlock, allBlocks, 'SUBSTACK');
                        if (rightInner.length !== 1) return false;

                        const broadcastBlock = rightInner[0];
                        if (broadcastBlock?.opcode !== 'event_broadcast') return false;

                        return DrillValidators.getBroadcastMessage(broadcastBlock, allBlocks) === 'かくだい';
                    }
                },
                {
                    id: 41,
                    title: 'まず どこかのばしょへ いって、\nxざひょうが 100よりも おおきかったら\nおおきさを 50%にして、\nでなければ おおきさを 100%にする。\n※なんども ためしに うごかしてみよう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;

                        const gotoBlock = allBlocks[userSequence[0].blockId];
                        if (gotoBlock?.opcode !== 'motion_goto' || !gotoBlock.inputs) return false;
                        if (DrillValidators.getInputValue(gotoBlock, 'TO', allBlocks) !== '_random_') return false;

                        const ifElseBlock = allBlocks[userSequence[1].blockId];
                        if (ifElseBlock?.opcode !== 'control_if_else' || !ifElseBlock.inputs) return false;

                        const condBlock = allBlocks[ifElseBlock.inputs.CONDITION?.block];
                        if (!DrillValidators.checkComparison(condBlock, allBlocks, 'motion_xposition', 'gt', 100)) return false;

                        const thenBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK');
                        if (thenBlocks.length !== 1 || thenBlocks[0]?.opcode !== 'looks_setsizeto') return false;
                        if (String(DrillValidators.getInputValue(thenBlocks[0], 'SIZE', allBlocks)) !== '50') return false;

                        const elseBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK2');
                        if (elseBlocks.length !== 1 || elseBlocks[0]?.opcode !== 'looks_setsizeto') return false;
                        if (String(DrillValidators.getInputValue(elseBlocks[0], 'SIZE', allBlocks)) !== '100') return false;

                        return true;
                    }
                },
                {
                    id: 42,
                    title: 'まず どこかのばしょへ いって、\nxざひょうが 100よりも おおきいか\nyざひょうが 100よりも おおきいかの どちらかだったら\nおおきさを 50%にして、\nでなければ おおきさを 100%にする。\n※なんども ためしに うごかしてみよう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;

                        // 1. どこかのばしょへいく
                        const gotoBlock = allBlocks[userSequence[0].blockId];
                        if (gotoBlock?.opcode !== 'motion_goto' || !gotoBlock.inputs) return false;
                        if (DrillValidators.getInputValue(gotoBlock, 'TO', allBlocks) !== '_random_') return false;

                        // 2. もし〜でなければ
                        const ifElseBlock = allBlocks[userSequence[1].blockId];
                        if (ifElseBlock?.opcode !== 'control_if_else' || !ifElseBlock.inputs) return false;

                        // 2-1. 条件式（「xざひょう > 100」 または 「yざひょう > 100」）
                        const orBlock = allBlocks[ifElseBlock.inputs.CONDITION?.block];
                        if (orBlock?.opcode !== 'operator_or' || !orBlock.inputs) return false;

                        const leftCond = allBlocks[orBlock.inputs.OPERAND1?.block];
                        const rightCond = allBlocks[orBlock.inputs.OPERAND2?.block];

                        const isXGt100 = (b) => DrillValidators.checkComparison(b, allBlocks, 'motion_xposition', 'gt', 100);
                        const isYGt100 = (b) => DrillValidators.checkComparison(b, allBlocks, 'motion_yposition', 'gt', 100);

                        const hasXOrY = (isXGt100(leftCond) && isYGt100(rightCond)) ||
                                    (isYGt100(leftCond) && isXGt100(rightCond));
                        if (!hasXOrY) return false;

                        // 2-2. もし: おおきさを 50%にする
                        const thenBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK');
                        if (thenBlocks.length !== 1 || thenBlocks[0]?.opcode !== 'looks_setsizeto') return false;
                        if (String(DrillValidators.getInputValue(thenBlocks[0], 'SIZE', allBlocks)) !== '50') return false;

                        // 2-3. でなければ: おおきさを 100%にする
                        const elseBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK2');
                        if (elseBlocks.length !== 1 || elseBlocks[0]?.opcode !== 'looks_setsizeto') return false;
                        if (String(DrillValidators.getInputValue(elseBlocks[0], 'SIZE', allBlocks)) !== '100') return false;

                        return true;
                    }
                },
                {
                    id: 43,
                    title: 'yざひょうを ずっと 5 ふやしつづける。\nyざひょうが 100に なったときに\n1びょう とまる',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;

                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 2) return false;
                        
                        // 1. yざひょうを 5 ふやす
                        const changeYBlock = inner.find(b => b.opcode === 'motion_changeyby');
                        if (!changeYBlock) return false;
                        if (String(DrillValidators.getInputValue(changeYBlock, 'DY', allBlocks)) !== '5') return false;
                    
                        // 2. もし（yざひょう = 100）なら
                        const ifBlock = inner.find(b => b.opcode === 'control_if');
                        if (!ifBlock || !ifBlock.inputs) return false;
                        
                        const condBlock = allBlocks[ifBlock.inputs.CONDITION?.block];
                        if (!DrillValidators.checkComparison(condBlock, allBlocks, 'motion_yposition', 'eq', 100)) return false;
                    
                        // 3. 内側の「1びょうとまる」
                        const ifInner = DrillValidators.getInnerBlocks(ifBlock, allBlocks, 'SUBSTACK');
                        if (ifInner.length !== 1 || ifInner[0]?.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(ifInner[0], 'DURATION', allBlocks)) !== '1') return false;

                        return true;
                    }
                },
                {
                    id: 44,
                    title: 'かいてんほうほうを さゆうのみに してから\nずっと 5ほ うごきつづけて、\nはしに ついたら はねかえる。\nxざひょうが 100よりも おおきいときに\nおおきさを 50%にして、\nそうではないときに おおきさを 100%にする',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;

                        // 1. かいてんほうほうを さゆうのみにする
                        const styleBlock = allBlocks[userSequence[0].blockId];
                        if (styleBlock?.opcode !== 'motion_setrotationstyle') return false;
                        if (styleBlock.fields?.STYLE?.value !== 'left-right') return false;

                        // 2. ずっと
                        const foreverBlock = allBlocks[userSequence[1].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 3) return false;

                        // 2-1. 5ほ うごく
                        const moveBlock = inner.find(b => b.opcode === 'motion_movesteps');
                        if (!moveBlock) return false;
                        if (String(DrillValidators.getInputValue(moveBlock, 'STEPS', allBlocks)) !== '5') return false;

                        // 2-2. はしに ついたら はねかえる
                        const bounceBlock = inner.find(b => b.opcode === 'motion_ifonedgebounce');
                        if (!bounceBlock) return false;

                        // 2-3. もし（xざひょう > 100）なら
                        const ifElseBlock = inner.find(b => b.opcode === 'control_if_else');
                        if (!ifElseBlock || !ifElseBlock.inputs) return false;

                        const condBlock = allBlocks[ifElseBlock.inputs.CONDITION?.block];
                        if (!DrillValidators.checkComparison(condBlock, allBlocks, 'motion_xposition', 'gt', 100)) return false;

                        const thenBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK');
                        if (thenBlocks.length !== 1 || thenBlocks[0]?.opcode !== 'looks_setsizeto') return false;
                        if (String(DrillValidators.getInputValue(thenBlocks[0], 'SIZE', allBlocks)) !== '50') return false;

                        const elseBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK2');
                        if (elseBlocks.length !== 1 || elseBlocks[0]?.opcode !== 'looks_setsizeto') return false;
                        if (String(DrillValidators.getInputValue(elseBlocks[0], 'SIZE', allBlocks)) !== '100') return false;

                        return true;
                    }
                },
                {
                    id: 45,
                    title: 'かいてんほうほうを さゆうのみに してから\nずっと 5ほ うごきつづけて、\nはしに ついたら はねかえる。\nxざひょうが 100から150 のときに\nおおきさを 50%にして、\nそうではないときに おおきさを 100%にする',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;

                        // 1. かいてんほうほうを さゆうのみにする
                        const styleBlock = allBlocks[userSequence[0].blockId];
                        if (styleBlock?.opcode !== 'motion_setrotationstyle') return false;
                        if (styleBlock.fields?.STYLE?.value !== 'left-right') return false;

                        // 2. ずっと
                        const foreverBlock = allBlocks[userSequence[1].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 3) return false;

                        // 2-1. 5ほ うごく
                        const moveBlock = inner.find(b => b.opcode === 'motion_movesteps');
                        if (!moveBlock) return false;
                        if (String(DrillValidators.getInputValue(moveBlock, 'STEPS', allBlocks)) !== '5') return false;

                        // 2-2. はしに ついたら はねかえる
                        const bounceBlock = inner.find(b => b.opcode === 'motion_ifonedgebounce');
                        if (!bounceBlock) return false;

                        // 2-3. もし（xざひょう > 100 かつ xざひょう < 150）なら
                        const ifElseBlock = inner.find(b => b.opcode === 'control_if_else');
                        if (!ifElseBlock || !ifElseBlock.inputs) return false;

                        const andBlock = allBlocks[ifElseBlock.inputs.CONDITION?.block];
                        if (andBlock?.opcode !== 'operator_and' || !andBlock.inputs) return false;

                        const op1Block = allBlocks[andBlock.inputs.OPERAND1?.block];
                        const op2Block = allBlocks[andBlock.inputs.OPERAND2?.block];

                        const checkGt100 = (b) => DrillValidators.checkComparison(b, allBlocks, 'motion_xposition', 'gt', 100);
                        const checkLt150 = (b) => DrillValidators.checkComparison(b, allBlocks, 'motion_xposition', 'lt', 150);

                        const isValidCond = (checkGt100(op1Block) && checkLt150(op2Block)) ||
                                            (checkLt150(op1Block) && checkGt100(op2Block));
                        if (!isValidCond) return false;

                        const thenBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK');
                        if (thenBlocks.length !== 1 || thenBlocks[0]?.opcode !== 'looks_setsizeto') return false;
                        if (String(DrillValidators.getInputValue(thenBlocks[0], 'SIZE', allBlocks)) !== '50') return false;

                        const elseBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK2');
                        if (elseBlocks.length !== 1 || elseBlocks[0]?.opcode !== 'looks_setsizeto') return false;
                        if (String(DrillValidators.getInputValue(elseBlocks[0], 'SIZE', allBlocks)) !== '100') return false;

                        return true;
                    }
                },
                {
                    id: 46,
                    title: 'まず へんすう「のこりじかん」を 15にして、\n1びょう ごとに 1へらす ことを\n15かい くりかえす',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;

                        // 1. 「のこりじかん」を 15 にする
                        const setVarBlock = allBlocks[userSequence[0].blockId];
                        if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 15)) return false;

                        // 2. 15回くりかえす
                        const repeatBlock = allBlocks[userSequence[1].blockId];
                        if (repeatBlock?.opcode !== 'control_repeat') return false;
                        if (String(DrillValidators.getInputValue(repeatBlock, 'TIMES', allBlocks)) !== '15') return false;

                        // 中身: 「1秒まつ」と「『のこりじかん』を -1 変える」（順不同OK）
                        const inner = DrillValidators.getInnerBlocks(repeatBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 2) return false;

                        const waitBlock = inner.find(b => b.opcode === 'control_wait');
                        if (!waitBlock || String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                        const changeVarBlock = inner.find(b => b.opcode === 'data_changevariableby');
                        return DrillValidators.checkVariable(changeVarBlock, allBlocks, 'data_changevariableby', 'のこりじかん', -1);
                    }
                },
                {
                    id: 47,
                    title: 'まず へんすう「のこりじかん」を 10にして、\n1びょう ごとに 1へらす ことを\n15かい くりかえす。\n※へんすうが マイナスに なっちゃうかも！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;

                        // 1. 「のこりじかん」を 10 にする
                        const setVarBlock = allBlocks[userSequence[0].blockId];
                        if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 10)) return false;

                        // 2. 15回くりかえす
                        const repeatBlock = allBlocks[userSequence[1].blockId];
                        if (repeatBlock?.opcode !== 'control_repeat') return false;
                        if (String(DrillValidators.getInputValue(repeatBlock, 'TIMES', allBlocks)) !== '15') return false;

                        // 中身: 「1秒まつ」と「『のこりじかん』を -1 変える」（順不同OK）
                        const inner = DrillValidators.getInnerBlocks(repeatBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 2) return false;

                        const waitBlock = inner.find(b => b.opcode === 'control_wait');
                        if (!waitBlock || String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                        const changeVarBlock = inner.find(b => b.opcode === 'data_changevariableby');
                        return DrillValidators.checkVariable(changeVarBlock, allBlocks, 'data_changevariableby', 'のこりじかん', -1);
                    }
                },
                {
                    id: 48,
                    title: 'まず へんすう「のこりじかん」を 10にして、\n「のこりじかん」が 0に なるまで\n1びょう ごとに 1へらす ことを くりかえす',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;

                        // 1. 「のこりじかん」を 10 にする
                        const setVarBlock = allBlocks[userSequence[0].blockId];
                        if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 10)) return false;

                        // 2. 「のこりじかん」= 0 になるまでくりかえす
                        const repeatUntilBlock = allBlocks[userSequence[1].blockId];
                        if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                        const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                        if (!DrillValidators.checkComparison(condBlock, allBlocks, 'data_variable', 'eq', 0)) return false;

                        // 中身: 「1秒まつ」と「『のこりじかん』を -1 変える」（順不同OK）
                        const inner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 2) return false;

                        const waitBlock = inner.find(b => b.opcode === 'control_wait');
                        if (!waitBlock || String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                        const changeVarBlock = inner.find(b => b.opcode === 'data_changevariableby');
                        return DrillValidators.checkVariable(changeVarBlock, allBlocks, 'data_changevariableby', 'のこりじかん', -1);
                    }
                },
                {
                    id: 49,
                    title: 'まず へんすう「のこりじかん」を 10にして、\n「のこりじかん」が 0に なるまで\n1びょう ごとに 1へらす ことを くりかえし、\n0に なったら\nメッセージ「１かいてん」を おくる。\n※「もし」は つかわずに できるよ！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;

                        // 1. 「のこりじかん」を 10 にする
                        const setVarBlock = allBlocks[userSequence[0].blockId];
                        if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 10)) return false;

                        // 2. 「のこりじかん」= 0 になるまでくりかえす
                        const repeatUntilBlock = allBlocks[userSequence[1].blockId];
                        if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                        const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                        if (!DrillValidators.checkComparison(condBlock, allBlocks, 'data_variable', 'eq', 0)) return false;

                        const inner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 2) return false;

                        const waitBlock = inner.find(b => b.opcode === 'control_wait');
                        if (!waitBlock || String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                        const changeVarBlock = inner.find(b => b.opcode === 'data_changevariableby');
                        if (!DrillValidators.checkVariable(changeVarBlock, allBlocks, 'data_changevariableby', 'のこりじかん', -1)) return false;

                        // 3. ループ終了直後に メッセージ「１かいてん」を送る
                        const broadcastBlock = allBlocks[userSequence[2].blockId];
                        if (broadcastBlock?.opcode !== 'event_broadcast') return false;

                        return DrillValidators.getBroadcastMessage(broadcastBlock, allBlocks) === '１かいてん';
                    }
                },
                {
                    id: 50,
                    title: 'まず へんすう「のこりじかん」を 10にして、\n「のこりじかん」が 0に なるまで\n1びょう ごとに 1へらす ことを くりかえす。\n3に なったときに\nメッセージ「かくだい」を おくり、\n0に なったら\nメッセージ「１かいてん」を おくる。\n※「もし」は 1つだけ つかうよ！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 3) return false;

                        // 1. 「のこりじかん」を 10 にする
                        const setVarBlock = allBlocks[userSequence[0].blockId];
                        if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 10)) return false;

                        // 2. 「のこりじかん」= 0 になるまでくりかえす
                        const repeatUntilBlock = allBlocks[userSequence[1].blockId];
                        if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                        const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                        if (!DrillValidators.checkComparison(condBlock, allBlocks, 'data_variable', 'eq', 0)) return false;

                        // 中身: 「1秒まつ」「-1減らす」「もし『のこりじかん』= 3 なら メッセージ『かくだい』を送る」の 3ブロック
                        const inner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 3) return false;

                        const waitBlock = inner.find(b => b.opcode === 'control_wait');
                        if (!waitBlock || String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                        const changeVarBlock = inner.find(b => b.opcode === 'data_changevariableby');
                        if (!DrillValidators.checkVariable(changeVarBlock, allBlocks, 'data_changevariableby', 'のこりじかん', -1)) return false;

                        // もし「のこりじかん」= 3 なら
                        const ifBlock = inner.find(b => b.opcode === 'control_if');
                        if (!ifBlock || !ifBlock.inputs) return false;

                        const ifCondBlock = allBlocks[ifBlock.inputs.CONDITION?.block];
                        if (!DrillValidators.checkComparison(ifCondBlock, allBlocks, 'data_variable', 'eq', 3)) return false;

                        const ifInner = DrillValidators.getInnerBlocks(ifBlock, allBlocks, 'SUBSTACK');
                        if (ifInner.length !== 1 || ifInner[0]?.opcode !== 'event_broadcast') return false;
                        if (DrillValidators.getBroadcastMessage(ifInner[0], allBlocks) !== 'かくだい') return false;

                        // 3. ループ終了直後に メッセージ「１かいてん」を送る
                        const broadcastBlock = allBlocks[userSequence[2].blockId];
                        if (broadcastBlock?.opcode !== 'event_broadcast') return false;

                        return DrillValidators.getBroadcastMessage(broadcastBlock, allBlocks) === '１かいてん';
                    }
                },
                {
                    id: 51,
                    title: 'へんすう「ランダム」を\n0から1までの らんすうに して、\nもし「ランダム」が 0だったら かくして、\nでなければ ひょうじする。\n※なんども ためしに うごかしてみよう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 2) return false;

                        // 1. 変数「ランダム」を 0から1の乱数にする
                        const setVarBlock = allBlocks[userSequence[0].blockId];
                        if (!DrillValidators.checkSetVariableToRandom(setVarBlock, allBlocks, 'ランダム', 0, 1)) return false;

                        // 2. もし〜でなければ
                        const ifElseBlock = allBlocks[userSequence[1].blockId];
                        if (ifElseBlock?.opcode !== 'control_if_else' || !ifElseBlock.inputs) return false;

                        // 2-1. 条件式（「ランダム」= 0）
                        const condBlock = allBlocks[ifElseBlock.inputs.CONDITION?.block];
                        if (!DrillValidators.checkComparison(condBlock, allBlocks, 'data_variable', 'eq', 0)) return false;

                        // 2-2. もし: かくす 1個
                        const thenBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK');
                        if (thenBlocks.length !== 1 || thenBlocks[0]?.opcode !== 'looks_hide') return false;

                        // 2-3. でなければ: ひょうじする 1個
                        const elseBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK2');
                        if (elseBlocks.length !== 1 || elseBlocks[0]?.opcode !== 'looks_show') return false;

                        return true;
                    }
                },
                {
                    id: 52,
                    title: 'ずっと 1びょうごとに\nへんすう「ランダム」を\n0から1までの らんすうに して、\nもし「ランダム」が 0だったら かくして、\nでなければ ひょうじする。\n※「1びょうまつ」は さいごに かこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;

                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 3) return false;
                        const [randBlock, ifElseBlock, waitBlock] = inner;

                        if (!DrillValidators.checkSetVariableToRandom(randBlock, allBlocks, 'ランダム', 0, 1)) return false;

                        if (ifElseBlock?.opcode !== 'control_if_else' || !ifElseBlock.inputs) return false;

                        const condBlock = allBlocks[ifElseBlock.inputs.CONDITION?.block];
                        if (!DrillValidators.checkComparison(condBlock, allBlocks, 'data_variable', 'eq', 0)) return false;

                        const thenBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK');
                        if (thenBlocks.length !== 1 || thenBlocks[0]?.opcode !== 'looks_hide') return false;

                        const elseBlocks = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK2');
                        if (elseBlocks.length !== 1 || elseBlocks[0]?.opcode !== 'looks_show') return false;

                        if (waitBlock?.opcode !== 'control_wait') return false;
                        return String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) === '1';
                    }
                },
                {
                    id: 53,
                    title: 'ずっと xざひょうを 2 ふやしながら、\nへんすう「ランダム」を\n-10から10までの らんすうに して、\nyざひょうを「ランダム」のかずに する',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;

                        const foreverBlock = allBlocks[userSequence[0].blockId];
                        if (foreverBlock?.opcode !== 'control_forever') return false;

                        const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 3) return false;

                        // 1. xざひょうを 2 ふやす
                        const changeXBlock = inner.find(b => b.opcode === 'motion_changexby');
                        if (!changeXBlock) return false;
                        if (String(DrillValidators.getInputValue(changeXBlock, 'DX', allBlocks)) !== '2') return false;

                        // 2. 変数「ランダム」を -10から10までの乱数にする
                        const setVarBlock = inner.find(b => b.opcode === 'data_setvariableto');
                        if (!setVarBlock || !DrillValidators.checkSetVariableToRandom(setVarBlock, allBlocks, 'ランダム', -10, 10)) return false;

                        // 3. yざひょうを「ランダム」のかずにする
                        const setYBlock = inner.find(b => b.opcode === 'motion_sety');
                        if (!setYBlock || !setYBlock.inputs) return false;

                        const yValBlock = allBlocks[setYBlock.inputs.Y?.block];
                        if (yValBlock?.opcode !== 'data_variable' || !yValBlock.fields) return false;
                        const varField = yValBlock.fields.VARIABLE;
                        if (!varField || (varField.value !== 'ランダム' && varField.id !== 'ランダム')) return false;

                        return;
                    }
                },
                {
                    id: 54,
                    title: '1びょうごとに\nへんすう「ランダム」を\n0から30までの らんすうに して\nxざひょうを「ランダム」のかずだけ ふやすことを、\nはしに つくまで くりかえす。\n※「1びょうまつ」は さいごに かこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;

                        const repeatUntilBlock = allBlocks[userSequence[0].blockId];
                        if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                        // 端に触れたか判定
                        const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                        if (condBlock?.opcode !== 'sensing_touchingobject' || !condBlock.inputs) return false;
                        const menuBlock = allBlocks[condBlock.inputs.TOUCHINGOBJECTMENU?.block];
                        if (menuBlock?.fields?.TOUCHINGOBJECTMENU?.value !== '_edge_') return false;

                        const inner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 3) return false;
                        const [randBlock, changeXBlock, waitBlock] = inner;

                        // 1. 変数「ランダム」を 0から30の乱数にする
                        if (!DrillValidators.checkSetVariableToRandom(randBlock, allBlocks, 'ランダム', 0, 30)) return false;

                        // 2. xざひょうを「ランダム」ずつ変える
                        if (changeXBlock?.opcode !== 'motion_changexby' || !changeXBlock.inputs) return false;
                        const dxBlock = allBlocks[changeXBlock.inputs.DX?.block];
                        if (dxBlock?.opcode !== 'data_variable') return false;
                        const varName = dxBlock.fields?.VARIABLE?.value || dxBlock.fields?.VARIABLE?.id;
                        if (varName !== 'ランダム') return false;

                        // 3. 1秒まつ（最後）
                        if (waitBlock?.opcode !== 'control_wait') return false;
                        return String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) === '1';
                    }
                },
                {
                    id: 55,
                    title: '1びょうごとに\nへんすう「ランダム」を\n-10から30までの らんすうに して\nxざひょうを「ランダム」のかずだけ ふやすことを、\nはしに つくまで くりかえす。\n「ランダム」が 0より ちいさいときは 15ど まわす。\n※「1びょうまつ」は さいごに かこう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length !== 1) return false;

                        const repeatUntilBlock = allBlocks[userSequence[0].blockId];
                        if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                        // 端に触れたか判定
                        const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                        if (condBlock?.opcode !== 'sensing_touchingobject' || !condBlock.inputs) return false;
                        const menuBlock = allBlocks[condBlock.inputs.TOUCHINGOBJECTMENU?.block];
                        if (menuBlock?.fields?.TOUCHINGOBJECTMENU?.value !== '_edge_') return false;

                        const inner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                        if (inner.length !== 4) return false;

                        // 1. 変数「ランダム」を -10から30の乱数にする（最初）
                        if (!DrillValidators.checkSetVariableToRandom(inner[0], allBlocks, 'ランダム', -10, 30)) return false;

                        // 4. 1秒まつ（最後）
                        const waitBlock = inner[3];
                        if (waitBlock?.opcode !== 'control_wait') return false;
                        if (String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                        // 2と3: 中間の2つ（x座標変更 & もし「ランダム」< 0）
                        const middleBlocks = [inner[1], inner[2]];

                        const changeXBlock = middleBlocks.find(b => b?.opcode === 'motion_changexby');
                        if (!changeXBlock || !changeXBlock.inputs) return false;
                        const dxBlock = allBlocks[changeXBlock.inputs.DX?.block];
                        if (dxBlock?.opcode !== 'data_variable') return false;
                        const varName = dxBlock.fields?.VARIABLE?.value || dxBlock.fields?.VARIABLE?.id;
                        if (varName !== 'ランダム') return false;

                        const ifBlock = middleBlocks.find(b => b?.opcode === 'control_if');
                        if (!ifBlock || !ifBlock.inputs) return false;

                        const ifCondBlock = allBlocks[ifBlock.inputs.CONDITION?.block];
                        if (!DrillValidators.checkComparison(ifCondBlock, allBlocks, 'data_variable', 'lt', 0)) return false;

                        const ifInner = DrillValidators.getInnerBlocks(ifBlock, allBlocks, 'SUBSTACK');
                        if (ifInner.length !== 1) return false;

                        return DrillValidators.checkTurn(ifInner[0], allBlocks, 15);
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

        // 変数名（文字列）を指定して、その値を変更する関数
        setVariableValueByName(varName, value) {
            const stage = this.runtime.getTargetForStage();
            if (stage && stage.variables) {
                for (const id in stage.variables) {
                    if (stage.variables[id].name === varName) {
                        stage.variables[id].value = value;
                        break;
                    }
                }
            }
        }

        // 変数名（文字列）を指定して、画面上の表示/非表示を切り替える関数
        setVariableVisible(varName, visible) {
            const stage = this.runtime.getTargetForStage();
            if (!stage || !stage.variables) return;
            
            for (const id in stage.variables) {
                if (stage.variables[id].name === varName) {
                    this.runtime.requestUpdateMonitor(new Map([
                        ['id', id],
                        ['visible', visible]
                    ]));
                    console.log("Visibility of variable '", varName, "' was set ", visible);
                    break;
                }
            }
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
                this.runtime.emit('SAY', cat, 'say', '');
            }
            if (playButton) {
                playButton.setXY(-130, 150);
                playButton.setDirection(90);
                playButton.setSize(100);
                playButton.setVisible(true);  
                playButton.setCostume(0);
            }
            if (judge) {
                judge.setXY(180, -140);
                judge.setDirection(90);
                judge.setSize(30);
                judge.setVisible(true);  
                judge.setCostume(0);
            }
            if (post) {
                post.setXY(-190, -140);
                post.setDirection(90);
                post.setSize(25);
                post.setVisible(true);  
                post.setCostume(0);
            }
            this.setVariableValueByName('のこりじかん', -1);
            this.setVariableVisible('のこりじかん', false);
            this.setVariableValueByName('ランダム', -1);
            this.setVariableVisible('ランダム', false);
            this.setVariableValueByName('アルファベット', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
            this.setVariableVisible('アルファベット', false);
        }

        testRun (args, util) {
            const { cat, playButton } = this.getTargets();
            const activePlayButton = playButton || util.target;
            
            if (cat) {
                // 1. スプライトと変数を初期化
                this.initializeSprites();

                // 2.1. 監視したい変数名を配列で指定
                const targetVars = ['のこりじかん', 'ランダム']; // 必要に応じて追加・変更
                const pendingVars = new Set(targetVars);

                // 2.2. 前回の変数監視タイマーが残っていればクリア
                if (this._varCheckInterval) {
                    clearInterval(this._varCheckInterval);
                }

                // 2.3. 100msごとに変数を監視（VMのステップ状態に依存しない）
                this._varCheckInterval = setInterval(() => {
                    pendingVars.forEach(varName => {
                        const val = this.getVariableValueByName(varName);
                        console.log(`Now ${varName} is `, val);

                        // 初期値(-1)以外に変更されたら表示し、監視対象から外す
                        if (val !== null && val !== -1 && val !== '-1') {
                            this.setVariableVisible(varName, true);
                            pendingVars.delete(varName);
                        }
                    });

                    // すべての変数が変更・表示されたら監視終了
                    if (pendingVars.size === 0) {
                        clearInterval(this._varCheckInterval);
                        this._varCheckInterval = null;
                    }
                }, 100);

                // 3. 掛け声演出とハットブロックの起動処理
                this.sayFromJudge('');
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
