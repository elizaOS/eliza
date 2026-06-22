/**
 * Real-browser screenshot e2e for the unified app background — no app server.
 * Bundles background-fixture.tsx with esbuild, loads it in headless chromium,
 * and drives the real AppBackground config store: shader colors and a cover
 * image. Proves the single background layer renders every mode and recolors live
 * (the same layer the home and Views catalog share).
 *
 * Run: bun run --cwd packages/ui test:background-e2e
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-background");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}

const sampleImage =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#0891b2"/><stop offset="1" stop-color="#7c3aed"/>
       </linearGradient></defs>
       <rect width="1200" height="800" fill="url(#g)"/>
       <circle cx="900" cy="240" r="160" fill="#f4f4f5" opacity="0.85"/>
     </svg>`,
  );

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
        .backgroundColor,
  );
const count = (p, sel) => p.locator(sel).count();

const browser = await chromium.launch();
const errors = [];
try {
  const p = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(url);
  await p.waitForSelector('[data-testid="bg-fixture-root"]');
  await p.waitForTimeout(400);

  // Default warm-orange shader.
  assert(
    (await shaderColor(p)) === "rgb(239, 90, 31)",
    "default renders the warm-orange shader",
  );
  await snap(p, "shader-orange");

  // Recolor live — same mounted layer, new color (no remount/flash).
  await p.evaluate(() => window.__setBg?.({ mode: "shader", color: "#0891b2" }));
  await p.waitForTimeout(300);
  assert((await shaderColor(p)) === "rgb(8, 145, 178)", "shader recolors live");
  await snap(p, "shader-teal");

  await p.evaluate(() => window.__setBg?.({ mode: "shader", color: "#7c3aed" }));
  await p.waitForTimeout(300);
  await snap(p, "shader-violet");

  // Cover image mode.
  await p.evaluate(
    (img) => window.__setBg?.({ mode: "image", color: "#000000", imageUrl: img }),
    sampleImage,
  );
  await p.waitForTimeout(400);
  assert(
    (await count(p, '[data-testid="app-background-image"]')) === 1,
    "image mode renders the cover image",
  );
  assert(
    (await count(p, '[data-testid="app-background-shader"]')) === 0,
    "shader is replaced by the image",
  );
  await snap(p, "image-cover");

  await p.close();
} finally {
  await browser.close();
}

assert(errors.length === 0, `no uncaught page errors (${errors.length})`);
for (const e of errors) console.error(`  ⚠ ${e}`);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✅ background e2e passed");
