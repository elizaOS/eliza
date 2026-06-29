// Minimal static server for the XR harness test page. Serves e2e/test-page.html
// at "/" so the Playwright config can boot a real http://localhost origin (no
// real agent required — the harness drives the injected IWER emulator).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.XR_HARNESS_PORT ?? 31350);
const page = readFileSync(join(here, "test-page.html"), "utf8");

createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(port, () => {
  console.log(`[xr-harness] test page on http://localhost:${port}`);
});
