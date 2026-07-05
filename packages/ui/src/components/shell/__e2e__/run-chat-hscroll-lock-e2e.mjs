/**
 * REAL-browser regression guard that the chat transcript is vertical-only
 * (#14328). `#continuous-thread` sets `overflow-y-auto`; per CSS Overflow that
 * alone coerces the cross axis from `visible` to `auto`, so any child a hair too
 * wide (an attachment preview, an inline widget) silently turns the whole thread
 * into a horizontal panner. `touch-pan-y` blocks a touch drag but does NOT block
 * a trackpad/wheel `deltaX`, so on desktop a diagonal two-finger scroll pans the
 * transcript sideways — the single worst trust break on a chat surface.
 *
 * The fix is `overflow-x-hidden` on the scroller (ContinuousChatOverlay). This
 * harness dispatches REAL wheel events:
 *
 *   1. VERTICAL-ONLY (both engines) — with the real transcript the thread has no
 *      horizontal overflow (scrollWidth == clientWidth); a diagonal wheel (large
 *      deltaX + deltaY) must keep `scrollLeft` at 0 while `scrollTop` moves.
 *   2. SAFETY-NET, RED→GREEN (Chromium only) — inject a rogue over-wide child so
 *      the thread genuinely overflows in X; `overflow-x-hidden` must still hold
 *      `scrollLeft` at 0. Strip the class and the same wheel pans it to ~600 —
 *      the regression this guards. This assertion is Chromium-only because
 *      WebKitGTK applies a diagonal wheel's whole delta vector to any scroll
 *      container (`overflow-y:auto`) regardless of `overflow-x`, and rejects
 *      `overflow-x:clip` outright — so the CSS safety net cannot be proven on it.
 *      That gap is a headless-WebKit input quirk, not a product hole: iOS input
 *      is touch, blocked by `touch-pan-y`; step 1 proves the real-content case on
 *      WebKit; and real Safari 16+ honors the axis lock.
 *   3. CONTAINMENT (both engines) — a designed inner scroller (`overflow-x-auto`
 *      + `overscroll-x-contain`, the code-block / attachment-preview pattern)
 *      scrolls horizontally inside its own box and does NOT chain out to the
 *      thread.
 *
 * Runs under Chromium AND WebKit (the iOS Safari engine) — `ENGINE=webkit`.
 * Bundles chat-sheet-fixture.tsx exactly like run-chat-scroll-web-e2e.mjs.
 *
 * Run: node src/components/shell/__e2e__/run-chat-hscroll-lock-e2e.mjs
 * Exits non-zero on any failed assertion / console error.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright";
import { touchDragHold } from "../../../testing/real-touch-gestures.ts";

const ENGINE = process.env.ENGINE === "webkit" ? webkit : chromium;
const ENGINE_NAME = process.env.ENGINE === "webkit" ? "webkit" : "chromium";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// Same bundle stubs as run-chat-scroll-web-e2e.mjs — the fixture mounts the real
// ContinuousChatOverlay, so the CSS under test is the production className.
const stubPromptSuggestions = {
  name: "stub-prompt-suggestions",
  setup(b) {
    b.onResolve({ filter: /usePromptSuggestions\.stub$/ }, (args) => ({
      path: args.path,
      namespace: "prompt-suggestions-stub",
    }));
    b.onResolve({ filter: /usePromptSuggestions$/ }, () => ({
      path: join(here, "usePromptSuggestions.stub.ts"),
    }));
  },
};
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
  plugins: [stubPromptSuggestions, stubElizaCore, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat hscroll lock e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#0a0d16}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "chat-hscroll-lock.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}?many`;

const SCROLLER = "#continuous-thread";
const GRABBER = '[data-testid="chat-sheet-grabber"]';

// Open the sheet to FULL so `#continuous-thread` is mounted and laid out. Touch
// drag on Chromium (CDP), keyboard disclosure on WebKit (no CDP touch) — same as
// run-chat-scroll-web-e2e.mjs.
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
  const grabber = page.locator(GRABBER);
  await grabber.focus();
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(500);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(600);
}

async function centerOf(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
}

console.log(`engine: ${ENGINE_NAME}`);
const browser = await ENGINE.launch(
  ENGINE_NAME === "chromium" ? { args: ["--no-sandbox"] } : {},
);
const consoleErrors = [];
try {
  // Desktop viewport, NOT mobile emulation: the bug is a trackpad/wheel deltaX
  // on desktop (touch-pan-y already blocks the touch axis). Mobile emulation
  // routes scroll through touch and swallows synthetic wheel deltas, which would
  // make the lock assertion pass vacuously. hasTouch stays on only so the CDP
  // touch-drag that opens the sheet still works.
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
    hasTouch: true,
    isMobile: false,
    deviceScaleFactor: 1,
  });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector('[data-testid="chat-sheet"]');
  await page.waitForTimeout(700);

  await openToFull(page);
  await page.waitForSelector(SCROLLER);
  await page.waitForTimeout(300);

  // The production CSS guard: the transcript scroller must clip the cross axis.
  const overflowX = await page.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel)).overflowX,
    SCROLLER,
  );
  assert(
    overflowX === "hidden",
    `#continuous-thread computes overflow-x: hidden (got ${overflowX})`,
  );

  const wheelAt = async (sel, dx, dy) => {
    const c = await centerOf(page, sel);
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(200);
  };
  const scrollOf = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      return { left: el.scrollLeft, top: el.scrollTop };
    }, sel);

  // 1) VERTICAL-ONLY on the REAL transcript (both engines). Normal content does
  //    not overflow horizontally, so a diagonal wheel must move only scrollTop.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }, SCROLLER);
  await page.waitForTimeout(80);
  const nat = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  }, SCROLLER);
  assert(
    nat.scrollWidth <= nat.clientWidth + 1,
    `real transcript has no horizontal overflow (scrollWidth ${nat.scrollWidth} <= clientWidth ${nat.clientWidth})`,
  );
  const natBefore = await scrollOf(SCROLLER);
  await wheelAt(SCROLLER, 600, 200);
  const natAfter = await scrollOf(SCROLLER);
  console.log(
    `  natural diagonal wheel: before=${JSON.stringify(natBefore)} after=${JSON.stringify(natAfter)}`,
  );
  assert(
    natAfter.left === 0,
    `diagonal wheel does NOT pan the transcript sideways (scrollLeft ${natAfter.left})`,
  );
  assert(
    natAfter.top > natBefore.top,
    `diagonal wheel still scrolls the transcript down (scrollTop ${natBefore.top} -> ${natAfter.top})`,
  );

  // 2) SAFETY-NET, Chromium only (see header). Inject a rogue over-wide child so
  //    the thread genuinely overflows in X; overflow-x-hidden must still hold the
  //    cross axis at 0. This is the RED→GREEN class guard.
  if (ENGINE_NAME === "chromium") {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const wide = document.createElement("div");
      wide.id = "e2e-overwide-child";
      wide.style.width = "4000px";
      wide.style.height = "24px";
      wide.style.flexShrink = "0";
      wide.style.background = "linear-gradient(90deg,#f60,#06f)";
      el.appendChild(wide);
      el.scrollLeft = 0;
      el.scrollTop = 0;
    }, SCROLLER);
    await page.waitForTimeout(100);
    const geom = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    }, SCROLLER);
    assert(
      geom.scrollWidth > geom.clientWidth + 100,
      `rogue over-wide child creates real horizontal overflow (scrollWidth ${geom.scrollWidth} > clientWidth ${geom.clientWidth})`,
    );
    const rogueBefore = await scrollOf(SCROLLER);
    await wheelAt(SCROLLER, 600, 200);
    const rogueAfter = await scrollOf(SCROLLER);
    console.log(
      `  rogue-child diagonal wheel: before=${JSON.stringify(rogueBefore)} after=${JSON.stringify(rogueAfter)}`,
    );
    assert(
      rogueAfter.left === 0,
      `overflow-x-hidden holds the cross axis even with a rogue over-wide child (scrollLeft ${rogueAfter.left})`,
    );
    assert(
      rogueAfter.top > rogueBefore.top,
      `vertical scroll still works past the rogue child (scrollTop ${rogueBefore.top} -> ${rogueAfter.top})`,
    );
  }

  // 3) CONTAINMENT (both engines): a designed inner scroller (the code-block /
  //    attachment-preview pattern) scrolls horizontally inside its own box and
  //    does not chain out to the thread.
  await page.evaluate((sel) => {
    const thread = document.querySelector(sel);
    const box = document.createElement("div");
    box.id = "e2e-inner-scroller";
    box.style.width = "260px";
    box.style.height = "48px";
    // The thread is a flex column; without flex-shrink:0 the box collapses to 0
    // height in the overflowing column and the wheel lands on the thread instead.
    box.style.flexShrink = "0";
    box.style.overflowX = "auto";
    box.style.overscrollBehaviorX = "contain";
    const inner = document.createElement("div");
    inner.style.width = "4000px";
    inner.style.height = "24px";
    inner.style.background = "linear-gradient(90deg,#0f0,#00f)";
    box.appendChild(inner);
    thread.appendChild(box);
    // The box sits at the end of a tall transcript; bring it on-screen so the
    // wheel lands on it, then clear any horizontal offset the scroll introduced.
    box.scrollIntoView({ block: "center" });
    thread.scrollLeft = 0;
  }, SCROLLER);
  await page.waitForTimeout(120);

  await wheelAt("#e2e-inner-scroller", 600, 0);
  const containment = await page.evaluate((sel) => {
    const thread = document.querySelector(sel);
    const box = document.querySelector("#e2e-inner-scroller");
    return { innerLeft: box.scrollLeft, threadLeft: thread.scrollLeft };
  }, SCROLLER);
  console.log(`  containment: ${JSON.stringify(containment)}`);
  assert(
    containment.innerLeft > 20,
    `designed inner scroller pans horizontally in its own box (scrollLeft ${containment.innerLeft})`,
  );
  assert(
    containment.threadLeft === 0,
    `inner horizontal scroll does NOT chain to the transcript (thread scrollLeft ${containment.threadLeft})`,
  );

  await page.screenshot({
    path: join(outDir, `chat-hscroll-lock-${ENGINE_NAME}.png`),
  });
} finally {
  await browser.close();
}

assert(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
if (consoleErrors.length) for (const e of consoleErrors) console.log("  ERR:", e);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED [${ENGINE_NAME}]`);
  process.exit(1);
}
console.log(`\nAll hscroll-lock assertions passed [${ENGINE_NAME}].`);
