import express from "express";
import multer from "multer";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(os.tmpdir(), "zlatyn-render");
const UPLOADS = path.join(DATA, "uploads");
const OUTPUTS = path.join(DATA, "outputs");
await fsp.mkdir(UPLOADS, { recursive: true });
await fsp.mkdir(OUTPUTS, { recursive: true });

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use("/outputs", express.static(OUTPUTS, { maxAge: "1h", setHeaders(res) { res.setHeader("X-Content-Type-Options", "nosniff"); } }));
app.get("/api/health", (_req, res) => res.json({
  ok: true, backend: Boolean(ffmpegPath), storageConfigured: Boolean(ffmpegPath),
  ffmpegAvailable: Boolean(ffmpegPath), access: "public", mode: "render-temporary-disk",
  message: "Native FFmpeg backend ready. Download clips promptly; files are temporary."
}));

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!String(file.mimetype || "").startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.originalname || "")) {
      return cb(new Error("Upload a video file (MP4, MOV, WEBM, MKV or AVI)."));
    }
    cb(null, true);
  }
});

app.post("/api/upload", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "No video file received." });
  const id = crypto.randomUUID();
  const ext = path.extname(req.file.originalname || "") || ".video";
  const saved = path.join(UPLOADS, id + ext);
  try {
    await fsp.rename(req.file.path, saved);
    res.json({ ok: true, sourceRef: id, url: id, filename: path.basename(saved), size: req.file.size });
  } catch {
    await fsp.rm(req.file.path, { force: true }).catch(() => {});
    res.status(500).json({ ok: false, error: "Could not store uploaded video temporarily." });
  }
});

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 10000) stderr = stderr.slice(-10000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr || "FFmpeg exited with code " + code)));
  });
}
function safeText(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\\\'");
}

app.post("/api/process", async (req, res) => {
  const { source, start, duration, index, caption = "" } = req.body || {};
  const s = Number(start), d = Number(duration);
  if (typeof source !== "string" || !/^[0-9a-f-]{36}$/i.test(source) || !Number.isFinite(s) || !Number.isFinite(d) || s < 0 || d <= 0 || d > 180) {
    return res.status(400).json({ ok: false, error: "Invalid clip request." });
  }
  const matches = (await fsp.readdir(UPLOADS)).filter(name => name.startsWith(source + "."));
  if (!matches.length) return res.status(404).json({ ok: false, error: "The uploaded source expired or was not found. Upload the video again." });
  const input = path.join(UPLOADS, matches[0]);
  const id = crypto.randomUUID();
  const outputName = "zlatyn-clip-" + (Number.isFinite(Number(index)) ? Number(index) + 1 : 1) + "-" + id + ".mp4";
  const output = path.join(OUTPUTS, outputName);
  try {
    let vf = "crop=if(gte(iw/ih\\,9/16)\\,ih*9/16\\,iw):if(gte(iw/ih\\,9/16)\\,ih\\,iw*16/9):(iw-ow)/2:(ih-oh)/2,scale=1080:1920,unsharp=5:5:0.8:3:3:0.4";
    if (String(caption || "").trim()) {
      const text = safeText(String(caption).trim().slice(0, 180));
      vf += ",drawtext=text='" + text + "':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h*0.08";
    }
    await runFFmpeg(["-hide_banner","-loglevel","error","-ss",String(s),"-i",input,"-t",String(d),"-vf",vf,"-c:v","libx264","-preset","ultrafast","-crf","24","-c:a","aac","-b:a","128k","-movflags","+faststart","-y",output]);
    res.json({ ok: true, url: "/outputs/" + outputName, index: Number(index) || 0, duration: d });
  } catch (e) {
    console.error("FFmpeg clip failed:", e);
    await fsp.rm(output, { force: true }).catch(() => {});
    res.status(500).json({ ok: false, error: e.message || "FFmpeg processing failed." });
  }
});

app.use(express.static(ROOT, { index: "index.html", etag: true }));
app.get("*", (_req, res) => res.sendFile(path.join(ROOT, "index.html")));
app.use((err, _req, res, _next) => {
  console.error("Request error:", err.message);
  const status = err instanceof multer.MulterError ? 413 : 400;
  res.status(status).json({ ok: false, error: err.message || "Request failed." });
});

const server = app.listen(PORT, "0.0.0.0", () => console.log("Zlatyn Clip Studio backend listening on " + PORT));
server.timeout = 0;
server.requestTimeout = 0;

setInterval(async () => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const dir of [UPLOADS, OUTPUTS]) {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      const file = path.join(dir, name);
      const stat = await fsp.stat(file).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
}, 60 * 60 * 1000).unref();
