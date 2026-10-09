import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

app.disable("x-powered-by");
app.use(express.static(ROOT, { index: "index.html", etag: true, maxAge: "1h" }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(ROOT, "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log("Zlatyn static website is listening on " + PORT + ". Video cutting runs in the user's browser.");
});
