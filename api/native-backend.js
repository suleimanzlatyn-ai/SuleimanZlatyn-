import { Sandbox } from "@vercel/sandbox";

export default async function handler(req,res){
  if(req.method!=="GET"){
    res.setHeader("Allow","GET");
    return res.status(405).json({ok:false,error:"Method not allowed"});
  }
  try{
    const sandbox=await Sandbox.getOrCreate({
      name:"zlatyn-ffmpeg-worker",
      timeout:45*60*1000,
      persistent:true,
      resources:{vcpus:2}
    });
    const check=await sandbox.runCommand({
      cmd:"bash",
      args:["-lc","pgrep -f '/vercel/zlatyn-worker/server3.js' >/dev/null || (nohup node /vercel/zlatyn-worker/server3.js >/tmp/zlatyn-backend.log 2>&1 &)"],
      detached:true
    });
    return res.status(200).json({ok:true,backend:true,url:sandbox.domain(8082),sandbox:"zlatyn-ffmpeg-worker"});
  }catch(error){
    console.error("native backend bootstrap failed",error);
    return res.status(503).json({ok:false,backend:false,error:error?.message||"Native backend unavailable"});
  }
}