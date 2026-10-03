// 使用法: `node ./dev_tools/printQuestions.js`

const fs = require('fs');
const path = require('path');

const inputFilePath = path.join(__dirname, '../js/scratch3_drill.js');
const outputFilePath = path.join(__dirname, 'questions.csv');

const fileContent = fs.readFileSync(inputFilePath, 'utf8');

// 1. "this.questionObjects =" の開始位置を探す
const startTarget = 'this.questionObjects =';
const startIdx = fileContent.indexOf(startTarget);

if (startIdx === -1) {
    console.error('this.questionObjects が見つかりませんでした。');
    process.exit(1);
}

// 2. 配列の開始カッコ '[' から対応する閉じカッコ ']' までを正確に抽出
const bracketStart = fileContent.indexOf('[', startIdx);
let depth = 0;
let bracketEnd = -1;

for (let i = bracketStart; i < fileContent.length; i++) {
    if (fileContent[i] === '[') depth++;
    else if (fileContent[i] === ']') {
        depth--;
        if (depth === 0) {
            bracketEnd = i;
            break;
        }
    }
}

if (bracketEnd === -1) {
    console.error('questionObjects の閉じカッコが見つかりませんでした。');
    process.exit(1);
}

const arrayCode = fileContent.substring(bracketStart, bracketEnd + 1);

// 3. JavaScriptオブジェクトとして動的に評価・読み込み
let questionObjects = [];
try {
    questionObjects = new Function(`return ${arrayCode}`)();
} catch (err) {
    console.error('questionObjects の評価に失敗しました:', err);
    process.exit(1);
}

// 4. CSV行の構築
const csvRows = ['id,q_index,title,id_old'];

questionObjects.forEach(qObj => {
    const id = qObj.id;
    if (Array.isArray(qObj.questions)) {
        qObj.questions.forEach((q, idx) => {
            let title = q.title || '';
            const id_old = q.id_old || -1;
            
            // 改行（\n および実際の改行）を半角スペースに置換
            title = title.replace(/\\n/g, ' ').replace(/\n/g, ' ');
            
            // CSVダブルクォーテーションのエスケープ処理
            const escapedTitle = title.replace(/"/g, '""');
            
            csvRows.push(`${id},${idx + 1},"${escapedTitle}",${id_old}`);
        });
    }
});

// 5. BOM付きUTF-8でファイル出力（Excelでの文字化け防止）
const csvContent = '\uFEFF' + csvRows.join('\n');
fs.writeFileSync(outputFilePath, csvContent, 'utf8');

console.log(`全 ${csvRows.length - 1} 件の問題文を questions.csv に出力しました！`);