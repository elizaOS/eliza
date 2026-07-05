/**
 * REAL-browser repro for "can't scroll chat on web" (#chat-scroll-web).
 *
 * Seeds a LONG transcript (`?many`), opens the sheet to FULL, then measures the
 * scroll container (`#continuous-thread`) in a real Chromium layout:
 *   1. HEIGHT CHAIN — does the `overflow-y-auto` scroller resolve to a BOUNDED
 *      clientHeight SMALLER than its scrollHeight (so there is overflow to
 *      scroll), or does it size to content (clientHeight == scrollHeight → no
 *      overflow, nothing scrolls)?
 *   2. NATIVE TOUCH SCROLL — a real vertical finger-drag on the transcript must
 *      move scrollTop (native scroll), NOT be hijacked into the sheet pull.
 *
 * This is the harness the fix is proven against: RED before, GREEN after.
 * Bundles chat-sheet-fixture.tsx the same way run-chat-sheet-e2e.mjs does.
 *
 * Run: node src/components/shell/__e2e__/run-chat-scroll-web-e2e.mjs
 * Exits non-zero on any failed assertion / console error.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright";
import { touchDragHold } from "../../../testing/real-touch-gestures.ts";

// `ENGINE=webkit` runs the SAME harness under WebKit — the iOS Safari layout
// engine, where the height-chain fragility (`height:100%` against a
// flex-basis-sized parent) actually reproduces. Chromium resolves it, so the
// Chromium pass is a non-regression guard; the WebKit pass is the real proof.
const ENGINE = process.env.ENGINE === "webkit" ? webkit : chromium;
const ENGINE_NAME = process.env.ENGINE === "webkit" ? "webkit" : "chromium";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "\u2713" : "\u2717"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// --- same bundle stubs as run-chat-sheet-e2e.mjs -------------------------
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
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat scroll web e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#0a0d16}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "chat-scroll-web.html");
await writeFile(htmlPath, html);
// `?many` = long transcript.
const url = `file://${htmlPath}?many`;

const THREAD = '[data-testid="chat-thread"]';
const SCROLLER = "#continuous-thread";
const GRABBER = '[data-testid="chat-sheet-grabber"]';

// Open the sheet to the FULL detent. Touch-drag (CDP) on Chromium; keyboard
// disclosure (ArrowUp on the grabber, WCAG-operable) on WebKit where CDP touch
// is unavailable — both reach the same open state so the height chain is
// measured identically.
async function openToFull(page) {
  if (ENGINE_NAME === "chromium") {
    await (
      await touchDragHold(page, GRABBER, 0, -260, { steps: 16, stepDelayMs: 8 })
    ).release();
    await page.waitForTimeout(500);
    await (
      await touchDragHold(page, GRABBER, 0, -400, { steps: 16, stepDelayMs: 8 })
    ).release();
    await page.waitForTimeout(600);
    return;
  }
  // WebKit: focus the grabber and press ArrowUp to open, then again for full.
  const grabber = page.locator(GRABBER);
  await grabber.focus();
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(500);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(600);
}

async function measure(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: cs.overflowY,
      touchAction: cs.touchAction,
      scrollTop: el.scrollTop,
    };
  }, SCROLLER);
}

console.log(`engine: ${ENGINE_NAME}`);
const browser = await ENGINE.launch(
  ENGINE_NAME === "chromium" ? { args: ["--no-sandbox"] } : {},
);
const consoleErrors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector('[data-testid="chat-sheet"]');
  await page.waitForTimeout(700);

  await openToFull(page);
  await page.waitForSelector(THREAD);
  await page.waitForTimeout(300);

  const chatState = await page
    .locator('[data-testid="chat-sheet"]')
    .getAttribute("data-chat-state");
  console.log(`  chat-state after open: ${chatState}`);

  const m = await measure(page);
  console.log(`  scroller measure: ${JSON.stringify(m)}`);
  assert(!!m, `scroller ${SCROLLER} is present`);

  // 1) HEIGHT CHAIN: the scroller must be BOUNDED below its content (overflow).
  assert(
    m.overflowY === "auto" || m.overflowY === "scroll",
    `scroller computes overflow-y: auto/scroll (got ${m.overflowY})`,
  );
  assert(
    m.scrollHeight > m.clientHeight + 8,
    `scroller has real overflow: scrollHeight(${m.scrollHeight}) > clientHeight(${m.clientHeight}) — a BOUNDED height smaller than content`,
  );

  // 1b) PROGRAMMATIC SCROLLABILITY (engine-agnostic): setting scrollTop must
  //     stick — only possible when the viewport is bounded below its content.
  //     If the scroller sized to content (the bug), scrollTop clamps to 0.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = Math.round(el.scrollHeight / 2);
  }, SCROLLER);
  await page.waitForTimeout(150);
  const midSet = (await measure(page)).scrollTop;
  assert(
    midSet > 20,
    `scroller accepts a mid scrollTop (bounded viewport): scrollTop settled at ${midSet}`,
  );

  // The touch-driven assertions below use CDP (Chromium only). WebKit proves the
  // height chain via the layout + programmatic checks above (the iOS-Safari
  // failure mode is the height chain, not the gesture).
  if (ENGINE_NAME !== "chromium") {
    await page.screenshot({
      path: join(outDir, `chat-scroll-web-${ENGINE_NAME}.png`),
    });
    if (consoleErrors.length)
      for (const e of consoleErrors) console.log("  ERR:", e);
    assert(
      consoleErrors.length === 0,
      `no console errors (${consoleErrors.length})`,
    );
    if (failures > 0) {
      console.error(`\n${failures} assertion(s) FAILED [${ENGINE_NAME}]`);
      process.exit(1);
    }
    console.log(`\nAll scroll-web assertions passed [${ENGINE_NAME}].`);
    await browser.close();
    process.exit(0);
  }

  // 2) NATIVE TOUCH SCROLL: a vertical finger-drag UP on the transcript must
  //    move scrollTop (native scroll), not drive the sheet pull.
  const before = (await measure(page)).scrollTop;
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = Math.round(el.scrollHeight / 2);
  }, SCROLLER);
  await page.waitForTimeout(150);
  const mid = (await measure(page)).scrollTop;
  // Finger drag DOWN on the transcript body → native scroll UP (scrollTop
  // decreases). Use a slow, purely-vertical drag well inside the scroller.
  await (
    await touchDragHold(page, SCROLLER, 0, 220, { steps: 20, stepDelayMs: 6 })
  ).release();
  await page.waitForTimeout(400);
  const after = (await measure(page)).scrollTop;
  console.log(
    `  scrollTop: before-open=${before} mid=${mid} after-drag=${after}`,
  );
  assert(
    Math.abs(after - mid) > 20,
    `vertical finger-drag scrolls the transcript natively (scrollTop moved from ${mid} to ${after})`,
  );

  // Sheet must NOT have collapsed/changed detent from that vertical scroll drag.
  const stateAfter = await page
    .locator('[data-testid="chat-sheet"]')
    .getAttribute("data-chat-state");
  assert(
    stateAfter === chatState,
    `sheet detent unchanged by the scroll drag (${chatState} -> ${stateAfter})`,
  );

  // 3) REALISTIC THUMB SCROLL with horizontal drift: a real finger scroll is
  //    never perfectly vertical. If a vertical scroll with modest horizontal
  //    wobble (>0.8x the vertical, the widened swipe cone) wrongly commits to
  //    the X (swipe) axis, it captures the pointer + drives the rail instead of
  //    scrolling — the exact "can't scroll" mechanism. Assert a drift-y drag
  //    still scrolls natively and does NOT fire a conversation swipe.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = Math.round(el.scrollHeight / 2);
  }, SCROLLER);
  await page.waitForTimeout(150);
  const midDrift = (await measure(page)).scrollTop;
  const convIdBefore = await page
    .locator('[data-testid="chat-sheet"]')
    .getAttribute("data-conversation-id");
  // Finger drag mostly DOWN (dy=+200) with real horizontal drift (dx=+70 ~ 0.35x
  // — below 0.8x, should stay vertical) then a steeper wobble case.
  await (
    await touchDragHold(page, SCROLLER, 70, 200, { steps: 22, stepDelayMs: 6 })
  ).release();
  await page.waitForTimeout(400);
  const afterDrift = (await measure(page)).scrollTop;
  const convIdAfter = await page
    .locator('[data-testid="chat-sheet"]')
    .getAttribute("data-conversation-id");
  console.log(
    `  drift-scroll: mid=${midDrift} after=${afterDrift} conv ${convIdBefore}->${convIdAfter}`,
  );
  assert(
    Math.abs(afterDrift - midDrift) > 20,
    `vertical-dominant drag WITH horizontal drift still scrolls natively (${midDrift} -> ${afterDrift})`,
  );
  assert(
    convIdBefore === convIdAfter,
    `a drift scroll did NOT trigger a conversation swipe (${convIdBefore} -> ${convIdAfter})`,
  );

  await page.screenshot({ path: join(outDir, "chat-scroll-web-full.png") });
} finally {
  await browser.close();
}

assert(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
if (consoleErrors.length) for (const e of consoleErrors) console.log("  ERR:", e);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll scroll-web assertions passed.");
