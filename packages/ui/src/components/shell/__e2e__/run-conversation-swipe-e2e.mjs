/**
 * Real-browser conversation-swipe INTERLEAVING e2e + video capture (#9954).
 *
 * Bundles conversation-swipe-fixture.tsx — which mounts the REAL
 * ContinuousChatOverlay over a stateful controller whose conversation list +
 * active id actually mutate (new conversation prepends at index 0; a swipe
 * re-resolves the adjacent chat through the latest state) — and drives the named
 * interleaving with REAL pointer gestures:
 *
 *   swipe-back → new → swipe-forward → new → forward → swipe-back
 *
 * After every step it asserts the interleaving invariants from the overlay's own
 * data-conversation-id / data-conversation-index DOM, NOT just an error count:
 *   - the active id is in the list,
 *   - the rendered index matches the active id's position,
 *   - hasPrev/hasNext are consistent with the index,
 *   - a new conversation lands at index 0,
 *   - a swipe at the index-0 boundary is a no-op.
 * It also asserts the swipe-jank telemetry event fired during a real gesture.
 *
 * Records a continuous .webm of the whole sequence. Exits non-zero on any failed
 * assertion or page error.
 *
 * Run: bun run --cwd packages/ui test:conversation-swipe-e2e
 */

import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-conversation-swipe");
const videoDir = join(outDir, "video");
await mkdir(outDir, { recursive: true });
await mkdir(videoDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}

// ── esbuild stubs (mirror run-chat-sheet-e2e): the prompt-suggestions hook hits
// the API, @elizaos/core transitively reaches its Node graph, and node builtins
// are dead in the browser. ───────────────────────────────────────────────────
const stubPromptSuggestions = {
  name: "stub-prompt-suggestions",
  setup(b) {
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
  entryPoints: [join(here, "conversation-swipe-fixture.tsx")],
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
const html = `<!doctype html><html><head><meta charset="utf-8"><title>conversation swipe e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
<style>html,body{margin:0;height:100%;background:#16121c}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "conversation-swipe.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

// Live navigation state read straight off the overlay's DOM attributes — the
// SAME data-conversation-id / data-conversation-index the overlay surfaces in
// production (not a fixture-private signal).
const navState = (p) =>
  p.evaluate(() => {
    const sheet = document.querySelector('[data-testid="chat-sheet"]');
    const harness = window.__convNav?.state?.() ?? null;
    return {
      domActiveId: sheet?.getAttribute("data-conversation-id") ?? null,
      domIndex: Number(sheet?.getAttribute("data-conversation-index") ?? "NaN"),
      harness,
    };
  });

/** Assert the full interleaving invariant set for the current overlay state. */
async function assertInvariants(p, label, { expectIndex } = {}) {
  const { domActiveId, domIndex, harness } = await navState(p);
  assert(!!harness, `[${label}] harness state readable`);
  if (!harness) return;
  const inList = harness.ids.includes(harness.activeId);
  assert(inList, `[${label}] active id (${harness.activeId}) ∈ list`);
  // The overlay's reported index must equal the active id's real position.
  assert(
    domIndex === harness.index && harness.index === harness.ids.indexOf(harness.activeId),
    `[${label}] dom index ${domIndex} == active position ${harness.index}`,
  );
  assert(
    domActiveId === harness.activeId,
    `[${label}] dom active id (${domActiveId}) == ${harness.activeId}`,
  );
  // hasPrev/hasNext must be consistent with the index in a most-recent-first list.
  assert(
    harness.hasPrev === harness.index > 0,
    `[${label}] hasPrev (${harness.hasPrev}) consistent with index ${harness.index}`,
  );
  assert(
    harness.hasNext === (harness.index >= 0 && harness.index < harness.ids.length - 1),
    `[${label}] hasNext (${harness.hasNext}) consistent with index ${harness.index}`,
  );
  if (typeof expectIndex === "number") {
    assert(
      harness.index === expectIndex,
      `[${label}] index is ${expectIndex} (got ${harness.index})`,
    );
  }
  return harness;
}

/** Dispatch a real touch-pointer drag from an element's centre by (dx, dy). */
async function drag(p, selector, dx, dy, { steps = 12, slow = false } = {}) {
  const box = await p.locator(selector).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await p.evaluate(
    ({ cx, cy, selector }) => {
      const el = document.querySelector(selector);
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
    { cx, cy, selector },
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
    if (slow) await p.waitForTimeout(20);
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

/** Browser-hit-tested drag by screen coordinates. Used for #10715: the pointer
 * starts outside the chat panel, so a full-screen backdrop would swallow it. */
async function screenDrag(
  p,
  { startX, startY, endX, endY, steps = 12, slow = false },
) {
  await p.mouse.move(startX, startY);
  await p.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const x = startX + ((endX - startX) * i) / steps;
    const y = startY + ((endY - startY) * i) / steps;
    await p.mouse.move(x, y);
    if (slow) await p.waitForTimeout(20);
  }
  await p.mouse.up();
}

// LEFT swipe (clientX decreases) → next/older conversation (index + 1). The
// per-step waits let the swipe-jank FrameBudgetSampler's rAF actually tick
// across the drag (a back-to-back synthetic burst can commit before a single
// frame delta lands), so the telemetry window is non-empty.
const swipeForward = (p) =>
  drag(p, "#continuous-thread", -180, 4, { steps: 14, slow: true });
// RIGHT swipe (clientX increases) → prev/newer conversation (index - 1).
const swipeBack = (p) =>
  drag(p, "#continuous-thread", 180, 4, { steps: 14, slow: true });

const newConversation = (p) =>
  p.evaluate(() => window.__convNav?.newConversation?.());

const logs = [];
const errors = [];
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 420, height: 820 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 420, height: 820 } },
});
const page = await context.newPage();
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForSelector('[data-testid="chat-sheet"]');
await page.waitForSelector('[data-testid="home-launcher-surface"]');
await page.waitForTimeout(600);

// #10715: first open only to HALF so there is visible launcher/home background
// above the chat panel. A horizontal drag that starts there must hit the REAL
// HomeLauncherSurface underneath the visual scrim, not the chat backdrop.
await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, { steps: 6 });
await page.waitForTimeout(450);
assert(
  (await page.getByTestId("chat-sheet").getAttribute("data-variant")) ===
    "open",
  "chat sheet opens before background pass-through test",
);
assert(
  (await page
    .getByTestId("home-launcher-surface")
    .getAttribute("data-page")) === "home",
  "background rail starts on Home",
);
await screenDrag(page, {
  startX: 360,
  startY: 128,
  endX: 58,
  endY: 128,
  steps: 14,
  slow: true,
});
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid="home-launcher-surface"]')
      ?.getAttribute("data-page") === "launcher",
);
assert(
  (await page.getByTestId("chat-sheet").getAttribute("data-variant")) ===
    "open",
  "background swipe pages the launcher while chat remains open",
);
await snap(page, "00-background-swipe-passthrough");

await page.mouse.click(210, 128);
await page.waitForTimeout(450);
assert(
  (await page.getByTestId("chat-sheet").getAttribute("data-variant")) ===
    "closed",
  "outside background tap collapses the chat",
);
await snap(page, "01-background-tap-collapse");

// Open the sheet to FULL so the thread (the swipe surface) is mounted + bound.
// Two pull-ups from collapsed step collapsed → half → full.
await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -120, { steps: 6 });
await page.waitForTimeout(450);
await drag(page, '[data-testid="chat-sheet-grabber"]', 0, -180, { steps: 6 });
await page.waitForTimeout(450);
assert(
  (await page.locator("#continuous-thread").count()) === 1,
  "thread (swipe surface) is mounted with the sheet open",
);
await snap(page, "00-open-newest");

// Start state: active on the NEWEST (index 0). The first "swipe back" toward a
// newer chat is therefore a boundary no-op.
let s = await assertInvariants(page, "start", { expectIndex: 0 });
assert(s?.index === 0, "START: active on the newest conversation (index 0)");
assert(s?.hasPrev === false, "START: index-0 has no newer neighbour (hasPrev false)");

// ── 1. swipe-back at index 0 → BOUNDARY NO-OP ──────────────────────────────
await swipeBack(page);
await page.waitForTimeout(250);
s = await assertInvariants(page, "swipe-back@0", { expectIndex: 0 });
assert(s?.index === 0, "STEP1 swipe-back at index 0 is a no-op (still index 0)");
await snap(page, "01-swipe-back-noop");

// ── 2. new conversation → lands at index 0, list grows ─────────────────────
const beforeNewLen = s?.ids.length ?? 0;
await newConversation(page);
await page.waitForTimeout(250);
s = await assertInvariants(page, "after-new", { expectIndex: 0 });
assert(s?.index === 0, "STEP2 new conversation lands at index 0");
assert(
  (s?.ids.length ?? 0) === beforeNewLen + 1,
  "STEP2 the new conversation grew the list by one",
);
assert(s?.activeId === "new-0", "STEP2 active id is the new conversation");
await snap(page, "02-new-conversation-index0");

// ── 3. swipe-forward → moves toward the older neighbour (index + 1) ────────
const beforeFwd = s?.activeId;
await swipeForward(page);
await page.waitForTimeout(250);
s = await assertInvariants(page, "after-forward", { expectIndex: 1 });
assert(s?.index === 1, "STEP3 swipe-forward moves to index 1 (older neighbour)");
assert(s?.activeId !== beforeFwd, "STEP3 the active conversation actually changed");
await snap(page, "03-swipe-forward");

// ── 4. new conversation again → back to index 0 ────────────────────────────
await newConversation(page);
await page.waitForTimeout(250);
s = await assertInvariants(page, "after-new-2", { expectIndex: 0 });
assert(s?.index === 0, "STEP4 second new conversation lands at index 0 again");
assert(s?.activeId === "new-1", "STEP4 active id is the second new conversation");
await snap(page, "04-new-conversation-2");

// ── 5. swipe-forward → index 1 ─────────────────────────────────────────────
await swipeForward(page);
await page.waitForTimeout(250);
s = await assertInvariants(page, "forward-2", { expectIndex: 1 });
assert(s?.index === 1, "STEP5 swipe-forward to index 1");
await snap(page, "05-swipe-forward-2");

// ── 6. swipe-back → back toward the newer neighbour (index 0) ──────────────
await swipeBack(page);
await page.waitForTimeout(250);
s = await assertInvariants(page, "back-to-0", { expectIndex: 0 });
assert(s?.index === 0, "STEP6 swipe-back returns to index 0 (newer neighbour)");
await snap(page, "06-swipe-back");

// ── Telemetry: a real swipe gesture must have emitted the jank event (#9954) ─
const jankCount = await page.evaluate(
  () => window.__convNav?.swipeJankEvents?.() ?? 0,
);
assert(
  jankCount > 0,
  `conversation-swipe-jank telemetry fired during real gestures (saw ${jankCount})`,
);

assert(errors.length === 0, `no page errors (saw ${errors.length})`);
if (errors.length) console.log(errors.join("\n"));

await page.close(); // flush the video
await context.close();
await browser.close();

const vids = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
if (vids[0]) {
  await rename(
    join(videoDir, vids[0]),
    join(outDir, "conversation-swipe-interleaving.webm"),
  );
  console.log("  🎬 conversation-swipe-interleaving.webm");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
