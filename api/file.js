import { get } from "@vercel/blob";

export default async function handler(req,res){
  if(req.method!=="GET") return res.status(405).end();
  if(process.env.BLOB_ACCESS!=="private") return res.status(404).end();
  const pathname=String(req.query?.pathname||"");
  if(!pathname) return res.status(400).send("Missing pathname");
  try{
    const result=await get(pathname,{access:"private"});
    if(!result || result.statusCode!==200) return res.status(404).send("Not found");
    res.statusCode=200;
    res.setHeader("Content-Type",result.blob.contentType||"application/octet-stream");
    res.setHeader("Cache-Control","private, no-cache");
    if(result.blob.etag) res.setHeader("ETag",result.blob.etag);
    result.stream.pipe(res);
  }catch(error){
    console.error("Private blob read error",error);
    res.status(500).send("Unable to read clip");
  }
}
