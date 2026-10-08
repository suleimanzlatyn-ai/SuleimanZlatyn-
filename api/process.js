import { get, put } from "@vercel/blob";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";

export const config={api:{bodyParser:{sizeLimit:"1mb"}}};

function runFFmpeg(args){
  return new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,args,{stdio:["ignore","ignore","pipe"]});
    let stderr="";
    p.stderr.on("data",d=>{stderr+=d.toString(); if(stderr.length>12000) stderr=stderr.slice(-12000);});
    p.on("error",reject);
    p.on("close",code=>code===0?resolve():reject(new Error(stderr||("FFmpeg exited with "+code))));
  });
}

async function blobToFile(source,filename){
  const access=process.env.BLOB_ACCESS==="private"?"private":"public";
  const result=await get(source,{access});
  if(!result || result.statusCode!==200) throw new Error("Source video could not be read from storage.");
  const out=fs.createWriteStream(filename);
  await pipeline(result.stream,out);
}

export default async function handler(req,res){
  if(req.method!=="POST"){
    res.setHeader("Allow","POST");
    return res.status(405).json({error:"Method not allowed"});
  }
  if(!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({error:"Storage is not configured"});
  if(!ffmpegPath) return res.status(500).json({error:"Native FFmpeg binary is unavailable"});

  const {source,start,duration,index,caption=""}=req.body||{};
  const s=Number(start), d=Number(duration);
  if(!source || !Number.isFinite(s) || !Number.isFinite(d) || d<=0) return res.status(400).json({error:"Invalid clip request"});

  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),"zlatyn-"));
  const input=path.join(dir,"source.mp4");
  const output=path.join(dir,"clip.mp4");
  try{
    await blobToFile(source,input);
    const vf=["crop=ih*9/16:ih:(iw-ow)/2:0","scale=1080:1920","unsharp=5:5:0.8:3:3:0.4"].join(",");
    const args=["-hide_banner","-loglevel","error","-ss",String(Math.max(0,s)),"-i",input,"-t",String(Math.max(.5,d)),"-vf",vf,"-af","loudnorm","-c:v","libx264","-preset","veryfast","-crf","23","-c:a","aac","-movflags","+faststart","-avoid_negative_ts","make_zero","-y",output];
    await runFFmpeg(args);
    const data=await fsp.readFile(output);
    const access=process.env.BLOB_ACCESS==="private"?"private":"public";
    const safeIndex=Number.isFinite(Number(index))?Number(index):0;
    const name=`clips/NDL_clip_${safeIndex+1}_${Math.round(d)}s_9x16.mp4`;
    const blob=await put(name,data,{access,addRandomSuffix:true,contentType:"video/mp4",cacheControlMaxAge:86400});
    const url=access==="private"?`/api/file?pathname=${encodeURIComponent(blob.pathname)}`:blob.url;
    return res.status(200).json({ok:true,url,pathname:blob.pathname,index:safeIndex,duration:d});
  }catch(error){
    console.error("Native FFmpeg processing error",error);
    return res.status(500).json({error:error?.message||"Clip processing failed"});
  }finally{
    await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
