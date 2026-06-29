// Static server for the XR harness pages. Serves:
//   /             → e2e/test-page.html  (flat 2D harness target)
//   /scene        → e2e/scene/index.html (real XRSpatialScene fixture, 3D)
//   /scene/*.js   → e2e/scene/dist/*     (the built scene bundle + sourcemap)
// No real agent is required — the harness drives the injected IWER emulator.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.XR_HARNESS_PORT ?? 31350);
const flatPage = readFileSync(join(here, "test-page.html"), "utf8");
const scenePage = existsSync(join(here, "scene/index.html"))
  ? readFileSync(join(here, "scene/index.html"), "utf8")
  : "<!doctype html><title>scene bundle missing — run scene:build</title>";

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (path === "/" || path === "/index.html") return sendHtml(res, flatPage);
  if (path === "/scene" || path === "/scene/") return sendHtml(res, scenePage);

  // Serve built scene assets from e2e/scene/dist (scene-bundle.js + map).
  if (path.startsWith("/scene/")) {
    const file = join(here, "scene", "dist", path.slice("/scene/".length));
    if (existsSync(file)) {
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      });
      res.end(readFileSync(file));
      return;
    }
  }

  res.writeHead(404);
  res.end("not found");
}).listen(port, () => {
  console.log(`[xr-harness] pages on http://localhost:${port} (/ and /scene)`);
});
