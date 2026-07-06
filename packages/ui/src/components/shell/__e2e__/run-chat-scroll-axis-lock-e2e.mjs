/**
 * Regression harness for "the chat transcript can pan sideways" (#14328).
 *
 * The continuous-chat transcript (`#continuous-thread`) is a single-axis scroll
 * surface: it scrolls vertically and must NEVER scroll horizontally. CSS Overflow
 * coerces the unspecified axis from `visible` to `auto`, so `overflow-y-auto`
 * alone silently makes the thread horizontally scrollable the instant any child
 * overflows — an attachment preview, an unaudited inline widget, a wide table.
 * `touch-pan-y` blocks touch panning but does NOT block trackpad/wheel deltaX, so
 * on desktop a diagonal two-finger scroll pans the whole transcript sideways.
 *
 * This drives the REAL `ContinuousChatOverlay` (via chat-sheet-fixture.tsx), opens
 * the sheet to FULL, injects an over-wide child into the genuine `#continuous-thread`
 * scroller, then dispatches a diagonal wheel and asserts `scrollLeft` never leaves 0.
 * A second case proves a DESIGNED inner scroller (the repo's `overflow-x-auto
 * overscroll-x-contain` contract used by code blocks / chip rows) still scrolls
 * inside its own row and does NOT chain its horizontal scroll to the thread.
 *
 * RED before the fix (computed `overflow-x: auto`, thread pans), GREEN after
 * (`overflow-x: hidden`, thread pinned). Runs on Chromium AND WebKit — the
 * acceptance bar requires both engines (#14328).
 *
 * Run:  node src/components/shell/__e2e__/run-chat-scroll-axis-lock-e2e.mjs
 *       ENGINE=webkit node …/run-chat-scroll-axis-lock-e2e.mjs
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

// --- same bundle stubs as run-chat-scroll-web-e2e.mjs --------------------
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
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat scroll axis lock e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#0a0d16}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "chat-scroll-axis-lock.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}?many`;

const SCROLLER = "#continuous-thread";
const THREAD = '[data-testid="chat-thread"]';
const GRABBER = '[data-testid="chat-sheet-grabber"]';

// Open the sheet to FULL — touch-drag on Chromium (CDP), keyboard disclosure on
// WebKit (no CDP touch). Both reach the same open state, matching the sibling
// scroll-web harness so the scroller is measured identically on each engine.
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

// Wheel at the CENTER of an element's box: move the pointer there, then emit a
// wheel with the given deltas. Playwright's mouse.wheel works on both Chromium
// and WebKit, so this is the cross-engine analogue of a trackpad two-finger drag.
async function wheelOver(page, selector, deltaX, deltaY) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(deltaX, deltaY);
  await page.waitForTimeout(200);
}

console.log(`engine: ${ENGINE_NAME}`);
const browser = await ENGINE.launch(
  ENGINE_NAME === "chromium" ? { args: ["--no-sandbox"] } : {},
);
const consoleErrors = [];
try {
  // Chromium runs a mobile touch context (CDP touch-drag opens the sheet, and
  // Chromium still honours mouse.wheel there). WebKit CANNOT emit mouse.wheel in
  // a mobile context ("Mouse wheel is not supported in mobile WebKit"), and the
  // deltaX bug is a *desktop* trackpad bug regardless — so WebKit runs a
  // fine-pointer desktop context and opens the sheet via the keyboard path.
  const page = await browser.newPage(
    ENGINE_NAME === "chromium"
      ? {
          viewport: { width: 402, height: 874 },
          hasTouch: true,
          isMobile: true,
          deviceScaleFactor: 2,
        }
      : { viewport: { width: 900, height: 900 } },
  );
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
  assert(
    !!(await page.locator(SCROLLER).count()),
    `scroller ${SCROLLER} is present`,
  );

  const geom = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    return { clientWidth: el.clientWidth, boxW: Math.round(r.width), boxX: Math.round(r.x) };
  }, SCROLLER);
  console.log(`  thread geometry: ${JSON.stringify(geom)}`);

  // 1) THE CONTRACT: the transcript scroller computes `overflow-x: hidden`. This
  //    is the single fact the fix establishes; before the fix it is `auto`
  //    (CSS coerces the unspecified axis) and the wheel below pans the thread.
  const overflowX = await page.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel)).overflowX,
    SCROLLER,
  );
  console.log(`  computed overflow-x: ${overflowX}`);
  assert(
    overflowX === "hidden",
    `#continuous-thread computes overflow-x: hidden (got ${overflowX})`,
  );

  // INJECT AN OVER-WIDE DIRECT CHILD: a 4000px block inside the ~360px thread.
  // With overflow-x:hidden the thread clips it and no user gesture can pan to it;
  // under the bug (overflow-x:auto) the same wheel would slide the whole
  // transcript sideways. NOTE: `overflow:hidden` still allows *programmatic*
  // scrollLeft and still reports scrollWidth>clientWidth — only USER scrolling is
  // blocked — so the wheel gesture, not a scrollWidth check, is the discriminator.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const wide = document.createElement("div");
    wide.id = "e2e-overwide-child";
    wide.textContent = "over-wide adversarial child ".repeat(20);
    Object.assign(wide.style, {
      width: "4000px",
      minWidth: "4000px",
      flex: "0 0 auto",
      height: "24px",
      whiteSpace: "nowrap",
      background: "rgba(255,0,0,0.15)",
    });
    el.appendChild(wide);
    el.scrollLeft = 0; // baseline
    wide.scrollIntoView({ block: "nearest", inline: "nearest" });
    el.scrollLeft = 0; // scrollIntoView may nudge; re-baseline
  }, SCROLLER);
  await page.waitForTimeout(150);

  // 2) DIAGONAL WHEEL (the real trackpad two-finger gesture) then a pure-X wheel:
  //    neither may move scrollLeft off 0 on a locked (overflow-x:hidden) thread.
  await wheelOver(page, SCROLLER, 400, 40);
  await wheelOver(page, SCROLLER, 600, 0);
  const scrollLeftAfterWheel = await page.evaluate(
    (sel) => document.querySelector(sel).scrollLeft,
    SCROLLER,
  );
  console.log(`  thread scrollLeft after diagonal+horizontal wheel: ${scrollLeftAfterWheel}`);
  assert(
    scrollLeftAfterWheel === 0,
    `diagonal/horizontal wheel leaves #continuous-thread pinned (scrollLeft=${scrollLeftAfterWheel})`,
  );

  // 3) DESIGNED INNER SCROLLER survives + does not chain — AND doubles as the
  //    POSITIVE CONTROL that the wheel mechanism scrolls overflow-x:auto here.
  //    Inject the repo's inner-scroller contract (`overflow-x-auto
  //    overscroll-x-contain`, as on code blocks / chip rows) with over-wide
  //    content, scroll it into view, wheel over IT: its OWN scrollLeft must
  //    advance (designed scroll preserved + wheel works) while the thread stays
  //    pinned at 0 (overflow-x:hidden clips; overscroll-x-contain stops the chain).
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollLeft = 0;
    const row = document.createElement("div");
    row.id = "e2e-inner-scroller";
    row.className = "overflow-x-auto overscroll-x-contain";
    Object.assign(row.style, {
      width: "100%",
      maxWidth: "320px",
      height: "40px",
      margin: "8px 0",
      flex: "0 0 auto",
    });
    const inner = document.createElement("div");
    Object.assign(inner.style, {
      width: "3000px",
      minWidth: "3000px",
      height: "24px",
      background:
        "repeating-linear-gradient(90deg,#2b6,#2b6 20px,#083 20px,#083 40px)",
    });
    row.appendChild(inner);
    el.appendChild(row);
    row.scrollIntoView({ block: "center", inline: "nearest" });
    el.scrollLeft = 0;
  }, SCROLLER);
  await page.waitForTimeout(200);
  await wheelOver(page, "#e2e-inner-scroller", 500, 0);
  const chain = await page.evaluate(
    (sel) => ({
      inner: document.querySelector("#e2e-inner-scroller").scrollLeft,
      thread: document.querySelector(sel).scrollLeft,
    }),
    SCROLLER,
  );
  console.log(`  inner-scroller chain: ${JSON.stringify(chain)}`);
  assert(
    chain.inner > 20,
    `designed inner scroller still scrolls horizontally in its own row (positive control; scrollLeft=${chain.inner})`,
  );
  assert(
    chain.thread === 0,
    `inner horizontal scroll does NOT chain to the thread (thread scrollLeft=${chain.thread})`,
  );

  await page.screenshot({
    path: join(outDir, `chat-scroll-axis-lock-${ENGINE_NAME}.png`),
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
console.log(`\nAll axis-lock assertions passed [${ENGINE_NAME}].`);
