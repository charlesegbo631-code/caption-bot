// server.js
// Node/Express server for TikTok Growth Assistant
// - /api/trends  [GET]
// - /api/caption [POST] (JSON {idea} or multipart form upload field "video")
// - /api/drafts  [GET, POST, PUT, DELETE] (file-backed storage)
// - /auth/tiktok [GET] placeholder
//
// Usage: node server.js
import express from "express";
import dotenv from "dotenv";
import path from "path";
import cors from "cors";
import rateLimit from "express-rate-limit";
import multer from "multer";
import fs from "fs/promises";
import fssync from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import OpenAI from "openai";
import trendsRouter from "./trends.js";


dotenv.config();

const PORT = process.env.PORT || 3000;
const publicDir = path.resolve(process.cwd(), "public");
const dataDir = path.resolve(process.cwd(), "data");
const draftsFile = path.join(dataDir, "drafts.json");

const app = express();

// Set up ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Init OpenAI client
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY not set. /api/caption will fail until it's provided.");
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// Middleware
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/api", trendsRouter);
app.use(express.urlencoded({ extended: true }));
app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 200,
  })
);

// Serve frontend
app.use(express.static(publicDir));

// Ensure data folder exists
async function ensureDataDir() {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    try {
      await fs.access(draftsFile);
    } catch {
      await fs.writeFile(draftsFile, "[]", "utf8");
    }
  } catch (err) {
    console.error("Failed to ensure data dir:", err);
  }
}
await ensureDataDir();

// Multer for uploads (temp to /uploads)
const uploadDir = path.join(process.cwd(), "uploads");
await fs.mkdir(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.random().toString(36).slice(2, 9);
    cb(null, `${unique}-${file.originalname}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

/* ----------------- /api/trends ----------------- */
app.get("/api/trends", async (req, res) => {
  const usePuppeteer = process.env.USE_PUPPETEER === "true";

  if (usePuppeteer) {
    try {
      const puppeteer = await import("puppeteer");
      const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      const page = await browser.newPage();
      await page.goto(
        "https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/global",
        { waitUntil: "domcontentloaded", timeout: 30000 }
      );
      await page.waitForTimeout(1500);
      const items = await page.evaluate(() => {
        // try a few selector variations
        const nodes = Array.from(
          document.querySelectorAll(
            '[data-e2e="hashtag-name"], .hashtag-name, .tag-name, .creative-card__tag'
          )
        );
        return nodes
          .map((n) => n.innerText && n.innerText.trim())
          .filter(Boolean)
          .slice(0, 40);
      });
      await browser.close();
      if (items && items.length) {
        return res.json({ ok: true, provider: "puppeteer", data: items });
      }
    } catch (err) {
      console.warn("puppeteer trends failed:", err?.message || err);
    }
  }

  // fallback / simulated
  const fallback = [
    "#fyp",
    "#viral",
    "#trend",
    "#challenge",
    "#lifehack",
    "#dance",
    "#funny",
    "#asmr",
    "#tutorial",
  ];
  return res.json({ ok: true, provider: "simulated", data: fallback });
});

/* -------------- /api/caption -------------- */
/*
Accepts:
- JSON { idea: "text idea" }  -> generates captions via OpenAI using the idea
- multipart/form-data with "video" file -> extracts audio, sends to OpenAI transcription (whisper),
  then uses transcript/context to generate captions.
Returns { ok: true, captions: [..] }
*/
/* -------------- /api/caption -------------- */
app.post("/api/caption", upload.single("video"), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY not set on server" });
    }

    let contextText = "";

    // --- STEP 1: Transcript OR idea ---
    if (req.file) {
      const videoPath = req.file.path;
      const audioPath = `${videoPath}.mp3`;

      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .noVideo()
          .audioCodec("libmp3lame")
          .format("mp3")
          .on("end", resolve)
          .on("error", reject)
          .save(audioPath);
      });

      const transcription = await openai.audio.transcriptions.create({
        file: fssync.createReadStream(audioPath),
        model: "whisper-1",
      });
      contextText = transcription?.text || "";

      try { fssync.unlinkSync(videoPath); } catch {}
      try { fssync.unlinkSync(audioPath); } catch {}
    } else if (req.body.idea) {
      contextText = String(req.body.idea || "");
    } else {
      return res.status(400).json({ ok: false, error: "Provide video file (field 'video') or JSON { idea }" });
    }

    // --- STEP 2: Fetch trending hashtags ---
    let trends = [];
    try {
      const fetch = (await import("node-fetch")).default;
      const r = await fetch(`http://localhost:${PORT}/api/trends`);
      const j = await r.json();
      trends = j.data || [];
    } catch {
      trends = ["#fyp", "#viral", "#trend", "#funny"];
    }
    const trendsText = trends.slice(0, 5).join(" ");

    // --- STEP 3: Generate captions ---
    const captionPrompt = `Video/transcript: ${contextText}
Trending hashtags: ${trendsText}

Generate 4 different TikTok caption variants:
- <= 120 characters
- Natural, human, viral tone
- Use emojis if natural
- Each caption should target a different niche/FYP:
  1. Educational/tutorial
  2. Funny/entertaining
  3. Lifestyle/relatable
  4. Challenge/trend
Return as a newline list.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a TikTok strategist who crafts viral captions." },
        { role: "user", content: captionPrompt },
      ],
      max_tokens: 300,
    });

    const rawCaptions = completion.choices?.[0]?.message?.content?.trim?.() || "";
    let captions = rawCaptions
      .split(/\r?\n/)
      .map((line) => line.replace(/^\d+\.\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 4);

    // --- STEP 4: Generate sound recommendations ---
    const soundPrompt = `Transcript/context: ${contextText}
Trending hashtags: ${trendsText}

Suggest 3 trending TikTok sound types that would boost discoverability.
Examples: "lofi chill beat", "funny meme sound", "dramatic transition".
Keep them short and catchy.`;

    const soundCompletion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You recommend TikTok trending sounds." },
        { role: "user", content: soundPrompt },
      ],
      max_tokens: 150,
    });

    const rawSounds = soundCompletion.choices?.[0]?.message?.content?.trim?.() || "";
    let sounds = rawSounds
      .split(/\r?\n/)
      .map((s) => s.replace(/^\d+\.\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 3);

    return res.json({ ok: true, captions, sounds, trends });
  } catch (err) {
    console.error("/api/caption error:", err);
    return res.status(500).json({ ok: false, error: "Caption generation failed", detail: err.message });
  }
});


/* -------------------- /api/drafts (file-backed) -------------------- */
/*
GET  /api/drafts          -> list all drafts
POST /api/drafts          -> create a draft { name, caption, hashtags } returns created object
PUT  /api/drafts/:id      -> update draft
DELETE /api/drafts/:id    -> delete draft
*/
async function readDrafts() {
  try {
    const raw = await fs.readFile(draftsFile, "utf8");
    return JSON.parse(raw || "[]");
  } catch (err) {
    console.warn("readDrafts error:", err);
    return [];
  }
}
async function writeDrafts(arr) {
  await fs.writeFile(draftsFile, JSON.stringify(arr, null, 2), "utf8");
}

app.get("/api/drafts", async (req, res) => {
  try {
    const drafts = await readDrafts();
    return res.json({ ok: true, drafts });
  } catch (err) {
    console.error("GET /api/drafts error:", err);
    return res.status(500).json({ ok: false, error: "Failed to read drafts" });
  }
});

app.post("/api/drafts", async (req, res) => {
  try {
    const { name, caption, hashtags } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "Missing name" });
    const drafts = await readDrafts();
    const id = "draft_" + Date.now();
    const item = { id, name, caption: caption || "", hashtags: hashtags || "", created: new Date().toISOString() };
    drafts.unshift(item);
    await writeDrafts(drafts);
    return res.json({ ok: true, draft: item });
  } catch (err) {
    console.error("POST /api/drafts error:", err);
    return res.status(500).json({ ok: false, error: "Failed to save draft" });
  }
});

app.put("/api/drafts/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { name, caption, hashtags } = req.body;
    const drafts = await readDrafts();
    const idx = drafts.findIndex((d) => d.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "Draft not found" });
    drafts[idx] = { ...drafts[idx], name: name ?? drafts[idx].name, caption: caption ?? drafts[idx].caption, hashtags: hashtags ?? drafts[idx].hashtags, updated: new Date().toISOString() };
    await writeDrafts(drafts);
    return res.json({ ok: true, draft: drafts[idx] });
  } catch (err) {
    console.error("PUT /api/drafts/:id error:", err);
    return res.status(500).json({ ok: false, error: "Failed to update draft" });
  }
});

app.delete("/api/drafts/:id", async (req, res) => {
  try {
    const id = req.params.id;
    let drafts = await readDrafts();
    const idx = drafts.findIndex((d) => d.id === id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "Draft not found" });
    const removed = drafts.splice(idx, 1)[0];
    await writeDrafts(drafts);
    return res.json({ ok: true, deleted: removed });
  } catch (err) {
    console.error("DELETE /api/drafts/:id error:", err);
    return res.status(500).json({ ok: false, error: "Failed to delete draft" });
  }
});

/* -------------------- OAuth /auth/tiktok placeholder -------------------- */
app.get("/auth/tiktok", (req, res) => {
  // Replace this with your real OAuth flow (server-side client id/secret -> redirect to TikTok etc).
  // For now just show a small message or redirect back to homepage.
  res.send(`
    <h3>TikTok OAuth placeholder</h3>
    <p>Implement the OAuth redirect here. In production, redirect the user to your TikTok OAuth endpoint that begins the flow, then handle callback server-side.</p>
    <p><a href="/">Return to app</a></p>
  `);
});

/* ---------------- Fallback for SPA — serve index.html from public ---------------- */
app.get(/.*/, (req, res) => {
  const indexPath = path.join(publicDir, "index.html");
  if (fssync.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Index not found. Place your frontend in the ./public directory.");
  }
});

/* ---------------- Start ---------------- */
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📂 Serving static files from ${publicDir}`);
});
