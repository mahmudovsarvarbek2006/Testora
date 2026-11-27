const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_PATH = path.join(__dirname, 'database.json');
const MAX_TEST_SETS = 300;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

// --- MongoDB sxemalari va modellari ---
const questionSchema = new mongoose.Schema({
    q: { type: String, required: true },
    opts: { type: [String], required: true },
    correct: { type: Number, required: true }
}, { _id: false });

const testSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, index: true },
    ownerId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    solveCount: { type: Number, required: true },
    timeMinutes: { type: Number, required: true },
    showEndMistakes: { type: Boolean, default: true },
    showInstantAnswer: { type: Boolean, default: false },
    questions: { type: [questionSchema], required: true },
    updatedAt: { type: String, required: true }
});

const userTestSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true, index: true },
    code: { type: String, required: true }
});

const TestModel = mongoose.model('Test', testSchema);
const UserTestModel = mongoose.model('UserTest', userTestSchema);

let useMongo = false;

async function initDatabase() {
    if (!MONGODB_URI) {
        console.warn('MONGODB_URI topilmadi, vaqtinchalik database.json ishlatiladi.');
        return;
    }
    try {
        await mongoose.connect(MONGODB_URI);
        useMongo = true;
        console.log('MongoDB Atlas muvaffaqiyatli ulandi!');
    } catch (err) {
        console.error('MongoDB ulanishda xato:', err.message);
        console.warn('Zaxira sifatida database.json ishlatiladi.');
    }
}

// --- Lokal JSON zaxira funksiyalari (faqat MONGODB_URI bo‘lmaganda) ---
function readLocalDB() {
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

function writeLocalDB(data) {
    const tempPath = DB_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, DB_PATH);
}

// --- Yagona ma’lumot qatlami (MongoDB yoki lokal JSON) ---
async function getUserTestCode(userId) {
    if (useMongo) {
        const doc = await UserTestModel.findOne({ userId }).lean();
        return doc ? doc.code : null;
    }
    const db = readLocalDB();
    return db.users[userId] || null;
}

async function getTestByCode(code) {
    if (useMongo) {
        const doc = await TestModel.findOne({ code }).lean();
        if (!doc) return null;
        const { _id, __v, ...rest } = doc;
        return rest;
    }
    const db = readLocalDB();
    if (!db.tests[code]) return null;
    return { code, ...db.tests[code] };
}

async function deleteTestByCode(code) {
    if (useMongo) {
        const doc = await TestModel.findOneAndDelete({ code }).lean();
        if (!doc) return false;
        if (doc.ownerId) {
            await UserTestModel.deleteOne({ userId: doc.ownerId, code });
        }
        return true;
    }
    const db = readLocalDB();
    if (!db.tests[code]) return false;
    const ownerId = db.tests[code].ownerId;
    delete db.tests[code];
    if (ownerId && db.users[ownerId] === code) {
        delete db.users[ownerId];
    }
    writeLocalDB(db);
    return true;
}

async function countTests() {
    if (useMongo) {
        return await TestModel.countDocuments();
    }
    const db = readLocalDB();
    return Object.keys(db.tests).length;
}

async function generateUniqueCode() {
    let code = '';
    let exists = true;
    while (exists) {
        code = String(Math.floor(100000 + Math.random() * 900000));
        if (useMongo) {
            exists = Boolean(await TestModel.exists({ code }));
        } else {
            const db = readLocalDB();
            exists = Boolean(db.tests[code]);
        }
    }
    return code;
}

async function saveOrUpdateTest({ ownerId, requestedCode, title, solveCount, timeMinutes, showEndMistakes, showInstantAnswer, questions }) {
    const updatedAt = new Date().toISOString();

    if (useMongo) {
        let targetDoc = null;
        if (requestedCode) {
            targetDoc = await TestModel.findOne({ code: requestedCode }).lean();
        }
        if (!targetDoc) {
            const userMapping = await UserTestModel.findOne({ userId: ownerId }).lean();
            if (userMapping) {
                targetDoc = await TestModel.findOne({ code: userMapping.code }).lean();
            }
        }

        const isUpdate = Boolean(targetDoc);
        if (!isUpdate) {
            const total = await countTests();
            if (total >= MAX_TEST_SETS) {
                return { error: `Maksimal ${MAX_TEST_SETS} ta test jamlanmasiga ruxsat berilgan!` };
            }
        }

        const code = isUpdate ? targetDoc.code : await generateUniqueCode();
        const payload = {
            code,
            ownerId,
            title,
            solveCount,
            timeMinutes,
            showEndMistakes,
            showInstantAnswer,
            questions,
            updatedAt
        };

        await TestModel.findOneAndUpdate({ code }, payload, { upsert: true, new: true });
        await UserTestModel.findOneAndUpdate({ userId: ownerId }, { userId: ownerId, code }, { upsert: true });

        return { code };
    }

    const db = readLocalDB();
    const existingCode = requestedCode && db.tests[requestedCode] ? String(requestedCode) : db.users[ownerId];
    const isUpdate = Boolean(existingCode && db.tests[existingCode]);

    if (!isUpdate && Object.keys(db.tests).length >= MAX_TEST_SETS) {
        return { error: `Maksimal ${MAX_TEST_SETS} ta test jamlanmasiga ruxsat berilgan!` };
    }

    const code = isUpdate ? existingCode : await generateUniqueCode();
    db.tests[code] = {
        ownerId,
        title,
        solveCount,
        timeMinutes,
        showEndMistakes,
        showInstantAnswer,
        questions,
        updatedAt
    };
    db.users[ownerId] = code;
    writeLocalDB(db);

    return { code };
}

// --- Fayl parserlari ---
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

// --- API marshrutlari ---
app.get('/api/my-test/:userId', async (req, res) => {
    try {
        const userId = String(req.params.userId || '').trim();
        const code = await getUserTestCode(userId);
        if (!code) {
            return res.json({ success: true, test: null });
        }
        const test = await getTestByCode(code);
        if (!test) {
            return res.json({ success: true, test: null });
        }
        return res.json({
            success: true,
            test: { ...test, code }
        });
    } catch (err) {
        console.error('Foydalanuvchi testini olishda xato:', err);
        return res.status(500).json({ success: false, message: 'Serverda ichki xatolik yuz berdi!' });
    }
});

app.get('/api/test/:code', async (req, res) => {
    try {
        const code = String(req.params.code || '').trim();
        const test = await getTestByCode(code);
        if (!test) {
            return res.status(404).json({ success: false, message: 'Bunday kodli test topilmadi!' });
        }
        return res.json({
            success: true,
            test: { ...test, code }
        });
    } catch (err) {
        console.error('Testni olishda xato:', err);
        return res.status(500).json({ success: false, message: 'Serverda ichki xatolik yuz berdi!' });
    }
});

app.delete('/api/test/:code', async (req, res) => {
    try {
        const code = String(req.params.code || '').trim();
        const deleted = await deleteTestByCode(code);
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Test topilmadi!' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Testni o‘chirishda xato:', err);
        return res.status(500).json({ success: false, message: 'Serverda ichki xatolik yuz berdi!' });
    }
});

app.post('/api/save-test', async (req, res) => {
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

        const result = await saveOrUpdateTest({
            ownerId,
            requestedCode: body.code ? String(body.code).trim() : '',
            title,
            solveCount,
            timeMinutes,
            showEndMistakes,
            showInstantAnswer,
            questions: cleanQuestions
        });

        if (result.error) {
            return res.status(400).json({ success: false, message: result.error });
        }

        return res.json({ success: true, code: result.code });
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

// --- Telegram Webhook ---
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    if (!BOT_TOKEN || typeof fetch !== 'function') return;

    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    const text = String(msg?.text || '').trim();
    if (!chatId || text !== '/start') return;

    const host = req.get('host') || 'testora-i2yy.onrender.com';
    const baseUrl = `https://${host}`;
    const uid = msg.from?.id || chatId;
    const appUrl = `${baseUrl}/?uid=${uid}`;

    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text:
                    'Assalomu alaykum! *Testora* platformasiga xush kelibsiz.\n\n' +
                    'Test tuzish yoki 6 xonali kod orqali test ishlash uchun quyidagi tugmalardan foydalaning. ' +
                    'Kompyuterda to‘liq ekranda ishlash uchun saytni brauzerda ham ochishingiz mumkin:',
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🚀 Testora Web App', web_app: { url: appUrl } }
                        ],
                        [
                            { text: '🌐 Brauzerda ochish', url: appUrl }
                        ]
                    ]
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

initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Testora serveri ${PORT}-portda ishga tushdi.`);
    });
});