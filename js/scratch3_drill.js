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
                    const BASE_URL = 'https://your-domain.com'; // APIサーバーのドメイン！！！
                    const apiUrl = `${BASE_URL}/api/external/drill-sets/${encodeURIComponent(this.drillSetCode)}/questions`;

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

                    this.drillSetId = data.drill_set_id;
                    this.questions = Object.values(data.questions)
                        .sort((a, b) => a.id - b.id);
                } catch (error) {
                    console.error('[Drill] Failed to fetch questions:', error);
                    // 必要に応じてフォールバック（デフォルト問題など）を設定
                    this.questions = [
                        {
                            "id": 1,
                            "drill_set_id": 1,
                            "question": { 
                                text: 'ネコを 100ほ うごかそう！',
                                validate: (mainSequence, subSequence, allBlocks) => {
                                    if (mainSequence.length !== 1) return false;
                                    if (subSequence.length !== 0) return false;
                                    const [first] = mainSequence;
                                    if (first.opcode !== 'motion_movesteps') return false;
                                    return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) === '100';
                                } 
                            },
                            "is_active": true
                        },
                        {
                            "id": 2,
                            "drill_set_id": 1,
                            "question": { 
                                text: 'ネコを 200ほ うごかそう！',
                                validate: (mainSequence, subSequence, allBlocks) => {
                                    if (mainSequence.length !== 1) return false;
                                    if (subSequence.length !== 0) return false;
                                    const [first] = mainSequence;
                                    if (first.opcode !== 'motion_movesteps') return false;
                                    return String(DrillValidators.getInputValue(allBlocks[first.blockId], 'STEPS', allBlocks)) === '200';
                                } 
                            },
                            "is_active": true
                        },
                        {
                            "id": 3,
                            "drill_set_id": 1,
                            "question": { 
                                text: 'ネコを 100ほ うごかして、\n1びょう まってから\nもういちど 100ほ うごかそう！',
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
                            "is_active": true
                        }
                    ]
                    // throw error;
                }
            })();
        }

        async setupInitialQuestion () {
            this.sayFromJudge('よみこみちゅう...');

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
                this.sayFromJudge('');
                this.startDrill();
            }, this.isDev ? 15000: 1000);
        }

        codeStart   (args, util) { return true; }
        codeStart_2 (args, util) { return true; }

        async startDrill (args) {
            this.sayFromJudge('ドリル スタート！');
            this.results = []; // 各問の結果を格納する送信用データ

            // ステージにある音声を終わるまで再生
            const stage = this.runtime.getTargetForStage();
            if (stage && stage.sprite && stage.sprite.sounds) {
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
            this.results.push({ "drill_question_id": this.questions[this.currentQuestionIndex].id, "is_correct": false })

            if (passSound && soundBank) {
                soundBank.playSound(activeJudge, passSound.soundId);
            } 
            setTimeout(() => {
                this.currentQuestionIndex++;
                this.initializeSprites();
                this.askCurrentQuestion();
            }, 2500);
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

            const currentQuestionObj = this.questions[this.currentQuestionIndex];
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
                const isCorrect = currentQuestionObj.question.validate(seq1, seq2, blocks)
                               || currentQuestionObj.question.validate(seq2, seq1, blocks);
                
                if (isCorrect) {
                    this.runtime.emit('SAY', activeJudge, 'say', 'せいかい！\nつぎにすすむよ！');
                    this.results.push({ "drill_question_id": currentQuestionObj.id, "is_correct": true });
                    activeJudge.setCostume(1);
                    if (correctSound && soundBank) {
                        soundBank.playSound(activeJudge, correctSound.soundId);
                    } 
                    this.currentQuestionIndex++;
                } else {
                    this.runtime.emit('SAY', activeJudge, 'say', 'ざんねん！\nもういちど かくにんしてみてね');
                    activeJudge.setCostume(2);
                    if (wrongSound && soundBank) {
                        soundBank.playSound(activeJudge, wrongSound.soundId);
                    }
                }
            }
                
            setTimeout(() => {
                this.initializeSprites();
                this.askCurrentQuestion();
            }, 2500);
        }

        async clear () {            
            // 裏で走るタイマーを止める
            this.stopCatBack();
            this.stopVarCheck();

            this.sayFromJudge("けっかを そうしんちゅう");
            
            // 結果送信データの作成
            const BASE_URL = 'https://your-domain.com'; // APIサーバーのドメイン！！！
            const apiUrl = `${BASE_URL}/api/external/drill-set-attempts`;

            const payload = {
                student_id: this.studentId,
                drill_set_id: this.drillSetId,
                results: this.results
            };
            console.log("JSON to post:", JSON.stringify(payload));

            // 結果のPOST送信
            try {
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const resData = await response.json();
                console.log('[Drill] Attempt posted successfully:', resData);

            } catch (error) {
                console.error('[Drill] Failed to post drill set attempt:', error);
            }

            // 背景を 'clear' に切り替える
            const stage = this.runtime.getTargetForStage();
            if (!stage) console.error("Stage is not found.");

            const costumes = stage.getCostumes();
            const clearIndex = costumes.findIndex(c => c.name === 'clear');
            if (clearIndex !== -1) {
                stage.setCostume(clearIndex);
            }
            
            // ステージにある音声を再生
            if (stage.sprite && stage.sprite.sounds) {
                const clearSound = stage.sprite.sounds.find(s => s.name === 'clear');
                const soundBank = stage.sprite.soundBank;
                
                if (clearSound && soundBank) {
                    // soundBank.playSound は再生終了まで待機する Promise を返します
                    soundBank.playSound(stage, clearSound.soundId);
                }
            }
        }

        askCurrentQuestion (args, util) {
            if (this.currentQuestionIndex >= this.questions.length) {
                this.clear();
                return;
            }
            const q = this.questions[this.currentQuestionIndex].question;
            this.sayFromJudge(`【だい ${this.currentQuestionIndex + 1} もん】\n${q.text}`);
        }

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
    }

    Scratch.extensions.register(new Scratch3Drill(runtime));

})(Scratch);
