const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const mammoth = require("mammoth");

const app = express();
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const WEBAPP_URL = "https://testora-i2yy.onrender.com";

const DB_FILE = path.join(__dirname, "database.json");
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

let mongoose = null;
let QuizModel = null;
let ResultModel = null;
let useMongo = false;

function loadLocalDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf8");
      const parsed = JSON.parse(raw);
      return {
        quizzes: Array.isArray(parsed.quizzes) ? parsed.quizzes : [],
        results: Array.isArray(parsed.results) ? parsed.results : []
      };
    }
  } catch (err) {
    console.error("database.json o'qishda xato:", err.message);
  }
  return { quizzes: [], results: [] };
}

function saveLocalDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("database.json yozishda xato:", err.message);
  }
}

let localDb = loadLocalDb();

async function initDatabase() {
  if (!MONGODB_URI) {
    console.log("MONGODB_URI ko'rsatilmagan. Zaxira sifatida database.json ishlatiladi.");
    return;
  }

  try {
    mongoose = require("mongoose");
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 8000
    });

    const quizSchema = new mongoose.Schema(
      {
        code: { type: String, required: true, unique: true },
        title: { type: String, required: true },
        description: { type: String, default: "" },
        questions: { type: Array, default: [] },
        createdAt: { type: Date, default: Date.now }
      },
      { timestamps: true }
    );

    const resultSchema = new mongoose.Schema(
      {
        quizCode: { type: String, required: true },
        userName: { type: String, required: true },
        score: { type: Number, required: true },
        total: { type: Number, required: true },
        answers: { type: Array, default: [] },
        submittedAt: { type: Date, default: Date.now }
      },
      { timestamps: true }
    );

    QuizModel = mongoose.models.Quiz || mongoose.model("Quiz", quizSchema);
    ResultModel = mongoose.models.Result || mongoose.model("Result", resultSchema);
    useMongo = true;
    console.log("MongoDB Atlas muvaffaqiyatli ulandi!");
  } catch (err) {
    useMongo = false;
    console.error("MongoDB ulanishda xato:", err.message);
    console.log("Zaxira sifatida database.json ishlatiladi.");
  }
}

function generateQuizCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function parseQuestionsFromText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const questions = [];
  let current = null;

  for (const line of lines) {
    const qMatch = line.match(/^(?:\d+[\).\]]|savol\s*\d*[:.)]?|q\s*\d*[:.)]?)\s*(.+)/i);
    const optMatch = line.match(/^(?:[a-dA-D]|[1-4])[\).\]]\s*(.+)/);
    const ansMatch = line.match(/^(?:javob|answer|correct|to'?g'?ri\s*javob)\s*[:=-]\s*(.+)/i);

    if (qMatch && !optMatch) {
      if (current && current.options.length > 0) {
        questions.push(current);
      }
      current = {
        question: qMatch[1].trim(),
        options: [],
        correctIndex: 0
      };
    } else if (optMatch && current) {
      let optText = optMatch[1].trim();
      const isStarred = optText.endsWith("*") || optText.startsWith("*");
      if (isStarred) {
        optText = optText.replace(/^\*|\*$/g, "").trim();
        current.correctIndex = current.options.length;
      }
      current.options.push(optText);
    } else if (ansMatch && current) {
      const rawAns = ansMatch[1].trim().toUpperCase();
      const letterMap = { A: 0, B: 1, C: 2, D: 3, "1": 0, "2": 1, "3": 2, "4": 3 };
      if (rawAns in letterMap) {
        current.correctIndex = letterMap[rawAns];
      } else {
        const idx = current.options.findIndex((o) => o.toLowerCase() === rawAns.toLowerCase());
        if (idx >= 0) current.correctIndex = idx;
      }
    } else if (!current && line.length > 3) {
      current = {
        question: line,
        options: [],
        correctIndex: 0
      };
    }
  }

  if (current && current.options.length > 0) {
    questions.push(current);
  }

  return questions;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    database: useMongo ? "mongodb" : "database.json"
  });
});

app.post("/api/quizzes", async (req, res) => {
  try {
    const { title, description, questions } = req.body;
    if (!title || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "Test nomi va kamida bitta savol majburiy." });
    }

    let code = generateQuizCode();
    if (useMongo && QuizModel) {
      while (await QuizModel.findOne({ code })) {
        code = generateQuizCode();
      }
      const created = await QuizModel.create({
        code,
        title: title.trim(),
        description: (description || "").trim(),
        questions
      });
      return res.json({ ok: true, code: created.code, quiz: created });
    } else {
      while (localDb.quizzes.some((q) => q.code === code)) {
        code = generateQuizCode();
      }
      const quiz = {
        code,
        title: title.trim(),
        description: (description || "").trim(),
        questions,
        createdAt: new Date().toISOString()
      };
      localDb.quizzes.push(quiz);
      saveLocalDb(localDb);
      return res.json({ ok: true, code: quiz.code, quiz });
    }
  } catch (err) {
    console.error("Test yaratishda xato:", err);
    res.status(500).json({ error: "Testni saqlashda xatolik yuz berdi." });
  }
});

app.get("/api/quizzes/:code", async (req, res) => {
  try {
    const code = (req.params.code || "").trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ error: "Test kodi kiritilmagan." });
    }

    if (useMongo && QuizModel) {
      const quiz = await QuizModel.findOne({ code }).lean();
      if (!quiz) return res.status(404).json({ error: "Bunday kodli test topilmadi." });
      return res.json({ ok: true, quiz });
    } else {
      const quiz = localDb.quizzes.find((q) => q.code.toUpperCase() === code);
      if (!quiz) return res.status(404).json({ error: "Bunday kodli test topilmadi." });
      return res.json({ ok: true, quiz });
    }
  } catch (err) {
    console.error("Testni olishda xato:", err);
    res.status(500).json({ error: "Testni yuklashda xatolik yuz berdi." });
  }
});

app.post("/api/results", async (req, res) => {
  try {
    const { quizCode, userName, score, total, answers } = req.body;
    const normalizedCode = (quizCode || "").trim().toUpperCase();
    if (!normalizedCode || typeof score !== "number" || typeof total !== "number") {
      return res.status(400).json({ error: "Natija ma'lumotlari to'liq emas." });
    }

    const cleanName = (userName || "Foydalanuvchi").trim() || "Foydalanuvchi";

    if (useMongo && ResultModel) {
      const saved = await ResultModel.create({
        quizCode: normalizedCode,
        userName: cleanName,
        score,
        total,
        answers: Array.isArray(answers) ? answers : []
      });
      return res.json({ ok: true, result: saved });
    } else {
      const result = {
        quizCode: normalizedCode,
        userName: cleanName,
        score,
        total,
        answers: Array.isArray(answers) ? answers : [],
        submittedAt: new Date().toISOString()
      };
      localDb.results.push(result);
      saveLocalDb(localDb);
      return res.json({ ok: true, result });
    }
  } catch (err) {
    console.error("Natijani saqlashda xato:", err);
    res.status(500).json({ error: "Natijani saqlashda xatolik yuz berdi." });
  }
});

app.get("/api/results/:code", async (req, res) => {
  try {
    const code = (req.params.code || "").trim().toUpperCase();
    if (useMongo && ResultModel) {
      const list = await ResultModel.find({ quizCode: code }).sort({ submittedAt: -1 }).lean();
      return res.json({ ok: true, results: list });
    } else {
      const list = localDb.results
        .filter((r) => r.quizCode.toUpperCase() === code)
        .slice()
        .reverse();
      return res.json({ ok: true, results: list });
    }
  } catch (err) {
    console.error("Natijalarni olishda xato:", err);
    res.status(500).json({ error: "Natijalarni olishda xatolik yuz berdi." });
  }
});

app.post("/api/import-questions", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Fayl tanlanmadi." });
    }

    const ext = path.extname(req.file.originalname || "").toLowerCase();
    let extractedText = "";

    if (ext === ".docx") {
      const docResult = await mammoth.extractRawText({ buffer: req.file.buffer });
      extractedText = docResult.value || "";
    } else if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
      extractedText = rows
        .map((row) => (Array.isArray(row) ? row.filter(Boolean).join(" | ") : ""))
        .filter(Boolean)
        .join("\n");
    } else {
      extractedText = req.file.buffer.toString("utf8");
    }

    const questions = parseQuestionsFromText(extractedText);
    if (!questions.length) {
      return res.status(400).json({ error: "Fayldan savollarni ajratib bo'lmadi." });
    }

    res.json({ ok: true, questions });
  } catch (err) {
    console.error("Fayldan import qilishda xato:", err);
    res.status(500).json({ error: "Faylni o'qishda xatolik yuz berdi." });
  }
});

const botTexts = {
  uz: {
    welcome:
      "Assalomu alaykum! Testora platformasiga xush kelibsiz.\n\nTest tuzish yoki 6 xonali kod orqali test ishlash uchun quyidagi tugmalardan foydalaning. Tilni o'zgartirish uchun pastdagi til tugmalarini bosing:",
    openApp: "🚀 Testora Web App",
    openBrowser: "🌐 Brauzerda ochish",
    langChanged: "Til o'zbek tiliga o'zgartirildi."
  },
  ru: {
    welcome:
      "Здравствуйте! Добро пожаловать на платформу Testora.\n\nИспользуйте кнопки ниже, чтобы создать тест или пройти его по 6-значному коду. Чтобы сменить язык, нажмите кнопку языка ниже:",
    openApp: "🚀 Testora Web App",
    openBrowser: "🌐 Открыть в браузере",
    langChanged: "Язык изменён на русский."
  },
  en: {
    welcome:
      "Hello! Welcome to the Testora platform.\n\nUse the buttons below to create a test or take one using a 6-digit code. Tap a language button below to switch language:",
    openApp: "🚀 Testora Web App",
    openBrowser: "🌐 Open in browser",
    langChanged: "Language switched to English."
  }
};

function getStartKeyboard(lang = "uz") {
  const t = botTexts[lang] || botTexts.uz;
  return {
    inline_keyboard: [
      [
        { text: t.openApp, web_app: { url: WEBAPP_URL } }
      ],
      [
        { text: t.openBrowser, url: WEBAPP_URL }
      ],
      [
        { text: "🇺🇿 O'Z", callback_data: "lang_uz" },
        { text: "🇷🇺 RU", callback_data: "lang_ru" },
        { text: "🇬🇧 EN", callback_data: "lang_en" }
      ]
    ]
  };
}

async function telegramRequest(method, payload) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();

      if (text === "/start") {
        await telegramRequest("sendMessage", {
          chat_id: chatId,
          text: botTexts.uz.welcome,
          reply_markup: getStartKeyboard("uz")
        });
      }
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || "";
      const chatId = cb.message?.chat?.id;
      const messageId = cb.message?.message_id;

      if (data.startsWith("lang_") && chatId && messageId) {
        const lang = data.replace("lang_", "");
        const t = botTexts[lang] || botTexts.uz;

        await telegramRequest("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: t.welcome,
          reply_markup: getStartKeyboard(lang)
        });

        await telegramRequest("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: t.langChanged
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook xatosi:", err);
    res.sendStatus(200);
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Testora serveri ${PORT}-portda ishga tushdi.`);
  });
});
