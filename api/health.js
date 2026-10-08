import ffmpegPath from "ffmpeg-static";

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  const storageConfigured=Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const ffmpegAvailable=Boolean(ffmpegPath);
  const ready=storageConfigured && ffmpegAvailable;
  return res.status(200).json({
    ok:true,
    backend:ready,
    storageConfigured,
    ffmpegAvailable,
    access:process.env.BLOB_ACCESS==="private"?"private":"public",
    mode:ready ? "server-ffmpeg" : "browser-ffmpeg-fallback",
    message:ready ? "Server-side FFmpeg is ready." : "Server storage is not configured; browser FFmpeg fallback is available."
  });
}
