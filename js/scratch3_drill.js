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

        // 繰り返し5歩動いて、もし端についたらはねかえる
        static checkMoveBounceLoop(loopBlockId, allBlocks) {
            const foreverBlock = allBlocks[loopBlockId];

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
            this.currentQuestionIndex = 0;

            // 1. URLパラメータの取得はロード時に勝手に行われる
            this.initFromQueryParams();

            // 2. すでにターゲット（ステージやスプライト）が読み込まれていれば即実行、まだならイベントを待つ
            const isAlreadyLoaded = this.runtime.targets && this.runtime.targets.length > 1;
            if (isAlreadyLoaded) {
                this.setupInitialQuestion();
            } else {
                this.runtime.once('PROJECT_LOADED', () => {
                    this.setupInitialQuestion();
                });
            }

            // 問題リストの定義
            this.questionObjects = [
                {
                    code: '1-1',
                    questions: [
                        {
                            id_old: 1,
                            title: 'ネコを 100ほ うごかそう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (mainSequence.length !== 1) return false;
                                if (subSequence.length !== 0) return false;
                                const [first] = mainSequence;
                                if (first.opcode !== 'motion_movesteps') return false;
                                return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) === '100';
                            }
                        },
                        {
                            id_old: 2,
                            title: 'ネコを 200ほ うごかそう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (mainSequence.length !== 1) return false;
                                if (subSequence.length !== 0) return false;
                                const [first] = mainSequence;
                                if (first.opcode !== 'motion_movesteps') return false;
                                return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) === '200';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'ネコを 100ほ うごかして、\n1びょう まってから\nもういちど 100ほ うごかそう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                // 3つのブロックが並んでいるかチェック
                                if (mainSequence.length !== 3) return false;
                                if (subSequence.length !== 0) return false;
                                const [first, second, third] = mainSequence;
                                
                                if (first.opcode !== 'motion_movesteps') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) !== '100') return false;

                                if (second.opcode !== 'control_wait') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                                if (third.opcode !== 'motion_movesteps') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[third.blockId], 'STEPS', allBlocks)) !== '100') return false;

                                return true;
                            }
                        },
                    ]  
                },
                {
                    code: '1-2',
                    questions: [
                        {
                            id_old: 3,
                            title: 'ネコを うしろに100ほ うごかそう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (mainSequence.length !== 1) return false;
                                if (subSequence.length !== 0) return false;
                                const [first] = mainSequence;
                                if (first.opcode !== 'motion_movesteps') return false;
                                return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) === '-100';
                            }
                        },
                        {
                            id_old: 4,
                            title: 'まえに100ほ うごかして、\n1びょう まってから\nうしろに50ほ うごかそう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                // 3つのブロックが並んでいるかチェック
                                if (mainSequence.length !== 3) return false;
                                if (subSequence.length !== 0) return false;
                                const [first, second, third] = mainSequence;
                                
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
                            id_old: 5,
                            title: 'まえに100ほ うごかして、\n1びょう まってから\nうしろに うごかそう！\nもとのばしょに もどってこよう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                // 3つのブロックが並んでいるかチェック
                                if (mainSequence.length !== 3) return false;
                                if (subSequence.length !== 0) return false;
                                const [first, second, third] = mainSequence;
                                
                                if (first.opcode !== 'motion_movesteps') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) !== '100') return false;

                                if (second.opcode !== 'control_wait') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                                if (third.opcode !== 'motion_movesteps') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[third.blockId], 'STEPS', allBlocks)) !== '-100') return false;

                                return true;
                            }
                        },
                    ]
                },
                {
                    code: '2-1',
                    questions: [
                        {
                            id_old: -1,
                            title: 'ネコの むきを\n180ど（した）に しよう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (mainSequence.length !== 1) return false;
                                if (subSequence.length !== 0) return false;
                                const [first] = mainSequence;
                                
                                if (first.opcode !== 'motion_pointindirection') return false;
                                return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DIRECTION', allBlocks)) === '180';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'ネコの むきを\n0ど（うえ）に しよう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;
                                
                                if (first.opcode !== 'motion_pointindirection') return false;
                                return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DIRECTION', allBlocks)) === '0';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'むきを0ど（うえ）に して、\n1びょう まってから\nむきを90ど（みぎ）に しよう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

                                if (first.opcode !== 'motion_pointindirection') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DIRECTION', allBlocks)) !== '0') return false;

                                if (second.opcode !== 'control_wait') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                                if (third.opcode !== 'motion_pointindirection') return false;
                                return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DIRECTION', allBlocks)) === '90';
                            }
                        }                        
                    ]
                },
                {
                    code: '2-2',
                    questions: [
                        {
                            id_old: -1,
                            title: 'むきを0ど（うえ）に して、\n1びょう まってから\nむきを-90ど（ひだり）に しよう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

                                if (first.opcode !== 'motion_pointindirection') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DIRECTION', allBlocks)) !== '0') return false;

                                if (second.opcode !== 'control_wait') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                                if (third.opcode !== 'motion_pointindirection') return false;
                                return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DIRECTION', allBlocks)) === '-90';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'むきを-90ど（ひだり）に して、\n1びょう まってから\nむきを90ど（みぎ）に しよう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

                                if (first.opcode !== 'motion_pointindirection') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DIRECTION', allBlocks)) !== '-90') return false;

                                if (second.opcode !== 'control_wait') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                                if (third.opcode !== 'motion_pointindirection') return false;
                                return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DIRECTION', allBlocks)) === '90';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'かいてんほうほうを さゆうのみに してから\nむきを-90ど（ひだり）に して、\n1びょう まってから\nむきを90ど（みぎ）に しよう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 4) return false;
                                const [first, second, third, fourth] = mainSequence;

                                if (first.opcode !== 'motion_setrotationstyle') return false;
                                const styleBlock = allBlocks[first.blockId];
                                if (styleBlock?.fields?.STYLE?.value !== 'left-right') return false;

                                if (second.opcode !== 'motion_pointindirection') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DIRECTION', allBlocks)) !== '-90') return false;

                                if (third.opcode !== 'control_wait') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DURATION', allBlocks)) !== '1') return false;

                                if (fourth.opcode !== 'motion_pointindirection') return false;
                                return String(DrillValidators.getInputValue(allBlocks[fourth.blockId], 'DIRECTION', allBlocks)) === '90';
                            }
                        }
                    ]
                },
                {
                    code: '2-3',
                    questions: [
                        {
                            id_old: 6,
                            title: 'ネコを みぎに15ど まわそう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;
                                
                                if (first.opcode == 'motion_turnright') {
                                    return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) === '15';
                                } else if (first.opcode == 'motion_turnleft') {
                                    return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) === '-15';
                                }
                                return false;
                            }
                        },
                        {
                            id_old: 9,
                            title: 'みぎに90ど まわして、\n1びょう まってから\nひだりに90ど まわそう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

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
                            id_old: -1,
                            title: 'みぎに45ど まわして、\n1びょう まってから\nむきを0ど（うえ）に しよう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

                                if (first.opcode == 'motion_turnright') {
                                    if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) !== '45') return false;
                                } else if (first.opcode == 'motion_turnleft') {
                                    if (String(DrillValidators.getInputValue(allBlocks[first.blockId], 'DEGREES', allBlocks)) !== '-45') return false;
                                }

                                if (second.opcode !== 'control_wait') return false;
                                if (String(DrillValidators.getInputValue(allBlocks[second.blockId], 'DURATION', allBlocks)) !== '1') return false;

                                if (third.opcode !== 'motion_pointindirection') return false;
                                return String(DrillValidators.getInputValue(allBlocks[third.blockId], 'DIRECTION', allBlocks)) === '0';
                            }
                        }
                    ]
                },
                {
                    code: '3-1',
                    questions: [
                        {
                            id_old: 11,
                            title: 'ネコの xざひょうを 100 にしよう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;
                                
                                if (first.opcode !== 'motion_setx') return false;
                                return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'X', allBlocks)) === '100';
                            }
                        },
                        {
                            id_old: 13,
                            title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いこう！\nぶひんは 1つだけで できるよ！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;
                                
                                if (first.opcode !== 'motion_gotoxy') return false;
                                const gotoBlock = allBlocks[first.blockId];
                                return String(DrillValidators.getInputValue(gotoBlock, 'X', allBlocks)) === '120' &&
                                    String(DrillValidators.getInputValue(gotoBlock, 'Y', allBlocks)) === '60';
                            }
                        },
                        {
                            id_old: 14,
                            title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nxざひょう: -120\nyざひょう: -60\nのばしょに いこう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                const [first, second, third] = mainSequence;

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
                        }
                    ]
                },
                {
                    code: '3-2',
                    questions: [
                        {
                            id_old: 15,
                            title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nxざひょうを 30 ふやそう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

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
                            id_old: 16,
                            title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nyざひょうを 40 へらそう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

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
                            id_old: 17,
                            title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nひだりに 80 うごこう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

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
                    ]
                },
                {
                    code: '3-3',
                    questions: [
                        {
                            id_old: 18,
                            title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nみぎに 80 うごこう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

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
                            id_old: 19,
                            title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nうえに 40 うごこう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

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
                            id_old: 20,
                            title: 'xざひょう: 120\nyざひょう: 60\nのばしょに いってから、\n1びょうごに\nしたに 100 うごこう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

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
                    ]
                },
                {
                    code: '4-1',
                    questions: [
                        {
                            id_old: 26,
                            title: 'yざひょうを 20ふやす ことを\n5かい くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;

                                return DrillValidators.checkRepeatChangeCoord(
                                    allBlocks[first.blockId], allBlocks, 'y', 20, 5
                                );
                            }
                        },
                        {
                            id_old: 27,
                            title: '1びょう ごとに\nyざひょうを 20ふやす ことを\n5かい くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;

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
                            id_old: 28,
                            title: '1びょう ごとに\nyざひょうを 20ふやす ことを\n5かい くりかえし、\nそのあとで yざひょうを 0にする',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;
                                const [first, second] = mainSequence;

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
                    ]
                },
                {
                    code: '4-2',
                    questions: [
                        {
                            id_old: 22,
                            title: 'ずっと 5ほ うごきつづける',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;

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
                            id_old: 23,
                            title: 'ずっと\n1びょう ごとに\n5ほ うごきつづける',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;

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
                            id_old: 25,
                            title: 'かいてんほうほうを さゆうのみに してから\nずっと 5ほ うごきつづけて、\nはしに ついたら はねかえる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;
                                const [first, second] = mainSequence;

                                if (first.opcode !== 'motion_setrotationstyle') return false;
                                const styleBlock = allBlocks[first.blockId];
                                if (styleBlock.fields.STYLE.value !== 'left-right') return false;

                                if (second.opcode !== 'control_forever') return false;
                                return DrillValidators.checkMoveBounceLoop(second.blockId, allBlocks);
                            }
                        }
                    ]
                },
                {
                    code: '4-3',
                    questions: [
                        {
                            id_old: 29,
                            title: 'xざひょうを 2へらす ことを\nスペースキーが おされるまで くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;

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
                            id_old: -1,
                            title: 'xざひょうを 2へらす ことを\nスペースキーが おされるまで くりかえし、\nそのあとで もとのばしょに もどる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;
                                const [first, second] = mainSequence;

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
                            id_old: 30,
                            title: 'xざひょうを 2へらす ことを\nはしに つくまで くりかえし、\nそのあとで もとのばしょに もどる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;
                                const [first, second] = mainSequence;

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
                    ]
                },
                {
                    code: '4-4',
                    questions: [
                        {
                            id_old: -1,
                            title: 'yざひょうを 10 へらすことを\n10かい くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;

                                return DrillValidators.checkRepeatChangeCoord(
                                    allBlocks[first.blockId], allBlocks, 'y', -10, 10
                                );
                            }
                        },
                        {
                            id_old: -1,
                            title: 'yざひょうを 10 へらすことを\n10かい くりかえし、\nそのあとで yざひょうを 0にする',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;
                                const [first, second] = mainSequence;

                                // 1. y座標を10減らす(-10)ことを10回繰り返す
                                if (!DrillValidators.checkRepeatChangeCoord(allBlocks[first.blockId], allBlocks, 'y', -10, 10)) return false;

                                // 2. y座標を 0 にする
                                const setYBlock = allBlocks[second.blockId];
                                if (setYBlock?.opcode !== 'motion_sety') return false;

                                return String(DrillValidators.getInputValue(setYBlock, 'Y', allBlocks)) === '0';
                            }
                        },
                        {
                            id_old: -1,
                            title: '10かい yざひょうを 10 へらし、\nそのあとで yざひょうを 0にすることを\nずっと くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const [first] = mainSequence;

                                // 1. ずっと ブロック
                                const foreverBlock = allBlocks[first.blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                // 「ずっと」の内側 (2個: 10回繰り返す -> y座標を0にする)
                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 2) return false;

                                // 1-1. y座標を10減らす(-10)ことを10回繰り返す
                                if (!DrillValidators.checkRepeatChangeCoord(inner[0], allBlocks, 'y', -10, 10)) return false;

                                // 1-2. y座標を 0 にする
                                const setYBlock = inner[1];
                                if (setYBlock?.opcode !== 'motion_sety') return false;

                                return String(DrillValidators.getInputValue(setYBlock, 'Y', allBlocks)) === '0';
                            }
                        }
                    ]
                },
                {
                    code: '5-1',
                    questions: [
                        {
                            id_old: -1,
                            title: 'ねこは うごかさず、まず\nメッセージ「かくだい」を おくり、\n1びょうごに\nメッセージ「１かいてん」を おくる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

                                // 1個目: メッセージ「かくだい」を送る
                                if (first.opcode !== 'event_broadcast') return false;
                                if (DrillValidators.getBroadcastMessage(allBlocks[first.blockId], allBlocks) !== 'かくだい') return false;

                                // 2個目: 1秒待つ
                                if (second.opcode !== 'control_wait') return false;
                                const waitBlock = allBlocks[second.blockId];
                                if (String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                                // 3個目: メッセージ「１かいてん」を送る
                                if (third.opcode !== 'event_broadcast') return false;
                                return DrillValidators.getBroadcastMessage(allBlocks[third.blockId], allBlocks) === '１かいてん';
                            }
                        },
                        {
                            id_old: 35,
                            title: 'ねこは うごかさず、まず\nメッセージ「１かいてん」を おくり、\n1びょうごに\nメッセージ「かくだい」を おくる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;

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
                            id_old: -1,
                            title: 'ねこは うごかさず、まず\nメッセージ「１かいてん」を おくり、\nおわるまで まってから\nメッセージ「かくだい」を おくる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;
                                const [first, second] = mainSequence;

                                const firstBlock = allBlocks[first.blockId];
                                if (firstBlock?.opcode !== 'event_broadcastandwait') return false;
                                if (String(DrillValidators.getInputValue(firstBlock, 'BROADCAST_INPUT', allBlocks)) !== '１かいてん') return false;

                                const secondBlock = allBlocks[second.blockId];
                                if (secondBlock?.opcode !== 'event_broadcast') return false;
                                return String(DrillValidators.getInputValue(secondBlock, 'BROADCAST_INPUT', allBlocks)) === 'かくだい';
                            }
                        }
                    ]
                },
                {
                    code: '5-2',
                    questions: [
                        {
                            id_old: 32,
                            title: 'xざひょうを 2へらす ことを\n50かい くりかえし、\nそのあとで\nメッセージ「１かいてん」を おくる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;
                                const [first, second] = mainSequence;

                                // 1個目: x座標を -2 変えるのを 50回繰り返す
                                if (!DrillValidators.checkRepeatChangeCoord(allBlocks[first.blockId], allBlocks, 'x', -2, 50)) return false;

                                // 2個目: メッセージ「１かいてん」を送る
                                if (second.opcode !== 'event_broadcast') return false;
                                return DrillValidators.getBroadcastMessage(allBlocks[second.blockId], allBlocks) === '１かいてん';
                            }
                        },
                        {
                            id_old: 33,
                            title: 'xざひょうを 2へらす ことを\n50かい くりかえし、\nそのあとで\nメッセージ「１かいてん」を おくり、\nこんどは xざひょうを 2ふやす ことを\n50かい くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;
        
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
                            id_old: 34,
                            title: 'xざひょうを 2へらす ことを\n50かい くりかえし、\nそのあとで\nメッセージ「１かいてん」を おくって おわるまで まち、\nxざひょうを 2ふやす ことを\n50かい くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;
                                const [first, second, third] = mainSequence;
        
                                // 1個目: x座標を -2 変えるのを 50回繰り返す
                                if (!DrillValidators.checkRepeatChangeCoord(allBlocks[first.blockId], allBlocks, 'x', -2, 50)) return false;
        
                                // 2個目: メッセージ「１かいてん」を送って待つ
                                if (second.opcode !== 'event_broadcastandwait') return false;
                                if (DrillValidators.getBroadcastMessage(allBlocks[second.blockId], allBlocks) !== '１かいてん') return false;
        
                                // 3個目: x座標を 2 変えるのを 50回繰り返す
                                return DrillValidators.checkRepeatChangeCoord(allBlocks[third.blockId], allBlocks, 'x', 2, 50);
                            }
                        },
                    ]
                },
                {
                    code: '6-1',
                    questions: [
                        {
                            id_old: 36,
                            title: '「ずっと」をつかって、\nうわむきやじるしキーを おしたとき\nyざひょうを 5ふやす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const foreverBlock = allBlocks[mainSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                                if (inner.length !== 1) return false;

                                return DrillValidators.checkIfKeyPressedMove(inner[0], allBlocks, 'up arrow', 'y', 5);
                            }
                        },
                        {
                            id_old: -1,
                            title: '「ずっと」をつかって、\nうわむきやじるしキーを おしたとき\nyざひょうを 5ふやし、\nしたむきやじるしキーを おしたとき\nyざひょうを 5へらす。',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const foreverBlock = allBlocks[mainSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                const innerBlocks = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                                if (innerBlocks.length !== 2) return false;

                                const targets = [
                                    { key: 'up arrow', axis: 'y', delta: 5 },
                                    { key: 'down arrow', axis: 'y', delta: -5 }
                                ];

                                return targets.every(t => innerBlocks.some(b => DrillValidators.checkIfKeyPressedMove(b, allBlocks, t.key, t.axis, t.delta)));
                            }
                        },
                        {
                            id_old: 37,
                            title: '「ずっと」をつかって、\n上下左右（じょうげさゆう）やじるしで 上下左右に うごかす。\nすうじは 5 か -5 をつかう',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const foreverBlock = allBlocks[mainSequence[0].blockId];
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
                    ]
                },
                {
                    code: '6-2',
                    questions: [
                        {
                            id_old: 38,
                            title: '「ずっと」をつかって、\nスペースキーをおしたら おおきさが 1ずつ ふえて\nおさなかったら おおきさが 1ずつ へる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const foreverBlock = allBlocks[mainSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                                if (inner.length !== 1) return false;

                                return DrillValidators.checkIfElseKeyPressedChangeSize(inner[0], allBlocks, 'space');
                            }
                        },
                        {
                            id_old: 40,
                            title: '「ずっと」をつかって、\nスペースキーをおしたら おおきさが 1ずつ ふえて\nおさなかったら おおきさが 1ずつ へる。\nスペースキーを おしながら みぎむきやじるしキーも おしたら\nメッセージ「かくだい」を おくる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const foreverBlock = allBlocks[mainSequence[0].blockId];
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
                            id_old: 39,
                            title: '「ずっと」をつかって、\n15ど まわしながら、\nスペースキーをおしたら おおきさが 1ずつ ふえて\nおさなかったら おおきさが 1ずつ へる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;
                                const foreverBlock = allBlocks[mainSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks);
                                if (inner.length !== 2) return false;

                                // 順不同
                                const hasTurn = inner.some(b => DrillValidators.checkTurn(b, allBlocks, 15));
                                const hasChangeSize = inner.some(b => DrillValidators.checkIfElseKeyPressedChangeSize(b, allBlocks, 'space'));

                                return hasTurn && hasChangeSize;
                            }
                        },
                    ]
                },
                {
                    code: '6-3',
                    questions: [
                        {
                            id_old: -1,
                            title: 'ずっと 1びょうごとに\nどこかの ばしょへ いく',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const foreverBlock = allBlocks[mainSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 2) return false;

                                // 1秒まつ & どこかのばしょへいく
                                const waitBlock = inner.find(b => b.opcode === 'control_wait');
                                const gotoBlock = inner.find(b => b.opcode === 'motion_goto');
                                if (!waitBlock || !gotoBlock) return false;

                                if (String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                                const toMenu = allBlocks[gotoBlock.inputs?.TO?.block];
                                return toMenu?.fields?.TO?.value === '_random_';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'ずっと 1びょうごとに\nどこかの ばしょへ いって、\nyざひょうが 100よりも おおきかったら\nつくった スクリプトを とめる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const foreverBlock = allBlocks[mainSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 3) return false;

                                // 1. 1秒まつ
                                const waitBlock = inner.find(b => b.opcode === 'control_wait');
                                if (!waitBlock || String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                                // 2. どこかのばしょへいく
                                const gotoBlock = inner.find(b => b.opcode === 'motion_goto');
                                if (!gotoBlock) return false;
                                const toMenu = allBlocks[gotoBlock.inputs?.TO?.block];
                                if (toMenu?.fields?.TO?.value !== '_random_') return false;

                                // 3. もし yざひょう > 100 なら
                                const ifBlock = inner.find(b => b.opcode === 'control_if');
                                if (!ifBlock || !ifBlock.inputs) return false;

                                const condBlock = allBlocks[ifBlock.inputs.CONDITION?.block];
                                if (!DrillValidators.checkComparison(condBlock, allBlocks, 'motion_yposition', 'gt', 100)) return false;

                                const ifInner = DrillValidators.getInnerBlocks(ifBlock, allBlocks, 'SUBSTACK');
                                if (ifInner.length !== 1) return false;

                                const stopBlock = ifInner[0];
                                if (stopBlock?.opcode !== 'control_stop') return false;

                                const stopType = stopBlock.fields?.STOP_OPTION?.value;
                                return stopType === 'this script' || stopType === 'all';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'ずっと 1びょうごとに\nどこかの ばしょへ いって、\nxざひょうが 100よりも おおきいか\nyざひょうが 100よりも おおきいかの どちらかだったら\nつくった スクリプトを とめる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const foreverBlock = allBlocks[mainSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 3) return false;

                                // 1. 1秒まつ
                                const waitBlock = inner.find(b => b.opcode === 'control_wait');
                                if (!waitBlock || String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                                // 2. どこかのばしょへいく
                                const gotoBlock = inner.find(b => b.opcode === 'motion_goto');
                                if (!gotoBlock) return false;
                                const toMenu = allBlocks[gotoBlock.inputs?.TO?.block];
                                if (toMenu?.fields?.TO?.value !== '_random_') return false;

                                // 3. もし ( x座標 > 100 または y座標 > 100 ) なら
                                const ifBlock = inner.find(b => b.opcode === 'control_if');
                                if (!ifBlock || !ifBlock.inputs) return false;

                                // 条件: OR ブロック (operator_or)
                                const condBlock = allBlocks[ifBlock.inputs.CONDITION?.block];
                                if (condBlock?.opcode !== 'operator_or' || !condBlock.inputs) return false;

                                const op1 = allBlocks[condBlock.inputs.OPERAND1?.block];
                                const op2 = allBlocks[condBlock.inputs.OPERAND2?.block];

                                const isXGt100 = (b) => DrillValidators.checkComparison(b, allBlocks, 'motion_xposition', 'gt', 100);
                                const isYGt100 = (b) => DrillValidators.checkComparison(b, allBlocks, 'motion_yposition', 'gt', 100);

                                // x > 100 または y > 100 の組み合わせチェック（順不同対応）
                                const isValidCond = (isXGt100(op1) && isYGt100(op2)) || (isYGt100(op1) && isXGt100(op2));
                                if (!isValidCond) return false;

                                // 「もし」の内側: つくったスクリプト（または すべて）をとめる
                                const ifInner = DrillValidators.getInnerBlocks(ifBlock, allBlocks, 'SUBSTACK');
                                if (ifInner.length !== 1) return false;

                                const stopBlock = ifInner[0];
                                if (stopBlock?.opcode !== 'control_stop') return false;

                                const stopType = stopBlock.fields?.STOP_OPTION?.value;
                                return stopType === 'this script' || stopType === 'all';
                            }
                        }
                    ]
                },
                {
                    code: '6-4',
                    questions: [
                        {
                            id_old: 43,
                            title: 'yざひょうを ずっと 5 ふやしつづける。\nyざひょうが 100に なったときに\n1びょう とまる',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const foreverBlock = allBlocks[mainSequence[0].blockId];
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
                            id_old: 44,
                            title: 'かいてんほうほうを さゆうのみに してから\nずっと 5ほ うごきつづけて、\nはしに ついたら はねかえる。\nxざひょうが 100よりも おおきいときに\nおおきさを 50%にして、\nそうではないときに おおきさを 100%にする',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;

                                // 1. かいてんほうほうを さゆうのみにする
                                const styleBlock = allBlocks[mainSequence[0].blockId];
                                if (styleBlock?.opcode !== 'motion_setrotationstyle') return false;
                                if (styleBlock.fields?.STYLE?.value !== 'left-right') return false;

                                // 2. ずっと
                                const foreverBlock = allBlocks[mainSequence[1].blockId];
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
                            id_old: 45,
                            title: 'かいてんほうほうを さゆうのみに してから\nずっと 5ほ うごきつづけて、\nはしに ついたら はねかえる。\nxざひょうが 100から150 のときに\nおおきさを 50%にして、\nそうではないときに おおきさを 100%にする',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;

                                // 1. かいてんほうほうを さゆうのみにする
                                const styleBlock = allBlocks[mainSequence[0].blockId];
                                if (styleBlock?.opcode !== 'motion_setrotationstyle') return false;
                                if (styleBlock.fields?.STYLE?.value !== 'left-right') return false;

                                // 2. ずっと
                                const foreverBlock = allBlocks[mainSequence[1].blockId];
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
                    ]
                },
                {
                    code: '7-1',
                    questions: [
                        {
                            id_old: 46,
                            title: 'まず へんすう「のこりじかん」を 15にして、\n1びょう ごとに 1へらす ことを\n15かい くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;

                                // 1. 「のこりじかん」を 15 にする
                                const setVarBlock = allBlocks[mainSequence[0].blockId];
                                if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 15)) return false;

                                // 2. 15回くりかえす
                                const repeatBlock = allBlocks[mainSequence[1].blockId];
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
                            id_old: 47,
                            title: 'まず へんすう「のこりじかん」を 10にして、\n1びょう ごとに 1へらす ことを\n15かい くりかえす。\n※へんすうが マイナスに なっちゃうかも！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;

                                // 1. 「のこりじかん」を 10 にする
                                const setVarBlock = allBlocks[mainSequence[0].blockId];
                                if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 10)) return false;

                                // 2. 15回くりかえす
                                const repeatBlock = allBlocks[mainSequence[1].blockId];
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
                            id_old: 48,
                            title: 'まず へんすう「のこりじかん」を 10にして、\n「のこりじかん」が 0に なるまで\n1びょう ごとに 1へらす ことを くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;

                                // 1. 「のこりじかん」を 10 にする
                                const setVarBlock = allBlocks[mainSequence[0].blockId];
                                if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 10)) return false;

                                // 2. 「のこりじかん」= 0 になるまでくりかえす
                                const repeatUntilBlock = allBlocks[mainSequence[1].blockId];
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
                    ]
                },
                {
                    code: '7-2',
                    questions: [
                        {
                            id_old: 48,
                            title: 'まず へんすう「のこりじかん」を 10にして、\n「のこりじかん」が 0に なるまで\n1びょう ごとに 1へらす ことを くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;

                                // 1. 「のこりじかん」を 10 にする
                                const setVarBlock = allBlocks[mainSequence[0].blockId];
                                if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 10)) return false;

                                // 2. 「のこりじかん」= 0 になるまでくりかえす
                                const repeatUntilBlock = allBlocks[mainSequence[1].blockId];
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
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;

                                // 1. 「のこりじかん」を 10 にする
                                const setVarBlock = allBlocks[mainSequence[0].blockId];
                                if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 10)) return false;

                                // 2. 「のこりじかん」= 0 になるまでくりかえす
                                const repeatUntilBlock = allBlocks[mainSequence[1].blockId];
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
                                const broadcastBlock = allBlocks[mainSequence[2].blockId];
                                if (broadcastBlock?.opcode !== 'event_broadcast') return false;

                                return DrillValidators.getBroadcastMessage(broadcastBlock, allBlocks) === '１かいてん';
                            }
                        },
                        {
                            id: 50,
                            title: 'まず へんすう「のこりじかん」を 10にして、\n「のこりじかん」が 0に なるまで\n1びょう ごとに 1へらす ことを くりかえす。\n3に なったときに\nメッセージ「かくだい」を おくり、\n0に なったら\nメッセージ「１かいてん」を おくる。\n※「もし」は 1つだけ つかうよ！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 3) return false;

                                // 1. 「のこりじかん」を 10 にする
                                const setVarBlock = allBlocks[mainSequence[0].blockId];
                                if (!DrillValidators.checkVariable(setVarBlock, allBlocks, 'data_setvariableto', 'のこりじかん', 10)) return false;

                                // 2. 「のこりじかん」= 0 になるまでくりかえす
                                const repeatUntilBlock = allBlocks[mainSequence[1].blockId];
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
                                const broadcastBlock = allBlocks[mainSequence[2].blockId];
                                if (broadcastBlock?.opcode !== 'event_broadcast') return false;

                                return DrillValidators.getBroadcastMessage(broadcastBlock, allBlocks) === '１かいてん';
                            }
                        },
                    ]
                },
                {
                    code: '8-1',
                    questions: [
                        {
                            id_old: 51,
                            title: 'へんすう「ランダム」を\n0から1までの らんすうに して、\nもし「ランダム」が 0だったら かくして、\nでなければ ひょうじする。\n※なんども ためしに うごかしてみよう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;

                                // 1. 変数「ランダム」を 0から1の乱数にする
                                const setVarBlock = allBlocks[mainSequence[0].blockId];
                                if (!DrillValidators.checkSetVariableToRandom(setVarBlock, allBlocks, 'ランダム', 0, 1)) return false;

                                // 2. もし〜でなければ
                                const ifElseBlock = allBlocks[mainSequence[1].blockId];
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
                            id_old: 52,
                            title: 'ずっと 1びょうごとに\nへんすう「ランダム」を\n0から1までの らんすうに して、\nもし「ランダム」が 0だったら かくして、\nでなければ ひょうじする。\n※「1びょうまつ」は さいごに かこう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const foreverBlock = allBlocks[mainSequence[0].blockId];
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
                            id_old: 53,
                            title: 'ずっと xざひょうを 2 ふやしながら、\nへんすう「ランダム」を\n-10から10までの らんすうに して、\nyざひょうを「ランダム」のかずに する',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const foreverBlock = allBlocks[mainSequence[0].blockId];
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

                                return true;
                            }
                        },
                    ]
                },
                {
                    code: '8-2',
                    questions: [
                        {
                            id_old: 54,
                            title: '1びょうごとに\nへんすう「ランダム」を\n0から30までの らんすうに して\nxざひょうを「ランダム」のかずだけ ふやすことを、\nはしに つくまで くりかえす。\n※「1びょうまつ」は さいごに かこう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const repeatUntilBlock = allBlocks[mainSequence[0].blockId];
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
                            id_old: 55,
                            title: '1びょうごとに\nへんすう「ランダム」を\n-10から30までの らんすうに して\nxざひょうを「ランダム」のかずだけ ふやすことを、\nはしに つくまで くりかえす。\n「ランダム」が 0より ちいさいときは 15ど まわす。\n※「1びょうまつ」は さいごに かこう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const repeatUntilBlock = allBlocks[mainSequence[0].blockId];
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
                                const changeXBlock = inner.find(b => b?.opcode === 'motion_changexby');
                                if (!changeXBlock || !changeXBlock.inputs) return false;
                                const dxBlock = allBlocks[changeXBlock.inputs.DX?.block];
                                if (dxBlock?.opcode !== 'data_variable') return false;
                                const varName = dxBlock.fields?.VARIABLE?.value || dxBlock.fields?.VARIABLE?.id;
                                if (varName !== 'ランダム') return false;

                                const ifBlock = inner.find(b => b?.opcode === 'control_if');
                                if (!ifBlock || !ifBlock.inputs) return false;

                                const ifCondBlock = allBlocks[ifBlock.inputs.CONDITION?.block];
                                if (!DrillValidators.checkComparison(ifCondBlock, allBlocks, 'data_variable', 'lt', 0)) return false;

                                const ifInner = DrillValidators.getInnerBlocks(ifBlock, allBlocks, 'SUBSTACK');
                                if (ifInner.length !== 1) return false;

                                return DrillValidators.checkTurn(ifInner[0], allBlocks, 15);
                            }
                        },
                        {
                            id_old: -1,
                            title: 'まず かいてんほうほうを さゆうのみ にする。\n1びょうごとに\nへんすう「ランダム」を\n-10から30までの らんすうに して\nxざひょうを「ランダム」のかずだけ ふやすことを、\nはしに つくまで くりかえす。\n「ランダム」が 0より ちいさいときは -90ど にむけ、\nでなければ 90ど にむける。\n※「1びょうまつ」は さいごに かこう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;
                                const [first, second] = mainSequence;

                                // 1. かいてんほうほうを「さゆうのみ」にする
                                const styleBlock = allBlocks[first.blockId];
                                if (styleBlock?.opcode !== 'motion_setrotationstyle') return false;
                                if (styleBlock?.fields?.STYLE?.value !== 'left-right') return false;

                                // 2. はしに つくまで くりかえす
                                const repeatUntilBlock = allBlocks[second.blockId];
                                if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                                // 2-1. 条件: はしに ふれた
                                const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                                if (condBlock?.opcode !== 'sensing_touchingobject' || !condBlock.inputs) return false;
                                const touchMenu = allBlocks[condBlock.inputs.TOUCHINGOBJECTMENU?.block];
                                if (touchMenu?.fields?.TOUCHINGOBJECTMENU?.value !== '_edge_') return false;

                                // 2-2. くりかえしの内側 (4個)
                                const inner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 4) return false;

                                // 【1番目 (固定)】へんすう「ランダム」を -10から30までの らんすうにする
                                const setVarBlock = inner[0];
                                if (setVarBlock?.opcode !== 'data_setvariableto' || !setVarBlock.fields) return false;
                                const varField = setVarBlock.fields.VARIABLE;
                                if (!varField || (varField.value !== 'ランダム' && varField.id !== 'ランダム')) return false;

                                const randomBlock = allBlocks[setVarBlock.inputs?.VALUE?.block];
                                if (!DrillValidators.checkRandom(randomBlock, allBlocks, -10, 30)) return false;

                                // 【2番目・3番目 (順不同)】「x座標を変更」と「もし〜でなければ」を探す
                                const midBlocks = [inner[1], inner[2]];
                                const changeXBlock = midBlocks.find(b => b?.opcode === 'motion_changexby');
                                const ifElseBlock = midBlocks.find(b => b?.opcode === 'control_if_else');

                                if (!changeXBlock || !ifElseBlock) return false;

                                // --- xざひょうを「ランダム」のかずだけ ふやす のチェック ---
                                if (!changeXBlock.inputs) return false;
                                const xVarBlock = allBlocks[changeXBlock.inputs.DX?.block];
                                if (xVarBlock?.opcode !== 'data_variable' || !xVarBlock.fields) return false;
                                const xVarField = xVarBlock.fields.VARIABLE;
                                if (!xVarField || (xVarField.value !== 'ランダム' && xVarField.id !== 'ランダム')) return false;

                                // --- 「もし〜でなければ」のチェック ---
                                if (!ifElseBlock.inputs) return false;

                                // 条件判定: 「ランダム」 < 0
                                const ifCondBlock = allBlocks[ifElseBlock.inputs.CONDITION?.block];
                                if (ifCondBlock?.opcode !== 'operator_lt' || !ifCondBlock.inputs) return false;

                                const ltVarBlock = allBlocks[ifCondBlock.inputs.OPERAND1?.block];
                                if (ltVarBlock?.opcode !== 'data_variable' || !ltVarBlock.fields) return false;
                                const ltVarField = ltVarBlock.fields.VARIABLE;
                                if (!ltVarField || (ltVarField.value !== 'ランダム' && ltVarField.id !== 'ランダム')) return false;

                                if (String(DrillValidators.getInputValue(ifCondBlock, 'OPERAND2', allBlocks)) !== '0') return false;

                                // 「もし」の中身 (SUBSTACK): -90度に向ける
                                const ifSubstack = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK');
                                if (ifSubstack.length !== 1) return false;
                                const pointNeg90 = ifSubstack[0];
                                if (pointNeg90?.opcode !== 'motion_pointindirection') return false;
                                if (String(DrillValidators.getInputValue(pointNeg90, 'DIRECTION', allBlocks)) !== '-90') return false;

                                // 「でなければ」の中身 (SUBSTACK2): 90度に向ける
                                const elseSubstack = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK2');
                                if (elseSubstack.length !== 1) return false;
                                const point90 = elseSubstack[0];
                                if (point90?.opcode !== 'motion_pointindirection') return false;
                                if (String(DrillValidators.getInputValue(point90, 'DIRECTION', allBlocks)) !== '90') return false;

                                // 【4番目 (固定)】1びょうまつ
                                const waitBlock = inner[3];
                                if (waitBlock?.opcode !== 'control_wait') return false;
                                return String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) === '1';
                            }
                        }
                    ]
                },
                {
                    code: '9-1',
                    questions: [
                        {
                            id_old: 56,
                            title: 'リスト「アルファベット」の 1ばんめを\nねこが 1びょう しゃべる。\n※「～と ～びょう いう」を つかおう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const sayBlock = allBlocks[mainSequence[0].blockId];
                                if (sayBlock?.opcode !== 'looks_sayforsecs' || !sayBlock.inputs) return false;
                                if (String(DrillValidators.getInputValue(sayBlock, 'SECS', allBlocks)) !== '1') return false;

                                const msgBlock = allBlocks[sayBlock.inputs.MESSAGE?.block];
                                if (msgBlock?.opcode !== 'data_itemoflist' || !msgBlock.fields) return false;

                                const listField = msgBlock.fields.LIST;
                                if (!listField || (listField.value !== 'アルファベット' && listField.id !== 'アルファベット')) return false;

                                return String(DrillValidators.getInputValue(msgBlock, 'INDEX', allBlocks)) === '1';
                            }
                        },
                        {
                            id_old: 57,
                            title: '1から26までの らんすうを つかって\nリスト「アルファベット」の ランダムな もじを\nねこが 1びょう しゃべる。\n※「～と ～びょう いう」を つかおう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const sayBlock = allBlocks[mainSequence[0].blockId];
                                if (sayBlock?.opcode !== 'looks_sayforsecs' || !sayBlock.inputs) return false;
                                if (String(DrillValidators.getInputValue(sayBlock, 'SECS', allBlocks)) !== '1') return false;

                                const msgBlock = allBlocks[sayBlock.inputs.MESSAGE?.block];
                                if (msgBlock?.opcode !== 'data_itemoflist' || !msgBlock.fields) return false;

                                const listField = msgBlock.fields.LIST;
                                if (!listField || (listField.value !== 'アルファベット' && listField.id !== 'アルファベット')) return false;

                                const indexBlock = allBlocks[msgBlock.inputs.INDEX?.block];
                                return DrillValidators.checkRandom(indexBlock, allBlocks, 1, 26);
                            }
                        },
                        {
                            id_old: 58,
                            title: 'ずっと 1びょうごとに\n1から26までの らんすうを つかって\nリスト「アルファベット」の ランダムな もじを\nねこが しゃべりつづける。\n※「～と ～びょう いう」を つかおう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const foreverBlock = allBlocks[mainSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 1) return false;

                                const sayForSecsBlock = inner[0];
                                if (sayForSecsBlock?.opcode !== 'looks_sayforsecs' || !sayForSecsBlock.inputs) return false;

                                if (String(DrillValidators.getInputValue(sayForSecsBlock, 'SECS', allBlocks)) !== '1') return false;

                                const msgBlock = allBlocks[sayForSecsBlock.inputs.MESSAGE?.block];
                                if (msgBlock?.opcode !== 'data_itemoflist' || !msgBlock.fields) return false;

                                const listField = msgBlock.fields.LIST;
                                if (!listField || (listField.value !== 'アルファベット' && listField.id !== 'アルファベット')) return false;

                                const indexBlock = allBlocks[msgBlock.inputs.INDEX?.block];
                                return DrillValidators.checkRandom(indexBlock, allBlocks, 1, 26);
                            }
                        },
                    ]
                },
                {
                    code: '9-2',
                    questions: [
                        {
                            id_old: 59,
                            title: 'リスト「アルファベット」を からっぽにして\nすきな もじを 3つ ついかしてから、\nずっと 1びょうごとに\nらんすうを つかって\nランダムな もじを\nねこが しゃべりつづける。\n※「～と ～びょう いう」を つかおう！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 5) return false;

                                // 1. リスト「アルファベット」のすべてを削除する
                                const deleteAllBlock = allBlocks[mainSequence[0].blockId];
                                if (deleteAllBlock?.opcode !== 'data_deletealloflist' || !deleteAllBlock.fields) return false;
                                const listField0 = deleteAllBlock.fields.LIST;
                                if (!listField0 || (listField0.value !== 'アルファベット' && listField0.id !== 'アルファベット')) return false;

                                // 2~4. 文字を 3つ追加する
                                for (let i = 1; i <= 3; i++) {
                                    const addBlock = allBlocks[mainSequence[i].blockId];
                                    if (addBlock?.opcode !== 'data_addtolist' || !addBlock.fields) return false;
                                    const listField = addBlock.fields.LIST;
                                    if (!listField || (listField.value !== 'アルファベット' && listField.id !== 'アルファベット')) return false;
                                }

                                // 5. ずっと
                                const foreverBlock = allBlocks[mainSequence[4].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 1) return false;

                                const sayForSecsBlock = inner[0];
                                if (sayForSecsBlock?.opcode !== 'looks_sayforsecs' || !sayForSecsBlock.inputs) return false;
                                if (String(DrillValidators.getInputValue(sayForSecsBlock, 'SECS', allBlocks)) !== '1') return false;

                                const msgBlock = allBlocks[sayForSecsBlock.inputs.MESSAGE?.block];
                                if (msgBlock?.opcode !== 'data_itemoflist' || !msgBlock.fields) return false;

                                const listField = msgBlock.fields.LIST;
                                if (!listField || (listField.value !== 'アルファベット' && listField.id !== 'アルファベット')) return false;

                                // 乱数判定: 1から3の乱数、または 1から「長さ」の乱数
                                const indexBlock = allBlocks[msgBlock.inputs.INDEX?.block];
                                if (!indexBlock || indexBlock.opcode !== 'operator_random') return false;

                                if (String(DrillValidators.getInputValue(indexBlock, 'FROM', allBlocks)) !== '1') return false;

                                const toVal = DrillValidators.getInputValue(indexBlock, 'TO', allBlocks);
                                const toInputBlock = allBlocks[indexBlock.inputs?.TO?.block];

                                const isTo3 = String(toVal) === '3';
                                const isToLength = toInputBlock?.opcode === 'data_lengthoflist' &&
                                    (toInputBlock.fields?.LIST?.value === 'アルファベット' || toInputBlock.fields?.LIST?.id === 'アルファベット');

                                return isTo3 || isToLength;
                            }
                        },
                        {
                            id_old: 60,
                            title: 'リスト「アルファベット」の 1ばんめを\nねこが 1びょう しゃべって、\nそのあとで リストの 1ばんめを さくじょする ことを、\nリストの ながさが 0になるまで くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const repeatUntilBlock = allBlocks[mainSequence[0].blockId];
                                if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                                // 1. 条件式: リスト「アルファベット」の長さ = 0
                                const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                                if (!condBlock || condBlock.opcode !== 'operator_equals' || !condBlock.inputs) return false;

                                const isLengthZero = (valBlock, numInputName) => {
                                    if (valBlock?.opcode !== 'data_lengthoflist' || !valBlock.fields) return false;
                                    const listField = valBlock.fields.LIST;
                                    if (!listField || (listField.value !== 'アルファベット' && listField.id !== 'アルファベット')) return false;
                                    return String(DrillValidators.getInputValue(condBlock, numInputName, allBlocks)) === '0';
                                };

                                const op1 = allBlocks[condBlock.inputs.OPERAND1?.block];
                                const op2 = allBlocks[condBlock.inputs.OPERAND2?.block];
                                if (!isLengthZero(op1, 'OPERAND2') && !isLengthZero(op2, 'OPERAND1')) return false;

                                // 2. 内側のブロック (2個: 1秒いう -> 1番目を削除)
                                const inner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 2) return false;

                                // 2-1. リスト「アルファベット」の 1番目を 1秒いう
                                const sayBlock = inner[0];
                                if (sayBlock?.opcode !== 'looks_sayforsecs' || !sayBlock.inputs) return false;
                                if (String(DrillValidators.getInputValue(sayBlock, 'SECS', allBlocks)) !== '1') return false;

                                const msgBlock = allBlocks[sayBlock.inputs.MESSAGE?.block];
                                if (msgBlock?.opcode !== 'data_itemoflist' || !msgBlock.fields) return false;
                                const msgListField = msgBlock.fields.LIST;
                                if (!msgListField || (msgListField.value !== 'アルファベット' && msgListField.id !== 'アルファベット')) return false;
                                if (String(DrillValidators.getInputValue(msgBlock, 'INDEX', allBlocks)) !== '1') return false;

                                // 2-2. リスト「アルファベット」の 1番目を削除する
                                const deleteBlock = inner[1];
                                if (deleteBlock?.opcode !== 'data_deleteoflist' || !deleteBlock.fields) return false;
                                const deleteListField = deleteBlock.fields.LIST;
                                if (!deleteListField || (deleteListField.value !== 'アルファベット' && deleteListField.id !== 'アルファベット')) return false;

                                return String(DrillValidators.getInputValue(deleteBlock, 'INDEX', allBlocks)) === '1';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'へんすう「ランダム」を 1から\nリスト「アルファベット」の ながさまでの らんすうに して\nリストの「ランダム」ばんめを\nねこが 1びょう しゃべって、\nそのあとで リストの「ランダム」ばんめを さくじょする ことを、\nリストの ながさが 0になるまで くりかえす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                // 変数・リストの参照確認用ヘルパー
                                const checkVar = (b, name) => b?.opcode === 'data_variable' && (b.fields?.VARIABLE?.value === name || b.fields?.VARIABLE?.id === name);
                                const checkList = (b, name) => b?.fields?.LIST?.value === name || b?.fields?.LIST?.id === name;
                                const isLengthOfList = (b) => b?.opcode === 'data_lengthoflist' && checkList(b, 'アルファベット');

                                // 1. 〜までくりかえす ブロック
                                const repeatUntilBlock = allBlocks[mainSequence[0].blockId];
                                if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                                // 1-1. 条件判定: リスト「アルファベット」の長さ = 0
                                const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                                if (condBlock?.opcode !== 'operator_equals' || !condBlock.inputs) return false;

                                const op1 = allBlocks[condBlock.inputs.OPERAND1?.block];
                                const op2 = allBlocks[condBlock.inputs.OPERAND2?.block];
                                const val1 = DrillValidators.getInputValue(condBlock, 'OPERAND1', allBlocks);
                                const val2 = DrillValidators.getInputValue(condBlock, 'OPERAND2', allBlocks);

                                const condValid = (isLengthOfList(op1) && String(val2) === '0') || (isLengthOfList(op2) && String(val1) === '0');
                                if (!condValid) return false;

                                // 1-2. くりかえしの内側 (3個)
                                const inner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 3) return false;

                                // 【1番目】へんすう「ランダム」を 1 から リスト「アルファベット」の長さ までの乱数にする
                                const setVarBlock = inner[0];
                                if (setVarBlock?.opcode !== 'data_setvariableto' || !setVarBlock.fields) return false;
                                const v = setVarBlock.fields.VARIABLE;
                                if (!v || (v.value !== 'ランダム' && v.id !== 'ランダム')) return false;

                                const randomBlock = allBlocks[setVarBlock.inputs?.VALUE?.block];
                                if (randomBlock?.opcode !== 'operator_random' || !randomBlock.inputs) return false;

                                // 1 から
                                if (String(DrillValidators.getInputValue(randomBlock, 'FROM', allBlocks)) !== '1') return false;

                                // リスト「アルファベット」の長さ まで
                                const toBlock = allBlocks[randomBlock.inputs.TO?.block];
                                if (!isLengthOfList(toBlock)) return false;

                                // 【2番目】リスト「アルファベット」の「ランダム」ばんめを 1びょう しゃべる
                                const sayBlock = inner[1];
                                if (sayBlock?.opcode !== 'looks_sayforsecs' || !sayBlock.inputs) return false;
                                if (String(DrillValidators.getInputValue(sayBlock, 'SECS', allBlocks)) !== '1') return false;

                                const itemBlock = allBlocks[sayBlock.inputs.MESSAGE?.block];
                                if (itemBlock?.opcode !== 'data_itemoflist' || !checkList(itemBlock, 'アルファベット')) return false;

                                const indexBlock = allBlocks[itemBlock.inputs?.INDEX?.block];
                                if (!checkVar(indexBlock, 'ランダム')) return false;

                                // 【3番目】リストの「ランダム」ばんめを さくじょする
                                const deleteBlock = inner[2];
                                if (deleteBlock?.opcode !== 'data_deleteoflist' || !deleteBlock.inputs || !checkList(deleteBlock, 'アルファベット')) return false;

                                const delIndexBlock = allBlocks[deleteBlock.inputs?.INDEX?.block];
                                return checkVar(delIndexBlock, 'ランダム');
                            }
                        }
                    ]
                },
                {
                    code: '10-1',
                    questions: [
                        {
                            id_old: -1,
                            title: 'ねこが すうじを しつもんして\nxざひょうを こたえの すうじに する。\n※しつもんする ぶんしょうは なんでもいいよ！\nたとえば：「なんのすうじにする？」',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;
                                const [first, second] = mainSequence;

                                // 1. しつもんする（〜ときいてまつ）
                                const askBlock = allBlocks[first.blockId];
                                if (askBlock?.opcode !== 'sensing_askandwait') return false;

                                // 2. xざひょうを こたえのすうじにする
                                const setXBlock = allBlocks[second.blockId];
                                if (setXBlock?.opcode !== 'motion_setx' || !setXBlock.inputs) return false;

                                const ansBlock = allBlocks[setXBlock.inputs.X?.block];
                                return ansBlock?.opcode === 'sensing_answer';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'ねこが すうじを しつもんして\nリスト「アルファベット」の「こたえ」ばんめを\nねこが 2びょう しゃべる。\nこれを ずっと くりかえす。\n※しつもんする ぶんしょうは なんでもいいよ！\nたとえば：「なんばんめにする？」',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const checkList = (b, name) => b?.fields?.LIST?.value === name || b?.fields?.LIST?.id === name;

                                // 1. ずっと くりかえす
                                const foreverBlock = allBlocks[mainSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                // 「ずっと」の内側 (2個: しつもんする -> 言う)
                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 2) return false;

                                const [askBlock, sayBlock] = inner;

                                // 1-1. しつもんする（〜ときいてまつ）
                                if (askBlock?.opcode !== 'sensing_askandwait') return false;

                                // 1-2. リスト「アルファベット」の「こたえ」番目を 2秒しゃべる
                                if (sayBlock?.opcode !== 'looks_sayforsecs' || !sayBlock.inputs) return false;
                                if (String(DrillValidators.getInputValue(sayBlock, 'SECS', allBlocks)) !== '2') return false;

                                const itemBlock = allBlocks[sayBlock.inputs.MESSAGE?.block];
                                if (itemBlock?.opcode !== 'data_itemoflist' || !checkList(itemBlock, 'アルファベット')) return false;

                                const indexBlock = allBlocks[itemBlock.inputs?.INDEX?.block];
                                return indexBlock?.opcode === 'sensing_answer';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'ねこが すうじを しつもんして、「こたえ」が\n0より おおきく\n27より ちいさければ\nリスト「アルファベット」の「こたえ」ばんめを\nねこが 2びょう しゃべって、\nでなければ\nメッセージ「１かいてん」を おくって まつ。\nこれを ずっと くりかえす。\n※しつもんする ぶんしょうは なんでもいいよ！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const checkList = (b, name) => b?.fields?.LIST?.value === name || b?.fields?.LIST?.id === name;

                                // 1. ずっと くりかえす
                                const foreverBlock = allBlocks[mainSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                // 「ずっと」の内側 (2個: しつもんする -> もし〜でなければ)
                                const inner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 2) return false;

                                const [askBlock, ifElseBlock] = inner;

                                // 1-1. しつもんする（〜ときいてまつ）
                                if (askBlock?.opcode !== 'sensing_askandwait') return false;

                                // 1-2. もし〜でなければ
                                if (ifElseBlock?.opcode !== 'control_if_else' || !ifElseBlock.inputs) return false;

                                // --- 条件判定: [こたえ > 0] かつ [こたえ < 27] ---
                                const condBlock = allBlocks[ifElseBlock.inputs.CONDITION?.block];
                                if (condBlock?.opcode !== 'operator_and' || !condBlock.inputs) return false;

                                const op1 = allBlocks[condBlock.inputs.OPERAND1?.block];
                                const op2 = allBlocks[condBlock.inputs.OPERAND2?.block];

                                const isGt0 = (b) => DrillValidators.checkComparison(b, allBlocks, 'sensing_answer', 'gt', 0);
                                const isLt27 = (b) => DrillValidators.checkComparison(b, allBlocks, 'sensing_answer', 'lt', 27);

                                // ANDの左右順序に対応
                                const isAndValid = (isGt0(op1) && isLt27(op2)) || (isLt27(op1) && isGt0(op2));
                                if (!isAndValid) return false;

                                // --- 「もし」の中身 (SUBSTACK): リストの「こたえ」番目を 2秒しゃべる ---
                                const ifSubstack = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK');
                                if (ifSubstack.length !== 1) return false;

                                const sayBlock = ifSubstack[0];
                                if (sayBlock?.opcode !== 'looks_sayforsecs' || !sayBlock.inputs) return false;
                                if (String(DrillValidators.getInputValue(sayBlock, 'SECS', allBlocks)) !== '2') return false;

                                const itemBlock = allBlocks[sayBlock.inputs.MESSAGE?.block];
                                if (itemBlock?.opcode !== 'data_itemoflist' || !checkList(itemBlock, 'アルファベット')) return false;

                                const indexBlock = allBlocks[itemBlock.inputs?.INDEX?.block];
                                if (indexBlock?.opcode !== 'sensing_answer') return false;

                                // --- 「でなければ」の中身 (SUBSTACK2): メッセージ「１かいてん」を送って待つ ---
                                const elseSubstack = DrillValidators.getInnerBlocks(ifElseBlock, allBlocks, 'SUBSTACK2');
                                if (elseSubstack.length !== 1) return false;

                                const broadcastBlock = elseSubstack[0];
                                if (broadcastBlock?.opcode !== 'event_broadcastandwait' || !broadcastBlock.inputs) return false;

                                const menuBlock = allBlocks[broadcastBlock.inputs.BROADCAST_INPUT?.block];
                                const msgName = menuBlock?.fields?.BROADCAST_OPTION?.value;

                                // 全角・半角どちらの「1」でも許容
                                return msgName === '１かいてん';
                            }
                        }
                    ]
                },
                {
                    code: '11-1',
                    questions: [
                        {
                            id_old: -1,
                            title: 'ねこを 0ど（うえ）に むけて\nはしに つくまで\n10ぽ うごかしつづける',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;

                                const [pointBlock, repeatBlock] = mainSequence.map(item => allBlocks[item.blockId]);

                                // 1. 0度（上）に向ける
                                if (pointBlock?.opcode !== 'motion_pointindirection') return false;
                                if (String(DrillValidators.getInputValue(pointBlock, 'DIRECTION', allBlocks)) !== '0') return false;

                                // 2. 端につくまで繰り返す
                                if (repeatBlock?.opcode !== 'control_repeat_until' || !repeatBlock.inputs) return false;

                                const condBlock = allBlocks[repeatBlock.inputs.CONDITION?.block];
                                if (condBlock?.opcode !== 'sensing_touchingobject' || !condBlock.inputs) return false;
                                const touchMenu = allBlocks[condBlock.inputs.TOUCHINGOBJECTMENU?.block];
                                if (touchMenu?.fields?.TOUCHINGOBJECTMENU?.value !== '_edge_') return false;

                                // くりかえしの内側: 10歩動かす
                                const inner = DrillValidators.getInnerBlocks(repeatBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 1) return false;

                                const moveBlock = inner[0];
                                if (moveBlock?.opcode !== 'motion_movesteps') return false;
                                return String(DrillValidators.getInputValue(moveBlock, 'STEPS', allBlocks)) === '10';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'ブロックていぎを つくって\nうえに あるく プログラムを ブロックに まとめて、\nそのブロックを つかって うえに あるく。\n※ブロックの なまえは なんでもいいよ！\nたとえば：「うえにあるく」',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                // 配列 / JSON文字列の両方に対応するパースヘルパー
                                const parseArray = (val) => {
                                    if (!val) return [];
                                    if (Array.isArray(val)) return val;
                                    try { return JSON.parse(val); } catch (e) { return []; }
                                };

                                // 1. mainSequence 側: カスタムブロック呼び出し（procedures_call）
                                const callBlock = allBlocks[mainSequence[0].blockId];
                                if (callBlock?.opcode !== 'procedures_call') return false;

                                const targetProcCode = callBlock.mutation?.proccode;
                                if (!targetProcCode) return false;

                                // 2. allBlocks 全体から、呼び出し先と一致するブロック定義（procedures_definition）を探索
                                const defBlock = Object.values(allBlocks).find(b => {
                                    if (b.opcode !== 'procedures_definition') return false;
                                    const proto = allBlocks[b.inputs?.custom_block?.block];
                                    return proto?.opcode === 'procedures_prototype' && proto?.mutation?.proccode === targetProcCode;
                                });
                                if (!defBlock) return false;

                                // 引数が 0 個であることを確認
                                const protoBlock = allBlocks[defBlock.inputs?.custom_block?.block];
                                const argIds = parseArray(protoBlock?.mutation?.argumentids);
                                if (argIds.length !== 0) return false;

                                // 3. 定義側のブロック列を取得（next をたどる）
                                const defSeq = [];
                                let currentId = defBlock.next;
                                while (currentId) {
                                    const b = allBlocks[currentId];
                                    if (!b) break;
                                    defSeq.push(b);
                                    currentId = b.next;
                                }
                                if (defSeq.length !== 2) return false;

                                const [pointBlock, repeatBlock] = defSeq;

                                // 3-1. 0度に向ける
                                if (pointBlock?.opcode !== 'motion_pointindirection') return false;
                                if (String(DrillValidators.getInputValue(pointBlock, 'DIRECTION', allBlocks)) !== '0') return false;

                                // 3-2. 端につくまで 10歩動かす
                                if (repeatBlock?.opcode !== 'control_repeat_until' || !repeatBlock.inputs) return false;

                                const condBlock = allBlocks[repeatBlock.inputs.CONDITION?.block];
                                if (condBlock?.opcode !== 'sensing_touchingobject' || !condBlock.inputs) return false;
                                const touchMenu = allBlocks[condBlock.inputs.TOUCHINGOBJECTMENU?.block];
                                if (touchMenu?.fields?.TOUCHINGOBJECTMENU?.value !== '_edge_') return false;

                                const inner = DrillValidators.getInnerBlocks(repeatBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 1) return false;

                                const moveBlock = inner[0];
                                if (moveBlock?.opcode !== 'motion_movesteps') return false;
                                return String(DrillValidators.getInputValue(moveBlock, 'STEPS', allBlocks)) === '10';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'ブロックていぎで ひきすう（すうち）を 1つ ついかして\nねこの ほうこうを ひきすうで きめる。\nブロックを つかうときは\nひきすうを らんすうに する。\n※ブロックの なまえ・ひきすうの なまえ・らんすうの はんいは なんでもいいよ！',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 1) return false;

                                const parseArray = (val) => {
                                    if (!val) return [];
                                    if (Array.isArray(val)) return val;
                                    try { return JSON.parse(val); } catch (e) { return []; }
                                };

                                // 1. mainSequence 側: カスタムブロック呼び出し（procedures_call）
                                const callBlock = allBlocks[mainSequence[0].blockId];
                                if (callBlock?.opcode !== 'procedures_call') return false;

                                const targetProcCode = callBlock.mutation?.proccode;
                                if (!targetProcCode) return false;

                                // 2. allBlocks から一致するブロック定義を探索
                                const defBlock = Object.values(allBlocks).find(b => {
                                    if (b.opcode !== 'procedures_definition') return false;
                                    const proto = allBlocks[b.inputs?.custom_block?.block];
                                    return proto?.opcode === 'procedures_prototype' && proto?.mutation?.proccode === targetProcCode;
                                });
                                if (!defBlock) return false;

                                // 引数が 1 つだけ存在することを確認
                                const protoBlock = allBlocks[defBlock.inputs?.custom_block?.block];
                                const argIds = parseArray(protoBlock?.mutation?.argumentids);
                                const argNames = parseArray(protoBlock?.mutation?.argumentnames);
                                if (argIds.length !== 1 || argNames.length !== 1) return false;

                                const argId = argIds[0];
                                const argName = argNames[0];

                                // 3. 呼び出し側: 引数に「乱数（operator_random）」が渡されているか検証
                                const passedInput = callBlock.inputs?.[argId];
                                if (!passedInput) return false;
                                const randomBlock = allBlocks[passedInput.block];
                                if (randomBlock?.opcode !== 'operator_random') return false;

                                // 4. 定義側のブロック列を取得（next をたどる）
                                const defSeq = [];
                                let currentId = defBlock.next;
                                while (currentId) {
                                    const b = allBlocks[currentId];
                                    if (!b) break;
                                    defSeq.push(b);
                                    currentId = b.next;
                                }
                                if (defSeq.length !== 2) return false;

                                const [pointBlock, repeatBlock] = defSeq;

                                // 4-1. 「引数」度に向ける
                                if (pointBlock?.opcode !== 'motion_pointindirection' || !pointBlock.inputs) return false;

                                // 向きの入力ブロックが引数レポーター（argument_reporter_string_number）で、名前が一致するか確認
                                const dirInputBlock = allBlocks[pointBlock.inputs.DIRECTION?.block];
                                if (dirInputBlock?.opcode !== 'argument_reporter_string_number') return false;
                                if (dirInputBlock.fields?.VALUE?.value !== argName) return false;

                                // 4-2. 端につくまで 10歩動かす
                                if (repeatBlock?.opcode !== 'control_repeat_until' || !repeatBlock.inputs) return false;

                                const condBlock = allBlocks[repeatBlock.inputs.CONDITION?.block];
                                if (condBlock?.opcode !== 'sensing_touchingobject' || !condBlock.inputs) return false;
                                const touchMenu = allBlocks[condBlock.inputs.TOUCHINGOBJECTMENU?.block];
                                if (touchMenu?.fields?.TOUCHINGOBJECTMENU?.value !== '_edge_') return false;

                                const inner = DrillValidators.getInnerBlocks(repeatBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 1) return false;

                                const moveBlock = inner[0];
                                if (moveBlock?.opcode !== 'motion_movesteps') return false;
                                return String(DrillValidators.getInputValue(moveBlock, 'STEPS', allBlocks)) === '10';
                            }
                        }
                    ]
                },
                {
                    code: '12-1',
                    questions: [
                        {
                            id_old: -1,
                            title: 'まず へんすう「のこりじかん」を 10にして、\n「のこりじかん」が 0に なるまで\n1びょう ごとに 1へらす ことを くりかえす。\nへんすうを へらすときに\nねこを 5ほ うごかす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (subSequence.length !== 0) return false;
                                if (mainSequence.length !== 2) return false;
                                const [setTimerBlock, repeatUntilBlock] = mainSequence.map(item => allBlocks[item.blockId]);

                                const checkVar = (b, name) => b?.opcode === 'data_variable' && (b.fields?.VARIABLE?.value === name || b.fields?.VARIABLE?.id === name);

                                // 1. へんすう「のこりじかん」を 10 にする
                                if (setTimerBlock?.opcode !== 'data_setvariableto' || !setTimerBlock.fields) return false;
                                const v = setTimerBlock.fields.VARIABLE;
                                if (!v || (v.value !== 'のこりじかん' && v.id !== 'のこりじかん')) return false;
                                if (String(DrillValidators.getInputValue(setTimerBlock, 'VALUE', allBlocks)) !== '10') return false;

                                // 2. 「のこりじかん」= 0 になるまでくりかえす
                                if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                                const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                                if (condBlock?.opcode !== 'operator_equals' || !condBlock.inputs) return false;

                                const op1 = allBlocks[condBlock.inputs.OPERAND1?.block];
                                const op2 = allBlocks[condBlock.inputs.OPERAND2?.block];
                                const val1 = DrillValidators.getInputValue(condBlock, 'OPERAND1', allBlocks);
                                const val2 = DrillValidators.getInputValue(condBlock, 'OPERAND2', allBlocks);

                                const isTimerEqualsZero = (checkVar(op1, 'のこりじかん') && String(val2) === '0') ||
                                                        (checkVar(op2, 'のこりじかん') && String(val1) === '0');
                                if (!isTimerEqualsZero) return false;

                                // 3. くりかえしの内側 (1秒まつ / 1へらす / 5ほうごかす の 3個)
                                const inner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                                if (inner.length !== 3) return false;

                                const waitBlock = inner.find(b => b.opcode === 'control_wait');
                                const changeBlock = inner.find(b => b.opcode === 'data_changevariableby');
                                const moveBlock = inner.find(b => b.opcode === 'motion_movesteps');

                                if (!waitBlock || !changeBlock || !moveBlock) return false;

                                // 1秒まつ
                                if (String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                                // 「のこりじかん」を -1 ずつ変える
                                const changeVar = changeBlock.fields?.VARIABLE;
                                if (!changeVar || (changeVar.value !== 'のこりじかん' && changeVar.id !== 'のこりじかん')) return false;
                                if (String(DrillValidators.getInputValue(changeBlock, 'VALUE', allBlocks)) !== '-1') return false;

                                // 5歩動かす
                                return String(DrillValidators.getInputValue(moveBlock, 'STEPS', allBlocks)) === '5';
                            }
                        },
                        {
                            id_old: -1,
                            title: 'まず へんすう「のこりじかん」を 10にして、\n「のこりじかん」が 0に なるまで\n1びょう ごとに 1へらす ことを くりかえす。\nくろい ぶひん「ここから かきはじめる(2)」を つかって\nずっと ねこを 5ほ うごかす',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (mainSequence.length !== 2 || subSequence.length !== 1) return false;

                                const checkVar = (b, name) => b?.opcode === 'data_variable' && (b.fields?.VARIABLE?.value === name || b.fields?.VARIABLE?.id === name);

                                // --- 1. タイマー側 (mainSequence) ---
                                const [setTimerBlock, repeatUntilBlock] = mainSequence.map(item => allBlocks[item.blockId]);

                                // へんすう「のこりじかん」を 10 にする
                                if (setTimerBlock?.opcode !== 'data_setvariableto' || !setTimerBlock.fields) return false;
                                const v = setTimerBlock.fields.VARIABLE;
                                if (!v || (v.value !== 'のこりじかん' && v.id !== 'のこりじかん')) return false;
                                if (String(DrillValidators.getInputValue(setTimerBlock, 'VALUE', allBlocks)) !== '10') return false;

                                // 「のこりじかん」= 0 になるまでくりかえす
                                if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                                const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                                if (condBlock?.opcode !== 'operator_equals' || !condBlock.inputs) return false;

                                const op1 = allBlocks[condBlock.inputs.OPERAND1?.block];
                                const op2 = allBlocks[condBlock.inputs.OPERAND2?.block];
                                const val1 = DrillValidators.getInputValue(condBlock, 'OPERAND1', allBlocks);
                                const val2 = DrillValidators.getInputValue(condBlock, 'OPERAND2', allBlocks);

                                const isTimerEqualsZero = (checkVar(op1, 'のこりじかん') && String(val2) === '0') ||
                                                        (checkVar(op2, 'のこりじかん') && String(val1) === '0');
                                if (!isTimerEqualsZero) return false;

                                // タイマーの内側 (1秒まつ / 1へらす の 2個)
                                const timerInner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                                if (timerInner.length !== 2) return false;

                                const waitBlock = timerInner.find(b => b.opcode === 'control_wait');
                                const changeBlock = timerInner.find(b => b.opcode === 'data_changevariableby');
                                if (!waitBlock || !changeBlock) return false;

                                if (String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                                const changeVar = changeBlock.fields?.VARIABLE;
                                if (!changeVar || (changeVar.value !== 'のこりじかん' && changeVar.id !== 'のこりじかん')) return false;
                                if (String(DrillValidators.getInputValue(changeBlock, 'VALUE', allBlocks)) !== '-1') return false;

                                // --- 2. ネコ側 (subSequence): ずっと 5ほ うごかす ---
                                const foreverBlock = allBlocks[subSequence[0].blockId];
                                if (foreverBlock?.opcode !== 'control_forever') return false;

                                const catInner = DrillValidators.getInnerBlocks(foreverBlock, allBlocks, 'SUBSTACK');
                                if (catInner.length !== 1) return false;

                                const moveBlock = catInner[0];
                                if (moveBlock?.opcode !== 'motion_movesteps') return false;

                                return String(DrillValidators.getInputValue(moveBlock, 'STEPS', allBlocks)) === '5';
                            }
                        },
                        {
                            id_old: -1,
                            title: '10びょう タイマーは そのままで、\nくろい ぶひん「ここから かきはじめる(2)」を つかって、\nかいてんほうほうを さゆうのみに してから\n「のこりじかん」が 0に なるまで\nねこを 5ほ うごかしつづけて\nはしに ついたら はねかえる。',
                            validate: (mainSequence, subSequence, allBlocks) => {
                                if (mainSequence.length !== 2 || subSequence.length !== 2) return false;

                                const checkVar = (b, name) => b?.opcode === 'data_variable' && (b.fields?.VARIABLE?.value === name || b.fields?.VARIABLE?.id === name);

                                // --- 1. タイマー側 (mainSequence) ---
                                const [setTimerBlock, repeatUntilBlock] = mainSequence.map(item => allBlocks[item.blockId]);

                                if (setTimerBlock?.opcode !== 'data_setvariableto' || !setTimerBlock.fields) return false;
                                const v = setTimerBlock.fields.VARIABLE;
                                if (!v || (v.value !== 'のこりじかん' && v.id !== 'のこりじかん')) return false;
                                if (String(DrillValidators.getInputValue(setTimerBlock, 'VALUE', allBlocks)) !== '10') return false;

                                if (repeatUntilBlock?.opcode !== 'control_repeat_until' || !repeatUntilBlock.inputs) return false;

                                const condBlock = allBlocks[repeatUntilBlock.inputs.CONDITION?.block];
                                if (condBlock?.opcode !== 'operator_equals' || !condBlock.inputs) return false;

                                const op1 = allBlocks[condBlock.inputs.OPERAND1?.block];
                                const op2 = allBlocks[condBlock.inputs.OPERAND2?.block];
                                const val1 = DrillValidators.getInputValue(condBlock, 'OPERAND1', allBlocks);
                                const val2 = DrillValidators.getInputValue(condBlock, 'OPERAND2', allBlocks);

                                const isTimerEqualsZero = (checkVar(op1, 'のこりじかん') && String(val2) === '0') ||
                                                        (checkVar(op2, 'のこりじかん') && String(val1) === '0');
                                if (!isTimerEqualsZero) return false;

                                const timerInner = DrillValidators.getInnerBlocks(repeatUntilBlock, allBlocks, 'SUBSTACK');
                                if (timerInner.length !== 2) return false;

                                const waitBlock = timerInner.find(b => b.opcode === 'control_wait');
                                const changeBlock = timerInner.find(b => b.opcode === 'data_changevariableby');
                                if (!waitBlock || !changeBlock) return false;

                                if (String(DrillValidators.getInputValue(waitBlock, 'DURATION', allBlocks)) !== '1') return false;

                                const changeVar = changeBlock.fields?.VARIABLE;
                                if (!changeVar || (changeVar.value !== 'のこりじかん' && changeVar.id !== 'のこりじかん')) return false;
                                if (String(DrillValidators.getInputValue(changeBlock, 'VALUE', allBlocks)) !== '-1') return false;

                                // --- 2. ネコ側 (subSequence) ---
                                const [styleItem, catRepeatItem] = subSequence;
                                const styleBlock = allBlocks[styleItem.blockId];
                                const catRepeatBlock = allBlocks[catRepeatItem.blockId];

                                // 2-1. かいてんほうほうを さゆうのみ にする
                                if (styleBlock?.opcode !== 'motion_setrotationstyle') return false;
                                if (styleBlock?.fields?.STYLE?.value !== 'left-right') return false;

                                // 2-2. 「のこりじかん」= 0 になるまで くりかえす
                                if (catRepeatBlock?.opcode !== 'control_repeat_until' || !catRepeatBlock.inputs) return false;

                                const catCondBlock = allBlocks[catRepeatBlock.inputs.CONDITION?.block];
                                if (catCondBlock?.opcode !== 'operator_equals' || !catCondBlock.inputs) return false;

                                const cOp1 = allBlocks[catCondBlock.inputs.OPERAND1?.block];
                                const cOp2 = allBlocks[catCondBlock.inputs.OPERAND2?.block];
                                const cVal1 = DrillValidators.getInputValue(catCondBlock, 'OPERAND1', allBlocks);
                                const cVal2 = DrillValidators.getInputValue(catCondBlock, 'OPERAND2', allBlocks);

                                const isCatTimerZero = (checkVar(cOp1, 'のこりじかん') && String(cVal2) === '0') ||
                                                    (checkVar(cOp2, 'のこりじかん') && String(cVal1) === '0');
                                if (!isCatTimerZero) return false;

                                // 2-3. 内側の「5歩動かす & 端に着いたら跳ね返る」判定にヘルパー関数を使用
                                return DrillValidators.checkMoveBounceLoop(catRepeatItem.blockId, allBlocks);
                            }
                        }
                    ]
                }
            ]
        }

        // ブロックの定義
        getInfo () {
            return {
                id: 'drill',
                name: 'ドリル',
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
                        opcode: 'codeStart_2',
                        blockType: Scratch.BlockType.HAT,
                        text: 'ここから かきはじめる(2)',
                        isEdgeActivated: false 
                    },
                    {
                        opcode: 'handleTestRun',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'テストラン'
                    },
                    {
                        opcode: 'handlePassClick',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'パス'
                    },
                    {
                        opcode: 'checkAnswer',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'こたえあわせをする'
                    }
                ]
            };
        }
        
        getQueryParam (key) {
            const loc = typeof window !== 'undefined' ? window.location : (typeof location !== 'undefined' ? location : null);
            if (!loc || !loc.search) return null;
            return new URLSearchParams(loc.search).get(key);
        }

        async initFromQueryParams () {
            this.studentId = this.getQueryParam('studentId');
            this.drillSetCode = this.getQueryParam('code');
            this.isDev = this.getQueryParam('dev');

            console.log('Loaded student id:', this.studentId, 'and drill set code:', this.drillSetCode);
            if (this.isDev) console.log('DEV MODE');

            // code パラメータが指定されていない場合のガード
            if (!this.drillSetCode || !this.studentId) {
                if (!this.drillSetCode) console.error('[Drill] drillSetCode (code parameter) is missing in URL.');
                if (!this.studentId) console.error('[Drill] student ID is missing in URL.');
                this.sayFromJudge('この リンクでは ドリルが できません。');
                return;
            }

            // 非同期ロード処理を Promise として保持（他メソッドから await できるようにする）
            this.loadQuestionsPromise = (async () => {
                try {
                    // APIエンドポイントのURL
                    const apiUrl = `api/external/drill-sets/${encodeURIComponent(this.drillSetCode)}/questions`;

                    const response = await fetch(apiUrl, {
                        method: 'GET',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }

                    // 取得した問題オブジェクトをセット
                    const data = await response.json();

                    // questions オブジェクトを配列に変換（有効なものだけ抽出 & ID昇順で並び替え）
                    this.questions = Object.values(data.questions)
                        .filter(q => q.is_active)
                        .sort((a, b) => a.id - b.id);
                } catch (error) {
                    console.error('[Drill] Failed to fetch questions:', error);
                    // 必要に応じてフォールバック（デフォルト問題など）を設定
                    this.questions = this.questionObjects[0].questions;
                    // throw error;
                }
            })();
        }

        async setupInitialQuestion () {
            // API からの取得が終わるまで待機
            if (this.loadQuestionsPromise) {
                try {
                    await this.loadQuestionsPromise;
                } catch (e) {
                    // 通信エラー時のアナウンス
                    // const { judge } = this.getTargets();
                    // const activeJudge = judge || this.runtime.stage;
                    // this.runtime.emit('SAY', activeJudge, 'say', 'もんだいの よみこみに しっぱいしました。\nページを さいよみこみ してね！');
                    // return;
                }
            }

            if (!this.questions || this.questions.length === 0) {
                console.warn('[Drill] No questions available.');
                return;
            }

            setTimeout(() => {
                this.startDrill();
            }, this.isDev ? 15000: 1000);
        }

        codeStart   (args, util) { return true; }
        codeStart_2 (args, util) { return true; }

        // 3つのスプライト（審査員、再生ボタン、ネコ）を自動識別
        getTargets (args, util) {
            let judge = null;
            let playButton = null;
            let passButton = null;
            let cat = null;
            let post = null;

            for (const target of this.runtime.targets) {
                if (target.isStage) continue;
                
                const blocks = target.blocks._blocks;
                let hasCheckAnswer = false;
                let hasTestRun = false;
                let hasPass = false;
                let hasHat = false;

                for (const id in blocks) {
                    if (blocks[id].opcode === 'drill_checkAnswer') hasCheckAnswer = true;
                    if (blocks[id].opcode === 'drill_handleTestRun') hasTestRun = true;
                    if (blocks[id].opcode === 'drill_handlePassClick') hasPass = true;
                    if (blocks[id].opcode === 'drill_codeStart' || blocks[id].opcode === 'drill_codeStart_2') hasHat = true;
                }

                if (hasCheckAnswer) judge = target;
                else if (hasTestRun) playButton = target;
                else if (hasPass) passButton = target;
                else if (hasHat) cat = target;
                else post = target;
            }
            return { cat, playButton, passButton, judge, post };
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

        sayFromJudge (text) {
            const { judge } = this.getTargets();
            if (judge) {
                this.runtime.emit('SAY', judge, 'say', text);
            }
        }

        async startDrill (args) {
            this.sayFromJudge('ドリル スタート！');

            // ステージにある音声を終わるまで再生
            const stage = this.runtime.getTargetForStage();
            if (!stage) return;
            if (stage.sprite && stage.sprite.sounds) {
                const startSound = stage.sprite.sounds.find(s => s.name === 'start');
                const soundBank = stage.sprite.soundBank;

                if (startSound && soundBank) {
                    // soundBank.playSound は再生終了まで待機する Promise を返します
                    await soundBank.playSound(stage, startSound.soundId);
                }
            }
            // 2秒後にドリル開始
            setTimeout(() => {
                this.initializeSprites();
                this.keepCatInBack();
                this.currentQuestionIndex = 0;
                this.askCurrentQuestion();
            }, 2000);
        }

        askCurrentQuestion (args, util) {
            if (this.currentQuestionIndex >= this.questions.length) {
                this.clear();
                return;
            }
            const q = this.questions[this.currentQuestionIndex];
            this.sayFromJudge(`【だい ${this.currentQuestionIndex + 1} もん】\n${q.title}`);
        }

        async clear () {
            const stage = this.runtime.getTargetForStage();
            if (!stage) return;

            // 1. 背景を 'clear' に切り替える
            const costumes = stage.getCostumes();
            const clearIndex = costumes.findIndex(c => c.name === 'clear');
            if (clearIndex !== -1) {
                stage.setCostume(clearIndex);
            }

            this.sayFromJudge(`[${this.formatId(this.selectedQuestionObj.id)}] ${this.selectedQuestionObj.questions.length}もん\nぜんもんせいかい！\nおめでとう！`);

            // 2. ステージにある音声を終わるまで再生
            if (stage.sprite && stage.sprite.sounds) {
                const clearSound = stage.sprite.sounds.find(s => s.name === 'clear');
                const soundBank = stage.sprite.soundBank;

                if (clearSound && soundBank) {
                    // soundBank.playSound は再生終了まで待機する Promise を返します
                    await soundBank.playSound(stage, clearSound.soundId);
                }
            }

            // 3. 裏で走るタイマーを止める
            this.stopCatBack();
            this.stopVarCheck();
        }

        /**
         * パスボタンの状態・タイマーを初期状態（コスチューム 0）にリセット
         */
        resetPassState () {
            // 5秒タイマーの解除
            if (this._passTimer) {
                clearTimeout(this._passTimer);
                this._passTimer = null;
            }

            this.initializeSprites();
        }

        /**
         * パスボタンがクリックされた時のハンドラー
         */
        handlePassClick (args, util) {
            const { passButton } = this.getTargets();
            const activePassButton = passButton || util.target;
            if (!activePassButton) return;

            // ----------------------------------------------------
            // 1回目クリック：通常ボタン（コスチューム 0）のとき
            // ----------------------------------------------------
            if (activePassButton.currentCostume === 0) {
                // コスチューム 1（確認メッセージ）へ切り替え
                activePassButton.setCostume(1);
                activePassButton.setXY(0, 0);
                activePassButton.goToFront();

                // 5秒間何もしなければ自動で元に戻す
                if (this._passTimer) clearTimeout(this._passTimer);
                this._passTimer = setTimeout(() => {
                    this.resetPassState();
                }, 5000);

                return;
            }

            // ----------------------------------------------------
            // 2回目クリック：確認メッセージ（コスチューム 1）のとき
            // ----------------------------------------------------
            if (activePassButton.currentCostume === 1) {
                // タイマー解除＆コスチュームを 0 に戻す
                this.resetPassState();

                // パス確定処理（次の問題へ進む）
                this.executePass();
            }
        }

        /**
         * パス実行時の処理
         */
        async executePass () {
            const { judge } = this.getTargets();
            const activeJudge = judge || util.target;
            const soundBank = activeJudge?.sprite?.soundBank;
            const sounds = activeJudge?.sprite?.sounds || [];
            const passSound = sounds.find(s => s.name === 'pass');

            this.sayFromJudge('またこんど せいかい できるように がんばろう！');
            if (passSound && soundBank) {
                await soundBank.playSound(activeJudge, passSound.soundId);
            } 
            setTimeout(() => {
                this.currentQuestionIndex++;
                this.initializeSprites();
                this.askCurrentQuestion();
            }, 2500);
        }

        initializeSprites () {
            const stage = this.runtime.getTargetForStage();

            // 背景を 'grid' に切り替える
            const costumes = stage.getCostumes();
            const gridIndex = costumes.findIndex(c => c.name === 'grid');
            if (gridIndex !== -1) {
                stage.setCostume(gridIndex);
            }

            const { cat, playButton, passButton, judge, post } = this.getTargets();
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
            if (passButton) {
                passButton.setXY(-190, 105);
                passButton.setDirection(90);
                passButton.setSize(100);
                passButton.setVisible(true);  
                passButton.setCostume(0);
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

        // ネコのスプライトを常に最背面に維持する
        keepCatInBack () {
            // 前回のタイマーが残っていればクリア
            this.stopCatBack();

            // 100msごとにネコを最背面に移動
            this._catBackInterval = setInterval(() => {
                const { cat } = this.getTargets();
                if (cat && typeof cat.goToBack === 'function') {
                    cat.goToBack();
                }
            }, 100);
        }

        handleTestRun (args, util) {
            const { playButton } = this.getTargets();
            if (!playButton) {
                console.log('テストランボタンが見つかりません');
                return;
            }

            // 最初のコスチューム（0）ならテスト実行、それ以外なら停止
            if (playButton.currentCostume === 0) {
                this.doTestRun(args, util);
            } else {
                this.stopTestRun(args, util);
            }
        }

        doTestRun (args, util) {
            const { cat, playButton } = this.getTargets();

            if (cat) {
                // 1. スプライトと変数を初期化
                this.initializeSprites();

                // 2.1. 監視したい変数名を配列で指定
                const targetVars = ['のこりじかん', 'ランダム'];
                const pendingVars = new Set(targetVars);

                // 2.2. 前回の変数監視タイマーが残っていればクリア
                this.stopVarCheck();

                // 2.3. 100msごとに変数を監視
                this._varCheckInterval = setInterval(() => {
                    pendingVars.forEach(varName => {
                        const val = this.getVariableValueByName(varName);
                        // console.log(`Now ${varName} is `, val);

                        // 初期値(-1)以外に変更されたら表示し、監視対象から外す
                        if (val !== null && val !== -1 && val !== '-1') {
                            this.setVariableVisible(varName, true);
                            pendingVars.delete(varName);
                        }
                    });

                    // すべての変数が変更・表示されたら監視終了
                    if (pendingVars.size === 0) {
                        this.stopVarCheck();
                    }
                }, 100);

                // 3. 掛け声演出とハットブロックの起動処理
                this.sayFromJudge('');
                this.runtime.emit('SAY', playButton, 'say', 'いくよ！せーの');

                if (this._testRunTimeout) clearTimeout(this._testRunTimeout);
                this._testRunTimeout = setTimeout(() => {
                    this.runtime.emit('SAY', playButton, 'say', '');
                    playButton.setCostume(1);
                    this.runtime.startHats('drill_codeStart', null, cat);
                    this.runtime.startHats('drill_codeStart_2', null, cat);
                }, 1500);
            }
        }

        stopTestRun (args, util) {
            const { playButton } = this.getTargets();

            // コスチュームを 0（再生アイコン）へ戻す
            if (playButton) {
                playButton.setCostume(0);
                this.runtime.emit('SAY', playButton, 'say', '');
            }
            // 「せーの」のタイマー停止
            if (this._testRunTimeout) {
                clearTimeout(this._testRunTimeout);
                this._testRunTimeout = null;
            }

            this.stopVarCheck();
            this.initializeSprites();

            // 問題文の再掲
            this.askCurrentQuestion();
        }

        stopVarCheck () {
            if (this._varCheckInterval) {
                clearInterval(this._varCheckInterval);
                this._varCheckInterval = null;
            }
        }

        stopCatBack () {
            if (this._catBackInterval) {
                clearInterval(this._catBackInterval);
                this._catBackInterval = null;
            }
        }

        async checkAnswer (args, util) {
            const { cat, judge } = this.getTargets();
            const activeJudge = judge || util.target;

            this.stopVarCheck();
            
            // activeJudge.sprite から sounds と soundBank を取得
            const sounds = activeJudge?.sprite?.sounds || [];
            const correctSound = sounds.find(s => s.name === 'correct');
            const wrongSound = sounds.find(s => s.name === 'wrong');
            const soundBank = activeJudge?.sprite?.soundBank;

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

            // ハットブロックのIDからブロック系列を取得するヘルパー関数
            const getSequenceFromHatId = (hatId) => {
                if (!hatId) return [];
                const sequence = [];
                let currentId = blocks[hatId].next;
                while (currentId) {
                    const block = blocks[currentId];
                    if (!block) break;
                    sequence.push({ opcode: block.opcode, blockId: currentId });
                    currentId = block.next;
                }
                return sequence;
            };

            // 各ハットブロックの配置されているIDをすべて取得
            const hat1Ids = Object.keys(blocks).filter(id => blocks[id].opcode === 'drill_codeStart');
            const hat2Ids = Object.keys(blocks).filter(id => blocks[id].opcode === 'drill_codeStart_2');

            if (hat1Ids.length === 0 && hat2Ids.length === 0) {
                // 1. どちらも置かれていない場合
                this.runtime.emit('SAY', activeJudge, 'say', 'ネコに「ここから かきはじめる」ブロックをおいて、\nそのしたにプログラムを つくってね！');
            } else if (hat1Ids.length > 1 || hat2Ids.length > 1) {
                // 2. 同じハットブロックが2つ以上置かれている場合
                this.runtime.emit('SAY', activeJudge, 'say', 'おなじ「ここから かきはじめる」ブロックが\n2つ以上 あるよ！ 1つにしてね！');
            } else {
                // 3. 正常系（1が1つ / 2が1つ / どちらも1つずつ）
                // 評価（片方をメイン、他方をサブのシーケンスとして扱う）
                const seq1 = getSequenceFromHatId(hat1Ids[0]);
                const seq2 = getSequenceFromHatId(hat2Ids[0]);
                const isCorrect = currentQuestion.validate(seq1, seq2, blocks)
                               || currentQuestion.validate(seq2, seq1, blocks);
                
                if (isCorrect) {
                    this.runtime.emit('SAY', activeJudge, 'say', 'せいかい！\nつぎにすすむよ！');
                    activeJudge.setCostume(1);
                    if (correctSound && soundBank) {
                        await soundBank.playSound(activeJudge, correctSound.soundId);
                    } 
                    this.currentQuestionIndex++;
                } else {
                    this.runtime.emit('SAY', activeJudge, 'say', 'ざんねん！\nもういちど かくにんしてみてね');
                    activeJudge.setCostume(2);
                    if (wrongSound && soundBank) {
                        await soundBank.playSound(activeJudge, wrongSound.soundId);
                    }
                }
            }
                
            setTimeout(() => {
                this.initializeSprites();
                this.askCurrentQuestion();
            }, 2500);
        }
    }

    Scratch.extensions.register(new Scratch3Drill(runtime));

})(Scratch);
