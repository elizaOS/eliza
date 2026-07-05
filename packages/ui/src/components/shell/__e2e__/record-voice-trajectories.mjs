/**
 * Records a screen-capture VIDEO of the voice / voice-chat trajectories on the
 * live-mic continuous-chat overlay — the surface that carries the microphone
 * button and the transcript toggle. It reuses the same esbuild bundle as
 * run-chat-sheet-e2e.mjs, then drives the fixture through the canonical voice
 * trajectories with real pointer input under Playwright's recordVideo, so the
 * output is a real .webm walkthrough (no app server, no real audio/models).
 *
 * Trajectories captured (see ../../../voice/VOICE_UX.md):
 *   1. Idle composer (mic at rest).
 *   2. Always-on mic: tap mic → listening (interim transcript) → send → the
 *      agent responds (thinking → speaking) → mic re-opens.
 *   3. Speaking state with the mute toggle.
 *   4. A long open transcript thread scrolled in the maximized sheet.
 *
 * Run: bun run --cwd packages/ui src/components/shell/__e2e__/record-voice-trajectories.mjs
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
// The binary .webm video is generated-locally only (gitignored). Durable PNG
// keyframes — one per trajectory state — land in the tracked screenshots dir so
// the walkthrough is reviewable in-repo without the binary.
const outDir = join(here, "output-voice-recording");
const shotDir = join(here, "output-voice");
await mkdir(outDir, { recursive: true });
await mkdir(shotDir, { recursive: true });
let shot = 0;
async function snap(name) {
  shot += 1;
  await page.screenshot({
    path: join(shotDir, `${String(shot).padStart(2, "0")}-${name}.png`),
  });
}

// --- Bundle the fixture (same stubs as run-chat-sheet-e2e.mjs) ------------
const stubElizaCore = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      contents: `
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy(
          {
            isViewVisible: () => true,
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
            findInteractionRegions: () => [],
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
      loader: "js",
    }));
  },
};
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.replace(/^node:/, "").split("/")[0];
      if (
        args.path.startsWith("node:") ||
        nodeBuiltins.has(args.path) ||
        builtinModules.includes(bare)
      ) {
        return { path: args.path, namespace: "node-stub" };
      }
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents:
        "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
      loader: "js",
    }));
  },
};
const result = await build({
  entryPoints: [join(here, "chat-sheet-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>voice trajectories</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#0a0d16}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "voice-trajectories.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 420, height: 880 },
  recordVideo: { dir: outDir, size: { width: 420, height: 880 } },
});
const page = await context.newPage();

async function load(query, label, shotName) {
  await page.goto(`${url}${query}`);
  await page.waitForSelector('[data-testid="chat-sheet"]', { timeout: 15000 });
  console.log(`▶ ${label}`);
  await sleep(1200);
  if (shotName) await snap(shotName);
}

// 1) Idle composer — mic at rest.
await load("", "idle composer (mic at rest)", "idle");

// 2) Always-on mic trajectory: tap the mic → listening with interim transcript.
const mic = page.getByLabel(/mic|microphone|voice/i).first();
if (await mic.count()) {
  await mic.click().catch(() => {});
  console.log("▶ tap mic → listening");
  await sleep(1800);
}

// 3) Listening state with a live interim transcript (deterministic load).
await load("?recording&transcript=hey%20eliza%2C%20what%27s%20on%20my%20calendar", "listening + interim transcript", "listening");

// 4) Agent responding (thinking / streaming dots).
await load("?streaming", "agent responding (thinking)", "responding");

// 5) Agent speaking aloud + mute toggle.
await load("?speaking", "agent speaking (TTS) + mute toggle", "speaking");
await sleep(1400);

// 6) Open thread — pull the sheet to full and let the transcript settle.
await load("?phase=summoned", "open transcript thread", "open-thread");
const grabber = page.getByTestId("chat-sheet-grabber");
if (await grabber.count()) {
  const box = await grabber.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, 120, { steps: 24 });
    await page.mouse.up();
    console.log("▶ pull sheet to full");
    await sleep(1600);
  }
}

await context.close(); // flushes the video
await browser.close();

// Name the produced video deterministically.
const { readdir } = await import("node:fs/promises");
const files = await readdir(outDir);
const webm = files.find((f) => f.endsWith(".webm"));
if (webm) {
  const finalName = "voice-trajectories.webm";
  await rename(join(outDir, webm), join(outDir, finalName));
  console.log(`\n🎬 Saved ${join(outDir, finalName)}`);
} else {
  console.log("\n⚠ No video produced");
  process.exit(1);
}
