#!/usr/bin/env node
/**
 * Multi-threaded static file server for storybook-static/. Python's http.server
 * is single-threaded and chokes when Playwright loads ~1300 stories in
 * sequence; this stays responsive.
 */
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

const root = resolve(process.argv[2] || "storybook-static");
const port = Number(process.argv[3] || 6006);

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    let url = req.url.split("?")[0];
    if (url === "/") url = "/index.html";
    const p = join(root, decodeURIComponent(url));
    if (!p.startsWith(root)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    const s = await stat(p).catch(() => null);
    if (!s || !s.isFile()) {
      // Fallback to index.html for SPA
      const buf = await readFile(join(root, "index.html"));
      res.writeHead(200, { "content-type": "text/html" });
      res.end(buf);
      return;
    }
    const buf = await readFile(p);
    const ct = TYPES[extname(p).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": ct,
      "cache-control": "public, max-age=300",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.message || e));
  }
});

server.keepAliveTimeout = 30000;
server.headersTimeout = 35000;
server.listen(port, () => {
  console.error(`Serving ${root} on http://localhost:${port}`);
});
