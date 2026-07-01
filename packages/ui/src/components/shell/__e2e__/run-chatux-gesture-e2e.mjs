/**
 * Real-browser gesture e2e + video capture for the chat-UX surfaces (#8928,
 * #8929, #9954). Bundles chatux-gesture-fixture.tsx with esbuild, loads it in
 * headless chromium via Playwright, and drives REAL pointer gestures:
 *
 *   - TopicGroup: flick UP on the header → collapses to a pill (no buttons);
 *     tap the pill → expands.
 *   - ContinuousChatOverlay: pull the real sheet open, swipe the real thread
 *     between adjacent conversations, interleave the real new-chat header
 *     control, then swipe back.
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

// Stub browser-dead imports so this raw-esbuild bundle behaves like Vite's
// browser build for the overlay.
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
  entryPoints: [join(here, "chatux-gesture-fixture.tsx")],
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
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chatux gesture e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
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

async function text(p, testid) {
  return (await p.getByTestId(testid).textContent())?.trim() ?? "";
}

async function waitForText(p, testid, expected) {
  await p
    .getByTestId(testid)
    .waitFor({ state: "visible", timeout: 5_000 });
  await p.waitForFunction(
    ({ testid: id, expected: value }) =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ===
      value,
    { testid, expected },
    { timeout: 5_000 },
  );
}

async function resetPerfProbe(p) {
  await p.evaluate(() => window.__ELIZA_CHATUX_PERF__?.reset());
}

async function readPerfProbe(p) {
  return await p.evaluate(() => window.__ELIZA_CHATUX_PERF__?.summary() ?? null);
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

async function dragBySelector(
  p,
  selector,
  dx,
  dy,
  { steps = 10, slow = false } = {},
) {
  const box = await p.locator(selector).boundingBox();
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

// ── 3. ContinuousChatOverlay: real sheet + real thread swipe navigation ──
assert(
  (await text(page, "active-conversation-title")) === "Beta billing",
  "Overlay harness starts on the middle conversation",
);
await drag(page, "chat-sheet-grabber", 0, -170, { steps: 12, slow: false });
await page.waitForTimeout(300);
assert(
  (await page.getByTestId("chat-sheet").getAttribute("data-detent")) === "half",
  "Pulling the real overlay grabber opens the chat sheet",
);
await page.locator("#continuous-thread").waitFor({ state: "visible" });
await snap(page, "overlay-open-beta");

await resetPerfProbe(page);
await dragBySelector(page, "#continuous-thread", -180, 0, {
  steps: 12,
  slow: false,
});
await waitForText(page, "active-conversation-title", "Gamma deploy");
assert(
  (await text(page, "active-conversation-title")) === "Gamma deploy",
  "Swipe LEFT on the real overlay thread navigates to the older conversation",
);
await snap(page, "overlay-swipe-left-gamma");

await page.getByTestId("chat-full-clear").click();
await waitForText(page, "active-conversation-title", "New chat 1");
assert(
  (await text(page, "conversation-count")) === "4",
  "Clear/new-chat through the real overlay header prepends a fresh conversation",
);
await snap(page, "overlay-new-chat-1");

await dragBySelector(page, "#continuous-thread", 180, 0, {
  steps: 12,
  slow: false,
});
await page.waitForTimeout(250);
assert(
  (await text(page, "active-conversation-title")) === "New chat 1",
  "Swipe RIGHT at the newest conversation edge is a no-op",
);

await dragBySelector(page, "#continuous-thread", -180, 0, {
  steps: 12,
  slow: false,
});
await waitForText(page, "active-conversation-title", "Alpha launch");
assert(
  (await text(page, "active-conversation-title")) === "Alpha launch",
  "Swipe LEFT after async new-chat mutation uses the refreshed conversation list",
);
await snap(page, "overlay-swipe-left-alpha");

await page.getByTestId("chat-full-clear").click();
await waitForText(page, "active-conversation-title", "New chat 2");
await dragBySelector(page, "#continuous-thread", -180, 0, {
  steps: 12,
  slow: false,
});
await waitForText(page, "active-conversation-title", "New chat 1");
await dragBySelector(page, "#continuous-thread", 180, 0, {
  steps: 12,
  slow: false,
});
await waitForText(page, "active-conversation-title", "New chat 2");
assert(
  (await text(page, "active-conversation-title")) === "New chat 2",
  "New → swipe left → new → swipe left/right returns through adjacent real overlay conversations",
);
await snap(page, "overlay-new-swipe-roundtrip");

const perf = await readPerfProbe(page);
await writeFile(
  join(outDir, "chatux-gesture-perf.json"),
  `${JSON.stringify(perf, null, 2)}\n`,
);
if (assert(perf !== null, "gesture perf probe is installed")) {
  const droppedRatio =
    perf.frame.sampleCount > 0
      ? perf.frame.droppedFrames / perf.frame.sampleCount
      : 1;
  console.log(
    `  perf: samples=${perf.frame.sampleCount} fps=${perf.frame.fps.toFixed(
      1,
    )} p95=${perf.frame.p95FrameMs.toFixed(
      1,
    )}ms dropped=${perf.frame.droppedFrames}/${perf.frame.sampleCount} cls=${perf.stability.cls.toFixed(
      4,
    )}`,
  );
  assert(
    perf.frame.sampleCount >= 20,
    "gesture perf probe collected at least 20 frame samples",
  );
  assert(
    perf.frame.p95FrameMs <= perf.frame.budgetMs * 4,
    "gesture p95 frame time stays within the e2e budget",
  );
  assert(
    droppedRatio <= 0.75,
    "gesture dropped-frame ratio stays within the e2e budget",
  );
  assert(
    perf.stability.cls <= 0.02,
    "gesture non-intentional CLS stays within the e2e budget",
  );
  assert(!perf.flagged, "gesture perf summary is not flagged");
}

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
