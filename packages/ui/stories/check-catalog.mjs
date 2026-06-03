// Serve the built catalog dist and load index.html headless to surface the
// runtime errors that made the dev server redirect `/` away.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dist = fileURLToPath(new URL("./dist", import.meta.url));
const page = process.argv[2] || "index.html";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
};
const server = createServer(async (req, res) => {
  try {
    let p = req.url.split("?")[0];
    if (p === "/") p = "/index.html";
    const buf = await readFile(join(dist, p));
    res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const browser = await chromium.launch();
const pg = await browser.newPage();
const errs = [];
pg.on("console", (m) => m.type() === "error" && errs.push("console: " + m.text()));
pg.on("pageerror", (e) => errs.push("pageerror: " + (e?.stack || e?.message || String(e))));
pg.on("requestfailed", (r) => errs.push("reqfailed: " + r.url() + " " + (r.failure()?.errorText || "")));
pg.on("response", (r) => r.status() >= 400 && errs.push("http" + r.status() + ": " + r.url()));
await pg.goto(`${base}/${page}`, { waitUntil: "load", timeout: 30000 });
await pg.waitForTimeout(1500);
const info = await pg.evaluate(() => {
  const root = document.getElementById("root");
  return {
    rootChildren: root ? root.children.length : -1,
    bodyText: (document.body.innerText || "").slice(0, 200),
    sections: document.querySelectorAll(".gallery-section").length,
  };
});
console.log("=== catalog load:", page, "===");
console.log(JSON.stringify(info, null, 2));
console.log("\nerrors:", errs.length);
for (const e of errs.slice(0, 10)) console.log("  " + e.replace(/\n/g, "\n    "));
await browser.close();
server.close();
