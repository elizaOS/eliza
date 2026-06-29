/**
 * Real-browser gesture e2e + video capture for the chat-UX TopicGroup (#8928).
 * Bundles chatux-gesture-fixture.tsx with esbuild, loads it in headless chromium
 * via Playwright, and drives REAL pointer gestures:
 *
 *   - TopicGroup: flick UP on the header → collapses to a pill (no buttons);
 *     tap the pill → expands.
 *
 * Conversation-swipe coverage moved to run-conversation-swipe-e2e.mjs, which
 * drives the REAL ContinuousChatOverlay through a new-conversation interleaving
 * (#9954). The local `ConversationSwiper` mock that used to be asserted here was
 * deleted — it passed while exercising none of the real conversation-nav path.
 *
 * Captures a screenshot per state AND records a continuous .webm video of the
 * whole sequence. Exits non-zero on any failed assertion or page error.
 *
 * Run: bun run --cwd packages/ui test:chatux-gesture-e2e
 */

import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-chatux");
const videoDir = join(outDir, "video");
await mkdir(outDir, { recursive: true });
await mkdir(videoDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Stub node builtins (dead in the browser) so the bundle builds.
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
  entryPoints: [join(here, "chatux-gesture-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chatux gesture e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#16121c}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "chatux-gesture.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

/** Dispatch a real touch-pointer drag from an element's centre by (dx, dy). */
async function drag(p, testid, dx, dy, { steps = 10, slow = false } = {}) {
  const box = await p.getByTestId(testid).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await p.evaluate(
    ({ cx, cy }) => {
      const el = document.elementFromPoint(cx, cy);
      window.__t = el;
      el?.dispatchEvent(
        new PointerEvent("pointerdown", {
          pointerId: 1,
          pointerType: "touch",
          clientX: cx,
          clientY: cy,
          bubbles: true,
        }),
      );
    },
    { cx, cy },
  );
  for (let i = 1; i <= steps; i += 1) {
    const x = cx + (dx * i) / steps;
    const y = cy + (dy * i) / steps;
    await p.evaluate(
      ({ x, y }) =>
        window.__t?.dispatchEvent(
          new PointerEvent("pointermove", {
            pointerId: 1,
            pointerType: "touch",
            clientX: x,
            clientY: y,
            bubbles: true,
          }),
        ),
      { x, y },
    );
    if (slow) await p.waitForTimeout(24);
  }
  await p.evaluate(
    ({ x, y }) =>
      window.__t?.dispatchEvent(
        new PointerEvent("pointerup", {
          pointerId: 1,
          pointerType: "touch",
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      ),
    { x: cx + dx, y: cy + dy },
  );
}

const logs = [];
const errors = [];
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 600, height: 760 },
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 600, height: 760 } },
});
const page = await context.newPage();
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForTimeout(400);

// ── 1. TopicGroup: flick UP on the header → collapse ────────────────────
await snap(page, "topic-expanded");
assert(
  await page.getByTestId("topic-group-header").isVisible(),
  "TopicGroup starts EXPANDED (quiet divider header, no chevron button)",
);
// Fast (no-wait) upward drag of ~70px = a flick → onPullUp → collapse.
await drag(page, "topic-group-header", 0, -70, { steps: 8, slow: false });
await page.waitForTimeout(250);
const collapsedPill = page.getByTestId("topic-group-pill");
assert(
  await collapsedPill.isVisible(),
  "Flick UP collapses the group to a pill (● topic — N messages)",
);
await snap(page, "topic-collapsed-after-flick");

// ── 2. Flick DOWN on the pill → expand again (gesture, no buttons) ───────
await drag(page, "topic-group-pill", 0, 90, { steps: 8, slow: false });
await page.waitForTimeout(250);
assert(
  await page.getByTestId("topic-group-header").isVisible(),
  "Flick DOWN on the pill expands the group again",
);
await snap(page, "topic-expanded-after-flick-down");

assert(errors.length === 0, `no page errors (saw ${errors.length})`);
if (errors.length) console.log(errors.join("\n"));

await page.close(); // flush the video
await context.close();
await browser.close();

// Rename the recorded video to a stable name.
const vids = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
if (vids[0]) {
  await rename(join(videoDir, vids[0]), join(outDir, "chatux-gestures.webm"));
  console.log(`  🎬 chatux-gestures.webm`);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
