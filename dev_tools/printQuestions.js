// 使用法: `node ./dev_tools/printQuestions.js`

const fs = require('fs');
const path = require('path');

// dev_tools から ../js/scratch3_drill.js を参照
const inputFilePath = path.join(__dirname, '../js/scratch3_drill.js');
const outputFilePath = path.join(__dirname, 'questions.txt');

const fileContent = fs.readFileSync(inputFilePath, 'utf8');

// title: '...' や title: `...` を抽出
const titleRegex = /title:\s*(['"`])([\s\S]*?)\1/g;
const titles = [];

let match;
while ((match = titleRegex.exec(fileContent)) !== null) {
    let title = match[2];
    // 改行（\n）および実際の改行を半角スペースに置換
    title = title.replace(/\\n/g, ' ').replace(/\n/g, ' ');
    titles.push(title);
}

// dev_tools フォルダ配下に questions.txt を出力
fs.writeFileSync(outputFilePath, titles.join('\n'), 'utf8');
console.log(`全 ${titles.length} 件の問題文を questions.txt に保存しました！`);