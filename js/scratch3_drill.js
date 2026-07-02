(function(Scratch) {
    'use strict';

    // 【重要】非サンドボックスモードのチェック
    if (!Scratch.vm) {
        alert("【自動採点ドリル】\nこの拡張機能は「サンドボックスなし」で読み込む必要があります。\nファイルの読み込み時に「サンドボックスなしで拡張機能を実行する」にチェックを入れてください。");
        return;
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
                    title: 'ネコを【10ほ】うごかしてみよう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length === 0) return false;
                        const first = userSequence[0];
                        if (first.opcode !== 'motion_movesteps') return false;
                        const numBlockId = allBlocks[first.blockId].inputs.STEPS.block;
                        return allBlocks[numBlockId].fields.NUM.value === '10';
                    }
                },
                {
                    id: 2,
                    title: 'つぎは、ネコを【30ほ】うごかしてみよう！',
                    validate: (userSequence, allBlocks) => {
                        if (userSequence.length === 0) return false;
                        const first = userSequence[0];
                        if (first.opcode !== 'motion_movesteps') return false;
                        const numBlockId = allBlocks[first.blockId].inputs.STEPS.block;
                        return allBlocks[numBlockId].fields.NUM.value === '30';
                    }
                }
            ];

            // 【緑の旗が押されたとき】問題インデックスを初期化して出題
            this.runtime.on('PROJECT_START', () => {
                this.currentQuestionIndex = 0;
                this.askCurrentQuestion();
            });
        }

        // ブロックの定義（ハットブロック、テストラン、答え合わせ）
        getInfo () {
            return {
                id: 'drill',
                name: '自動採点ドリル',
                color1: '#000000',
                color2: '#000000',
                color3: '#000000',
                blocks: [
                    {
                        opcode: 'whenDrillStart',
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
                        opcode: 'checkAnswer',
                        blockType: Scratch.BlockType.COMMAND,
                        text: 'こたえあわせをする'
                    }
                ]
            };
        }

        whenDrillStart (args, util) {
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
                    if (blocks[id].opcode === 'drill_whenDrillStart') hasHat = true;
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

        askCurrentQuestion (args, util) {
            if (this.currentQuestionIndex >= this.questions.length) {
                this.sayFromJudge('全問正解！すべての問題をクリアしたよ！おめでとう！');
                return;
            }
            const q = this.questions[this.currentQuestionIndex];
            this.sayFromJudge(`【第 ${q.id} 問】\n${q.title}`);
        }

        sayFromJudge (text) {
            const {judge} = this.getTargets();
            if (judge) {
                this.runtime.emit('SAY', judge, 'say', text);
            }
        }

        testRun (args, util) {
            const { playButton, cat } = this.getTargets();
            const activePlayButton = playButton || util.target;
            
            if (cat) {
                this.runtime.stopForTarget(cat);
                cat.setXY(0, 0);
                cat.setDirection(90);

                this.runtime.emit('SAY', activePlayButton, 'say', 'いくよ！せーの');

                setTimeout(() => {
                    this.runtime.emit('SAY', activePlayButton, 'say', '');
                    this.runtime.startHats('drill_whenDrillStart', null, cat);
                }, 1000);
            }
            this.askCurrentQuestion();
        }

        checkAnswer (args, util) {
            const {judge, cat} = this.getTargets();
            const activeJudge = judge || util.target;

            if (!cat) {
                this.runtime.emit('SAY', activeJudge, 'say', 'ネコのスプライトが見つかりません');
                return;
            }

            if (this.currentQuestionIndex >= this.questions.length) {
                this.runtime.emit('SAY', activeJudge, 'say', 'すべての問題はクリア済みだよ！');
                return;
            }

            const currentQuestion = this.questions[this.currentQuestionIndex];
            const blocks = cat.blocks._blocks;

            let hatBlockId = null;
            for (const id in blocks) {
                if (blocks[id].opcode === 'drill_whenDrillStart') {
                    hatBlockId = id;
                    break;
                }
            }

            if (!hatBlockId) {
                this.runtime.emit('SAY', activeJudge, 'say', 'ネコに「ここから書き始める」ブロックを置いて、その下にプログラムを作ってね！');
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
                this.runtime.emit('SAY', activeJudge, 'say', '正解！次の問題に進むよ！');
                this.currentQuestionIndex++;
                
                setTimeout(() => {
                    this.askCurrentQuestion();
                }, 2500);
            } else {
                this.runtime.emit('SAY', activeJudge, 'say', '残念！もう一度確認してみてね');
            }
        }
    }

    Scratch.extensions.register(new Scratch3Drill(runtime));

})(Scratch);