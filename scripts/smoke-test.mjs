import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const port = 3187 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const tempVideo = path.join(os.tmpdir(), `zlatyn-smoke-${process.pid}.mp4`);
const server = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverLogs = "";
server.stdout.on("data", chunk => { serverLogs += chunk.toString(); });
server.stderr.on("data", chunk => { serverLogs += chunk.toString(); });

async function waitForServer() {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error("Server exited early: " + serverLogs);
    try {
      const response = await fetch(base + "/api/health");
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error("Server did not become healthy: " + serverLogs);
}

try {
  const gen = spawn(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=blue:s=320x480:r=24:d=3",
    "-f", "lavfi", "-i", "sine=frequency=1000:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-shortest", "-y", tempVideo
  ], { stdio: "inherit" });
  const [genCode] = await once(gen, "close");
  if (genCode !== 0) throw new Error("Could not create smoke-test source video.");

  await waitForServer();
  const health = await (await fetch(base + "/api/health")).json();
  if (!health.ok || !health.ffmpegAvailable) throw new Error("FFmpeg health probe failed: " + JSON.stringify(health));

  const form = new FormData();
  form.append("video", new Blob([await fs.readFile(tempVideo)], { type: "video/mp4" }), "smoke.mp4");
  const uploadResponse = await fetch(base + "/api/upload", { method: "POST", body: form });
  const upload = await uploadResponse.json();
  if (!uploadResponse.ok || !upload.ok || !upload.sourceRef) throw new Error("Upload smoke test failed: " + JSON.stringify(upload));

  const processResponse = await fetch(base + "/api/process", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: upload.sourceRef, start: 0, duration: 2, index: 0, caption: "HOOK TEST", faceTrack: [{t:0,cx:0.25,cy:0.45},{t:1,cx:0.75,cy:0.45}] })
  });
  const jobStart = await processResponse.json();
  if (processResponse.status !== 202 || !jobStart.jobId) throw new Error("Render job did not start: " + JSON.stringify(jobStart));

  let job;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const response = await fetch(base + "/api/jobs/" + encodeURIComponent(jobStart.jobId));
    job = await response.json();
    if (job.status === "done") break;
    if (job.status === "failed") throw new Error("FFmpeg render failed: " + job.error);
  }
  if (!job || job.status !== "done" || !job.url) throw new Error("Render timed out: " + JSON.stringify(job));

  const outputResponse = await fetch(base + job.url);
  const output = Buffer.from(await outputResponse.arrayBuffer());
  if (!outputResponse.ok || output.length < 1000) throw new Error("MP4 output download failed or was empty.");
  console.log("PASS: health probe, video upload, background render, and MP4 download (" + output.length + " bytes).");
} catch (error) {
  console.error("FAIL:", error);
  console.error(serverLogs);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await fs.rm(tempVideo, { force: true }).catch(() => {});
}
