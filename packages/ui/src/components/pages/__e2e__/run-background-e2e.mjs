/**
 * Real-browser integration e2e for the unified app background — no app server.
 * Bundles background-fixture.tsx (real BackgroundView + AppBackground over one
 * real store) with esbuild, loads it in headless chromium, and exercises the
 * whole consolidated system through real UI + real agent events:
 *
 *   1. default warm-orange shader
 *   2. click the "Blue" swatch        → background recolors live (color change)
 *   3. upload an image                → cover-image background (upload a picture)
 *   4. agent emits background:apply   → recolors from chat (chat → background)
 *   5. agent emits {op:"undo"}        → reverts to the previous (image)
 *   6. click the Undo control         → reverts again (UI undo)
 *
 * Captures a screenshot per step + a video walkthrough.
 *
 * Run: bun run --cwd packages/ui test:background-e2e
 */
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-background");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}

// A gradient SVG used as the uploaded "photo".
const uploadSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#059669"/><stop offset="1" stop-color="#e11d48"/>
  </linearGradient></defs>
  <rect width="1200" height="800" fill="url(#g)"/>
  <circle cx="900" cy="240" r="160" fill="#f4f4f5" opacity="0.85"/>
</svg>`;

const result = await build({
  entryPoints: [join(here, "background-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>background e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "background.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `bg-${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

const shaderColor = (p) =>
  p.evaluate(
    () =>
      document.querySelector('[data-testid="app-background-shader"]')?.style
        .backgroundColor ?? null,
  );
const count = (p, sel) => p.locator(sel).count();
const settle = (p) => p.waitForTimeout(350);

const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--force-color-profile=srgb",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1180, height: 820 },
  recordVideo: { dir: outDir, size: { width: 1180, height: 820 } },
});
const errors = [];
const p = await context.newPage();
p.on("pageerror", (e) => {
  errors.push(String(e));
  console.error(`  ⚠ pageerror: ${e}`);
});
p.on("console", (m) => {
  if (m.type() === "error") console.error(`  ⚠ console: ${m.text()}`);
});
try {
  await p.goto(url);
  await p.waitForSelector('[data-testid="bg-fixture-root"]', { timeout: 8000 });
  await settle(p);

  // 1. Default warm-orange shader.
  assert(
    (await shaderColor(p)) === "rgb(239, 90, 31)",
    "default renders the warm-orange shader",
  );
  await snap(p, "default-orange");

  // 2. Click the Green swatch in the REAL view → background recolors live.
  await p.getByLabel("Set background to Green").click();
  await settle(p);
  assert(
    (await shaderColor(p)) === "rgb(5, 150, 105)",
    "clicking the Green swatch recolors the background live",
  );
  await snap(p, "swatch-green");

  // 3. Upload an image → cover-image background.
  await p.setInputFiles('input[type="file"]', {
    name: "wallpaper.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(uploadSvg),
  });
  await settle(p);
  assert(
    (await count(p, '[data-testid="app-background-image"]')) === 1,
    "uploading an image switches to a cover-image background",
  );
  assert(
    (await count(p, '[data-testid="app-background-shader"]')) === 0,
    "the shader is replaced by the uploaded image",
  );
  await snap(p, "uploaded-image");

  // 4. Agent chat path: emit background:apply (shader teal) → recolors.
  await p.evaluate(() =>
    window.__emitBgApply?.({ op: "set", mode: "shader", color: "#059669" }),
  );
  await settle(p);
  assert(
    (await shaderColor(p)) === "rgb(8, 145, 178)",
    'agent "background:apply" recolors the background from chat',
  );
  await snap(p, "chat-apply-teal");

  // 5. Agent emits undo → reverts to the previous (the uploaded image).
  await p.evaluate(() => window.__emitBgApply?.({ op: "undo" }));
  await settle(p);
  assert(
    (await count(p, '[data-testid="app-background-image"]')) === 1,
    'agent "undo" reverts to the previous (image) background',
  );
  await snap(p, "chat-undo-to-image");

  // 6. Click the Undo control in the view → reverts again (to blue).
  await p.getByLabel("Undo background change").click();
  await settle(p);
  assert(
    (await shaderColor(p)) === "rgb(37, 99, 235)",
    "the Undo control reverts to the prior shader color",
  );
  await snap(p, "ui-undo-to-blue");
} finally {
  await context.close(); // flush the video
  await browser.close();
}

// Give the recorded video a stable, committable name.
for (const f of await readdir(outDir)) {
  if (f.endsWith(".webm")) {
    await rename(join(outDir, f), join(outDir, "walkthrough.webm"));
    console.log("  🎥 walkthrough.webm");
    break;
  }
}

assert(errors.length === 0, `no uncaught page errors (${errors.length})`);
for (const e of errors) console.error(`  ⚠ ${e}`);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✅ background integration e2e passed");
