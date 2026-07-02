// Evidence capture (#8792 item (a)) — the sanctioned path: serve the freshly
// built Storybook catalog (packages/ui/storybook-static) and screenshot the
// REAL `Settings/CapabilitiesSection` story, proving the settings UI exposes
// the "Proactive suggestions" off/subtle/chatty control (persisted as
// ELIZA_PROACTIVE_INTERACTIONS). Captures the section, the control scrolled
// into view, and the select's option list open.
//
// Run (after `bun run --cwd packages/ui build-storybook`):
//   bun .github/issue-evidence/8792-10694-proactive-shader/settings-screenshots/capture-storybook.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = join(here, "..", "..", "..", "..", "packages", "ui", "storybook-static");
const PORT = 36700; // leg W7 port range 36700-36799

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
    const file = join(staticDir, rel === "" ? "index.html" : rel);
    if (!file.startsWith(staticDir)) throw new Error("traversal");
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
page.on("pageerror", (e) => console.error("pageerror:", String(e)));
await page.goto(
  `http://127.0.0.1:${PORT}/iframe.html?id=settings-capabilitiessection--default&viewMode=story`,
);
const control = page.getByTestId("capability-proactive-suggestions");
await control.waitFor({ state: "visible", timeout: 20_000 });
await page.waitForTimeout(800);

await page.screenshot({
  path: join(here, "capabilities-section-full.png"),
  fullPage: true,
});
await control.scrollIntoViewIfNeeded();
await page.screenshot({
  path: join(here, "capabilities-proactive-control.png"),
});
await control.click();
await page.waitForTimeout(500);
await page.screenshot({
  path: join(here, "capabilities-proactive-options-open.png"),
});

await browser.close();
server.close();
console.log(
  "captured capabilities-section-full.png, capabilities-proactive-control.png, capabilities-proactive-options-open.png",
);
