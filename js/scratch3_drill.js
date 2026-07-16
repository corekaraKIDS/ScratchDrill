(function(Scratch) {
    'use strict';

    // サンドボックスモードのチェック
    if (typeof window === 'undefined' || !Scratch.vm) {
        const errorMsg = "【自動採点ドリル】\nこの拡張機能は「サンドボックスなし」で読み込む必要があります。\nURLに「?unsandboxed-extension=」が含まれているか確認してください。";
        // 1. もし画面がある環境（通常のブラウザ画面）ならアラートを出す
        if (typeof window !== 'undefined') {
            alert(errorMsg);
        }
        // 2. 画面がない環境（サンドボックス内）でも、TurboWarpのUIにエラーを強制表示させる
        throw new Error(errorMsg);
    }

    const runtime = Scratch.vm.runtime;

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
                        if (userSequence.length === 0) return false;
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
                        if (userSequence.length === 0) return false;
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
                        if (userSequence.length === 0) return false;
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
                        if (userSequence.length < 3) return false;
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
                        if (userSequence.length < 3) return false;
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
                        if (userSequence.length === 0) return false;
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
                        if (userSequence.length === 0) return false;
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
                        if (userSequence.length === 0) return false;
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
                        if (userSequence.length < 3) return false;
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
                        if (userSequence.length < 3) return false;
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
                else if (!cat) {
                    cat = target;
                }
            }
            return {judge, playButton, cat};
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
            const {judge} = this.getTargets();
            if (judge) {
                this.runtime.emit('SAY', judge, 'say', text);
            }
        }

        initializeCat () {
            const { cat } = this.getTargets();
            if (cat) {
                this.runtime.stopForTarget(cat);
                cat.setXY(0, 0);
                cat.setDirection(90);
            }
        }

        testRun (args, util) {
            const { playButton, cat } = this.getTargets();
            const activePlayButton = playButton || util.target;
            
            if (cat) {
                this.initializeCat();

                this.sayFromJudge('')
                this.runtime.emit('SAY', activePlayButton, 'say', 'いくよ！せーの');

                setTimeout(() => {
                    this.runtime.emit('SAY', activePlayButton, 'say', '');
                    this.runtime.startHats('drill_codeStart', null, cat);
                }, 1500);
            }
        }

        checkAnswer (args, util) {
            const {judge, cat} = this.getTargets();
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
                this.initializeCat();
                this.askCurrentQuestion();
            }, 2500);
        }
    }

    Scratch.extensions.register(new Scratch3Drill(runtime));

})(Scratch);