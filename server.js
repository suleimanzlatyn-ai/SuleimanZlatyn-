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
let ffmpegHealth = { checkedAt: 0, available: false, error: "FFmpeg has not been checked yet." };
async function checkFFmpeg() {
  if (Date.now() - ffmpegHealth.checkedAt < 30000) return ffmpegHealth;
  ffmpegHealth = await new Promise(resolve => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return resolve({ checkedAt: Date.now(), available: false, error: "FFmpeg binary is missing." });
    }
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ checkedAt: Date.now(), ...value });
    };
    const child = spawn(ffmpegPath, ["-version"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ available: false, error: "FFmpeg health check timed out." }); }, 5000);
    child.on("error", err => finish({ available: false, error: err.message || "FFmpeg could not start." }));
    child.on("close", code => finish({ available: code === 0, error: code === 0 ? null : (stderr || "FFmpeg exited with code " + code) }));
  });
  return ffmpegHealth;
}
app.get("/api/health", async (_req, res) => {
  const health = await checkFFmpeg();
  res.status(health.available ? 200 : 503).json({
    ok: health.available, backend: true, storageConfigured: true,
    ffmpegAvailable: health.available, access: "public", mode: "render-temporary-disk",
    message: health.available
      ? "FFmpeg was executed successfully. Uploaded videos and clips are temporary; download clips promptly."
      : "The server is running, but FFmpeg is not ready.",
    error: health.error || null
  });
});

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

function runFFmpeg(args, onProgress, durationSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("FFmpeg exceeded the 9-minute render limit. Try a shorter clip or smaller video."));
    }, 9 * 60 * 1000);
    child.stdout.on("data", chunk => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)$/);
        if (match && typeof onProgress === "function") {
          const ratio = Number(match[1]) / Math.max(1, Number(durationSeconds) * 1000000);
          onProgress(Math.max(0, Math.min(99, Math.round(ratio * 100))));
        } else if (line === "progress=end" && typeof onProgress === "function") {
          onProgress(100);
        }
      }
    });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 10000) stderr = stderr.slice(-10000); });
    child.on("error", err => finish(err));
    child.on("close", code => code === 0
      ? finish()
      : finish(new Error(stderr || "FFmpeg exited with code " + code)));
  });
}
function safeText(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\\\'");
}

const jobs = new Map();
function pruneJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.status !== "processing" && job.createdAt < cutoff) jobs.delete(id);
  }
}
setInterval(pruneJobs, 5 * 60 * 1000).unref();

app.post("/api/process", async (req, res) => {
  const { source, start, duration, index } = req.body || {};
  const s = Number(start), d = Number(duration);
  if (typeof source !== "string" || !/^[0-9a-f-]{36}$/i.test(source) || !Number.isFinite(s) || !Number.isFinite(d) || s < 0 || d <= 0 || d > 300) {
    return res.status(400).json({ ok: false, error: "Invalid clip request. Each clip must be between 0 and 300 seconds." });
  }
  const matches = (await fsp.readdir(UPLOADS)).filter(name => name.startsWith(source + "."));
  if (!matches.length) return res.status(404).json({ ok: false, error: "The uploaded source expired or was not found. Upload the video again." });

  const input = path.join(UPLOADS, matches[0]);
  const id = crypto.randomUUID();
  const outputName = "zlatyn-clip-" + (Number.isFinite(Number(index)) ? Number(index) + 1 : 1) + "-" + id + ".mp4";
  const output = path.join(OUTPUTS, outputName);
  jobs.set(id, { status: "queued", createdAt: Date.now(), url: null, error: null, progress: 0 });
  res.status(202).json({ ok: true, jobId: id });

  void (async () => {
    const job = jobs.get(id);
    if (!job) return;
    job.status = "processing";
    try {
      // Accurate timestamp cut: re-encode only the requested segment.
      // Fast preset, no crop/rotation/overlays, and preserve the source aspect ratio.
      // Large 4K inputs are capped at 1920px wide; smaller videos keep their dimensions.
      await runFFmpeg([
        "-hide_banner","-loglevel","error","-progress","pipe:1","-nostats",
        "-ss",String(s),"-i",input,"-t",String(d),
        "-map","0:v:0","-map","0:a?",
        "-vf","scale=w='min(1920,iw)':h=-2",
        "-c:v","libx264","-preset","ultrafast","-crf","23","-threads","2",
        "-c:a","aac","-b:a","128k","-movflags","+faststart","-y",output
      ], progress => { job.progress = progress; }, d);
      const stat = await fsp.stat(output);
      if (!stat.size) throw new Error("The clip file was empty.");
      job.status = "done";
      job.progress = 100;
      job.url = "/outputs/" + outputName;
      job.finishedAt = Date.now();
    } catch (e) {
      console.error("FFmpeg clip failed:", e);
      await fsp.rm(output, { force: true }).catch(() => {});
      job.status = "failed";
      job.error = e.message || "FFmpeg processing failed.";
      job.finishedAt = Date.now();
    }
  })();
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: "Processing job not found. Please generate the clip again." });
  res.json({ ok: true, status: job.status, url: job.url, error: job.error, progress: Number(job.progress) || 0 });
});

app.use(express.static(ROOT, { index: "index.html", etag: true }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(ROOT, "index.html")));
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
