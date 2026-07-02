# ScratchDrill
Scratchの理解度向上のためのドリル教材

## About
- プログラミング検定のように、実現したい挙動が出題され、それに合ったビジュアルプログラムを作成する。
- 漢字を使わずに制作する。

## 使い方
- 拡張機能込みで Turbowarp を起動する。
    - URL内でこのプロジェクトの `./js/scratch3_drill.js` と `./sb3/scratch3_drill.sb3` を指定し、呼び出す。
    - リンクはこのようになる: https://turbowarp.org/editor?project_url=https://corekarakids.github.io/ScratchDrill/sb3/scratch3_drill.sb3&unsandboxed-extension=https://corekarakids.github.io/ScratchDrill/js/scratch3_drill.js
    - サンドボックス環境を使わないことを許可する。
    - プログラムを書き込むネコ、テストランボタン、審査員の3つのスプライトが含まれている。
- 緑の旗を押すとドリルが開始され、設問が順番に出題される。
    - 審査員のセリフにしたがって進める
    - ネコに書いたプログラムは、テストランボタンでテストランすることができる
    - 審査員スプライトをクリックすると正誤判定がなされる

## 開発者の方へ
- ご自身を Collaborator に招待してください。
- プロジェクトを pull して、適当にブランチを切って開発してください。
- `./js/scratch3_drill.js` 内の `this.questions` で設問を作成できます。
- 開発したものを [このリンク](https://turbowarp.org/editor?project_url=https://corekarakids.github.io/ScratchDrill/sb3/scratch3_drill.sb3&unsandboxed-extension=https://corekarakids.github.io/ScratchDrill/js/scratch3_drill.js) で使うには main ブランチにプッシュしなければなりません。テストする場合は、以下の手順を踏んでください。
    1. [Turbowarp エディタ](https://turbowarp.org/editor) を開く
    1. 左のメニューバーの最下部「拡張機能」から「カスタム拡張機能」を選択
    1. 「ファイル」のモードで、開発中のjsファイルをドラッグ＆ドロップし、**「サンドボックスなしで実行」を選択**
    1. 拡張機能の読み込みが完了したら、sb3ファイルを読み込む。
- プルリクエストを送り、 GitHub 上の main ブランチに反映してください。  
