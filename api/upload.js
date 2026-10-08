import { handleUpload } from "@vercel/blob/client";

export default async function handler(req,res){
  if(req.method!=="POST"){
    res.setHeader("Allow","POST");
    return res.status(405).json({error:"Method not allowed"});
  }
  if(!process.env.BLOB_READ_WRITE_TOKEN){
    return res.status(503).json({error:"BLOB_READ_WRITE_TOKEN is not configured"});
  }
  try{
    const body=req.body;
    const json=typeof body==="string"?JSON.parse(body):body;
    const result=await handleUpload({
      body:json,
      request:req,
      onBeforeGenerateToken:async(pathname)=>{
        const access=process.env.BLOB_ACCESS==="private"?"private":"public";
        return {
          allowedContentTypes:["video/*"],
          maximumSizeInBytes:20*1024*1024*1024,
          addRandomSuffix:true,
          tokenPayload:JSON.stringify({kind:"zlatyn-video"}),
          access
        };
      },
      onUploadCompleted:async()=>{}
    });
    return res.status(200).json(result);
  }catch(error){
    console.error("Blob upload token error",error);
    return res.status(500).json({error:error?.message||"Upload initialization failed"});
  }
}
