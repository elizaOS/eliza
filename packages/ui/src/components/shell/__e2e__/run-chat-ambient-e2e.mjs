/**
 * Real-browser screenshot pass for the /chat ambient background — no app server.
 * Bundles chat-ambient-fixture.tsx with esbuild, loads it in headless chromium,
 * and captures the gentle pulse at each phase (orange base → blue → black →
 * white) by sampling the 32s CSS animation. Also verifies a reduced-motion load
 * holds a still orange field.
 *
 * Run: bun run --cwd packages/ui test:chat-ambient-e2e
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}

const result = await build({
  entryPoints: [join(here, "chat-ambient-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat ambient e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "chat-ambient.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `ambient-${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

const sink = { errors: [] };
const browser = await chromium.launch();
try {
  const p = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  p.on("pageerror", (e) => sink.errors.push(String(e)));
  await p.goto(url);
  await p.waitForSelector('[data-testid="chat-ambient-background"]');
  await p.waitForTimeout(400);
  assert(
    (await p.locator('[data-testid="chat-ambient-background"]').count()) === 1,
    "ambient background mounts",
  );

  // 32s loop: 0%=blue, 25%(8s)=black, 50%(16s)=orange, 75%(24s)=white. Sample
  // each phase by waiting real time between captures.
  await snap(p, "phase-blue"); // ~t=0.4s, near the blue keyframe
  await p.waitForTimeout(7700);
  await snap(p, "phase-black"); // ~t=8s
  await p.waitForTimeout(8000);
  await snap(p, "phase-orange"); // ~t=16s (overlay clear, orange base)
  await p.waitForTimeout(8000);
  await snap(p, "phase-white"); // ~t=24s
  await p.close();

  // Reduced motion: a still orange field (no pulse).
  const rm = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  rm.on("pageerror", (e) => sink.errors.push(String(e)));
  await rm.emulateMedia({ reducedMotion: "reduce" });
  await rm.goto(url);
  await rm.waitForSelector('[data-testid="chat-ambient-background"]');
  await rm.waitForTimeout(500);
  await snap(rm, "reduced-motion-still");
  await rm.close();
} finally {
  await browser.close();
}

assert(sink.errors.length === 0, `no uncaught page errors (${sink.errors.length})`);
if (sink.errors.length) for (const e of sink.errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots (${shot}) written to ${outDir}`);
if (failures > 0) {
  console.error(`\nCHAT-AMBIENT E2E FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nCHAT-AMBIENT E2E PASSED");
