import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
const root = new URL("../site/", import.meta.url).pathname;
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
createServer((req, res) => {
  const path = join(root, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  res.setHeader("content-type", types[extname(path)] || "application/octet-stream");
  createReadStream(path).on("error", () => { res.statusCode = 404; res.end("not found"); }).pipe(res);
}).listen(8877, "127.0.0.1", () => console.log("http://127.0.0.1:8877"));
