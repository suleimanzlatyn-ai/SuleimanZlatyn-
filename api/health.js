import ffmpegPath from "ffmpeg-static";

export default async function handler(req,res){
  const configured=Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  res.status(200).json({
    ok:true,
    backend:true,
    storageConfigured:configured,
    ffmpegAvailable:Boolean(ffmpegPath),
    access:process.env.BLOB_ACCESS||"public"
  });
}
