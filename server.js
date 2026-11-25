const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DB_PATH = path.join(__dirname, 'database.json');
const MAX_TEST_SETS = 300;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

function readDB() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const initial = { tests: {}, users: {} };
            fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), 'utf8');
            return initial;
        }
        const raw = fs.readFileSync(DB_PATH, 'utf8').trim();
        if (!raw) return { tests: {}, users: {} };
        const parsed = JSON.parse(raw);
        return {
            tests: parsed.tests && typeof parsed.tests === 'object' ? parsed.tests : {},
            users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {}
        };
    } catch (err) {
        console.error('Bazani o‘qishda xato:', err.message);
        return { tests: {}, users: {} };
    }
}

function writeDB(data) {
    const tempPath = DB_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, DB_PATH);
}

function generateUniqueCode(testsObj) {
    let code = '';
    do {
        code = String(Math.floor(100000 + Math.random() * 900000));
    } while (testsObj[code]);
    return code;
}

function parseDocxText(rawText) {
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const parsed = [];
    let current = null;

    for (const line of lines) {
        const qMatch = line.match(/^(?:\d+[\)\.\-]|savol\s*\d*[:\.\-]?)\s*(.+)$/i);
        const optMatch = line.match(/^([*+]?)\s*([A-Da-d])[\)\.\:\-]\s*(.+)$/);

        if (optMatch && current) {
            const hasStarPrefix = Boolean(optMatch[1]);
            let optText = optMatch[3].trim();
            const hasStarSuffix = /(\*|\(\+\))$/.test(optText);
            if (hasStarSuffix) {
                optText = optText.replace(/(\*|\(\+\))$/, '').trim();
            }
            if (hasStarPrefix || hasStarSuffix) {
                current.correct = current.opts.length;
            }
            if (current.opts.length < 4) {
                current.opts.push(optText);
            }
        } else if (qMatch) {
            if (current && current.q && current.opts.length === 4 && current.correct !== null) {
                parsed.push(current);
            }
            current = { q: qMatch[1].trim(), opts: [], correct: null };
        } else if (current && current.opts.length === 0) {
            current.q += ' ' + line;
        }
    }

    if (current && current.q && current.opts.length === 4 && current.correct !== null) {
        parsed.push(current);
    }

    return parsed;
}

function parseExcelRows(rows) {
    const parsed = [];
    const letterToIdx = { A: 0, B: 1, C: 2, D: 3 };

    for (const row of rows) {
        if (!Array.isArray(row) || row.length < 6) continue;
        const q = String(row[0] ?? '').trim();
        const opts = [0, 1, 2, 3].map(i => String(row[i + 1] ?? '').trim());
        const ansRaw = String(row[5] ?? '').trim().toUpperCase();
        const correct = letterToIdx[ansRaw];

        if (q && opts.every(Boolean) && correct !== undefined) {
            parsed.push({ q, opts, correct });
        }
    }

    return parsed;
}

app.get('/api/my-test/:userId', (req, res) => {
    const userId = String(req.params.userId || '').trim();
    const db = readDB();
    const code = db.users[userId];
    if (!code || !db.tests[code]) {
        return res.json({ success: true, test: null });
    }
    return res.json({
        success: true,
        test: { code, ...db.tests[code] }
    });
});

app.get('/api/test/:code', (req, res) => {
    const code = String(req.params.code || '').trim();
    const db = readDB();
    const test = db.tests[code];
    if (!test) {
        return res.status(404).json({ success: false, message: 'Bunday kodli test topilmadi!' });
    }
    return res.json({
        success: true,
        test: { code, ...test }
    });
});

app.delete('/api/test/:code', (req, res) => {
    const code = String(req.params.code || '').trim();
    const db = readDB();
    if (!db.tests[code]) {
        return res.status(404).json({ success: false, message: 'Test topilmadi!' });
    }

    const ownerId = db.tests[code].ownerId;
    delete db.tests[code];
    if (ownerId && db.users[ownerId] === code) {
        delete db.users[ownerId];
    }

    writeDB(db);
    return res.json({ success: true });
});

app.post('/api/save-test', (req, res) => {
    try {
        const body = req.body || {};
        const ownerId = String(body.ownerId || 'local_guest').trim();
        const title = String(body.title || '').trim();
        const questions = Array.isArray(body.questions) ? body.questions : [];
        const solveCount = Math.max(1, Math.min(parseInt(body.solveCount, 10) || questions.length, questions.length));
        const timeMinutes = Math.max(1, Math.min(parseInt(body.timeMinutes, 10) || 30, 300));
        const showEndMistakes = body.showEndMistakes !== false;
        const showInstantAnswer = Boolean(body.showInstantAnswer);

        if (!title) {
            return res.status(400).json({ success: false, message: 'Test nomini kiriting!' });
        }
        if (questions.length < 1) {
            return res.status(400).json({ success: false, message: 'Kamida 1 ta savol bo‘lishi kerak!' });
        }

        const cleanQuestions = [];
        for (const item of questions) {
            const q = String(item?.q || '').trim();
            const opts = Array.isArray(item?.opts) ? item.opts.map(o => String(o || '').trim()) : [];
            const correct = Number.isInteger(item?.correct) ? item.correct : parseInt(item?.correct, 10);

            if (!q || opts.length !== 4 || opts.some(o => !o) || ![0, 1, 2, 3].includes(correct)) {
                return res.status(400).json({
                    success: false,
                    message: 'Har bir savolda matn, 4 ta variant va to‘g‘ri javob bo‘lishi shart!'
                });
            }
            cleanQuestions.push({ q, opts, correct });
        }

        const db = readDB();
        const existingCode = body.code && db.tests[body.code] ? String(body.code) : db.users[ownerId];
        const isUpdate = Boolean(existingCode && db.tests[existingCode]);

        if (!isUpdate && Object.keys(db.tests).length >= MAX_TEST_SETS) {
            return res.status(400).json({
                success: false,
                message: `Maksimal ${MAX_TEST_SETS} ta test jamlanmasiga ruxsat berilgan!`
            });
        }

        const code = isUpdate ? existingCode : generateUniqueCode(db.tests);

        db.tests[code] = {
            ownerId,
            title,
            solveCount,
            timeMinutes,
            showEndMistakes,
            showInstantAnswer,
            questions: cleanQuestions,
            updatedAt: new Date().toISOString()
        };
        db.users[ownerId] = code;

        writeDB(db);
        return res.json({ success: true, code });
    } catch (err) {
        console.error('Test saqlashda xato:', err);
        return res.status(500).json({ success: false, message: 'Serverda ichki xatolik yuz berdi!' });
    }
});

app.post('/api/import-file', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Fayl tanlanmadi!' });
        }

        const ext = path.extname(req.file.originalname || '').toLowerCase();
        let questions = [];

        if (ext === '.docx') {
            const result = await mammoth.extractRawText({ buffer: req.file.buffer });
            questions = parseDocxText(result.value || '');
        } else if (ext === '.xlsx' || ext === '.xls') {
            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
            questions = parseExcelRows(rows);
        } else {
            return res.status(400).json({ success: false, message: 'Faqat .docx yoki .xlsx fayllar qabul qilinadi!' });
        }

        if (!questions.length) {
            return res.status(400).json({
                success: false,
                message: 'Fayldan to‘g‘ri formatdagi savollar topilmadi!'
            });
        }

        return res.json({ success: true, questions });
    } catch (err) {
        console.error('Faylni o‘qishda xato:', err);
        return res.status(500).json({ success: false, message: 'Faylni o‘qishda xatolik yuz berdi!' });
    }
});

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    if (!BOT_TOKEN || typeof fetch !== 'function') return;

    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = String(msg?.text || '').trim();
    if (!chatId || text !== '/start') return;

    const appUrl = `${req.protocol}://${req.get('host')}/?uid=${msg.from?.id || chatId}`;

    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: 'Testora platformasiga xush kelibsiz! Test tuzish yoki kod orqali test ishlash uchun pastdagi tugmani bosing:',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🚀 Testora Web App', web_app: { url: appUrl } }
                    ]]
                }
            })
        });
    } catch (err) {
        console.error('Telegram xabar yuborishda xato:', err.message);
    }
});

app.use((err, req, res, next) => {
    console.error('Umumiy xato:', err.message);
    res.status(400).json({ success: false, message: err.message || 'So‘rovni bajarib bo‘lmadi!' });
});

app.listen(PORT, () => {
    console.log(`Testora serveri ${PORT}-portda ishga tushdi.`);
});