/**
 * Real-browser e2e for the pull-up chat sheet — no app server required.
 *
 * Bundles chat-sheet-fixture.tsx with esbuild, loads it in headless chromium via
 * Playwright, and drives the sheet with REAL pointer-drag gestures, capturing a
 * screenshot of EVERY interaction + state and asserting each did what was
 * expected. It also collects the browser console (the fixture logs its phase /
 * send flow) and fails on any page error or error-level console message — so
 * both the logs and the visuals are verified in one pass.
 *
 * Run: bun run packages/ui/src/components/shell/__e2e__/run-chat-sheet-e2e.mjs
 * Exits non-zero on any failed assertion / console error.
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
  return cond;
}

// 1) Bundle the fixture (stub the API-touching prompt-suggestions hook so the
// bundle stays browser-pure).
const stubPromptSuggestions = {
  name: "stub-prompt-suggestions",
  setup(b) {
    b.onResolve({ filter: /usePromptSuggestions$/ }, () => ({
      path: join(here, "usePromptSuggestions.stub.ts"),
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
  plugins: [stubPromptSuggestions],
  write: false,
});
const js = result.outputFiles[0].text;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat sheet e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>html,body{margin:0;height:100%;background:#0a0d16}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "chat-sheet.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

const variant = (p) =>
  p.getByTestId("chat-sheet").getAttribute("data-variant");

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

/** Drag the grabber by `dy` px (negative = up/open, positive = down/close).
 *  `hold` leaves the pointer pressed for a mid-drag screenshot. */
async function dragGrabber(p, dy, { hold = false } = {}) {
  const box = await p.getByTestId("chat-sheet-grabber").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await p.mouse.move(cx, cy);
  await p.mouse.down();
  for (let i = 1; i <= 14; i += 1) await p.mouse.move(cx, cy + (dy * i) / 14);
  if (!hold) await p.mouse.up();
}

/** Is the LAST message line resting at the bottom of the (open) log view? */
const lastLineAtBottom = (p) =>
  p.evaluate(() => {
    const log = document.getElementById("continuous-thread");
    const lines = log?.querySelectorAll('[data-testid="thread-line"]');
    const last = lines?.[lines.length - 1];
    if (!log || !last) return false;
    const lr = last.getBoundingClientRect();
    const cr = log.getBoundingClientRect();
    return lr.bottom <= cr.bottom + 6 && lr.bottom >= cr.top;
  });

function attachConsole(p, sink) {
  p.on("console", (m) => sink.logs.push(`[${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => sink.errors.push(String(e)));
}

const browser = await chromium.launch();
const sink = { logs: [], errors: [] };
try {
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
  });
  attachConsole(page, sink);
  await page.goto(url);
  await page.waitForSelector('[data-testid="chat-sheet"]');
  await page.waitForTimeout(700); // let the Play CDN JIT the utilities

  // 1. Closed at rest — peek whispers the LATEST line. (Re-pin first: the Play
  // CDN restyles asynchronously after mount, so the component's mount-time pin
  // can be stale in this harness — the real app has synchronous CSS.)
  await page.evaluate(() => {
    const log = document.getElementById("continuous-thread");
    if (log) log.scrollTop = log.scrollHeight;
  });
  await page.waitForTimeout(80);
  assert((await variant(page)) === "closed", "starts closed (resting peek)");
  assert(
    await page.evaluate(() => {
      const log = document.getElementById("continuous-thread");
      const lines = log?.querySelectorAll('[data-testid="thread-line"]');
      const last = lines?.[lines.length - 1];
      if (!log || !last) return false;
      // The last line's bottom sits inside the clipped peek (latest is shown).
      const lr = last.getBoundingClientRect();
      const cr = log.getBoundingClientRect();
      return lr.bottom <= cr.bottom + 6 && lr.bottom > cr.top;
    }),
    "closed peek shows the LATEST line at the bottom (not the oldest)",
  );
  await snap(page, "closed");

  // 2. Mid pull-up (held).
  await dragGrabber(page, -300, { hold: true });
  await snap(page, "pull-up-mid-drag");
  await page.mouse.up();

  // 3. Open — scrolled to the latest line.
  assert((await variant(page)) === "open", "pull-UP opens the sheet");
  await page.waitForTimeout(450);
  await page.evaluate(() => {
    const log = document.getElementById("continuous-thread");
    if (log) log.scrollTop = log.scrollHeight; // settle after CDN reflow
  });
  assert(await lastLineAtBottom(page), "open: latest line is pinned to the bottom");
  await snap(page, "open");

  // 4. Click the scrim — must NOT close.
  await page
    .getByTestId("chat-sheet-backdrop")
    .click({ position: { x: 30, y: 30 }, force: true });
  await page.waitForTimeout(120);
  assert((await variant(page)) === "open", "clicking the scrim does NOT close it");
  await snap(page, "open-after-scrim-click");

  // 5. Scroll up through history.
  await page.evaluate(() => {
    const log = document.getElementById("continuous-thread");
    if (log) log.scrollTop = 0;
  });
  await page.waitForTimeout(150);
  assert(
    await page.evaluate(() => {
      const log = document.getElementById("continuous-thread");
      return !!log && log.scrollTop < 8 && log.scrollHeight > log.clientHeight;
    }),
    "open thread scrolls up to reveal earlier history",
  );
  assert((await variant(page)) === "open", "scrolling the thread does NOT close it");
  await snap(page, "open-scrolled-history");

  // 6. Mid pull-down (held) then release → closed.
  await page.evaluate(() => {
    const log = document.getElementById("continuous-thread");
    if (log) log.scrollTop = log.scrollHeight;
  });
  await dragGrabber(page, 320, { hold: true });
  await snap(page, "pull-down-mid-drag");
  await page.mouse.up();
  await page.waitForTimeout(450);
  assert((await variant(page)) === "closed", "pull-DOWN closes the sheet");
  await snap(page, "closed-after-pulldown");

  // 7. Keyboard: focus the grabber, ArrowUp opens.
  await page.getByTestId("chat-sheet-grabber").focus();
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(400);
  assert((await variant(page)) === "open", "grabber ArrowUp opens (keyboard a11y)");
  await snap(page, "open-via-keyboard");

  // 8. Keyboard: ArrowDown closes.
  await page.getByTestId("chat-sheet-grabber").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(400);
  assert((await variant(page)) === "closed", "grabber ArrowDown closes (keyboard a11y)");
  await snap(page, "closed-via-keyboard");

  // 9. Type-to-open.
  const input = page.getByTestId("chat-composer-textarea");
  await input.click();
  await input.fill("how does the grabber feel?");
  await page.waitForTimeout(120);
  assert((await variant(page)) === "open", "typing in the composer pulls the sheet up");
  await snap(page, "open-via-typing");

  // 10. Send → responding (typing dots) → reply.
  const before = await page.locator('[data-testid="thread-line"]').count();
  await input.press("Enter");
  await page.waitForSelector('[data-testid="typing-dots"]', { timeout: 2000 });
  assert(true, "send shows the responding typing-dots");
  await snap(page, "open-responding");
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="thread-line"]').length >= n,
    before + 2,
    { timeout: 4000 },
  );
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const log = document.getElementById("continuous-thread");
    if (log) log.scrollTop = log.scrollHeight;
  });
  assert(
    (await page.locator('[data-testid="thread-line"]').count()) >= before + 2,
    "reply appended; both the sent line and the reply are viewable",
  );
  assert(await lastLineAtBottom(page), "after reply the latest line is pinned to the bottom");
  await snap(page, "open-after-reply");

  // 11. Escape closes.
  await input.focus();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  assert((await variant(page)) === "closed", "Escape closes the sheet");
  await snap(page, "closed-after-escape");

  // 12. Empty thread (no history) — no sheet, just composer + suggestions.
  const empty = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 });
  attachConsole(empty, sink);
  await empty.goto(`${url}?empty`);
  await empty.waitForSelector('[data-testid="chat-composer-textarea"]');
  await empty.waitForTimeout(700);
  assert(
    (await empty.locator('[data-testid="chat-sheet"]').count()) === 0,
    "empty thread renders no sheet (nothing to pull up yet)",
  );
  assert(
    (await empty.getByTestId("chat-suggestions").isVisible()),
    "empty thread shows the resting suggestion strip",
  );
  await snap(empty, "empty-no-thread");
  await empty.close();

  // 13. Reduced-motion: still opens (cross-fade, no spring).
  const reduced = await browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 });
  attachConsole(reduced, sink);
  await reduced.emulateMedia({ reducedMotion: "reduce" });
  await reduced.goto(url);
  await reduced.waitForSelector('[data-testid="chat-sheet"]');
  await reduced.waitForTimeout(700);
  await dragGrabber(reduced, -300);
  await reduced.waitForTimeout(200);
  assert(
    (await reduced.getByTestId("chat-sheet").getAttribute("data-variant")) === "open",
    "reduced-motion: pull-up still opens",
  );
  await snap(reduced, "reduced-motion-open");
  await reduced.close();

  // 14. Desktop width.
  const wide = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  attachConsole(wide, sink);
  await wide.goto(url);
  await wide.waitForSelector('[data-testid="chat-sheet"]');
  await wide.waitForTimeout(700);
  await snap(wide, "desktop-closed");
  await dragGrabber(wide, -320);
  await wide.waitForTimeout(450);
  assert(
    (await wide.getByTestId("chat-sheet").getAttribute("data-variant")) === "open",
    "desktop: pull-up opens too",
  );
  await wide.evaluate(() => {
    const log = document.getElementById("continuous-thread");
    if (log) log.scrollTop = log.scrollHeight;
  });
  await snap(wide, "desktop-open");
  await wide.close();
} finally {
  await browser.close();
}

// --- Logs + errors review ---
console.log("\n── browser console ──");
for (const line of sink.logs) console.log(`  ${line}`);
const errorLevel = sink.logs.filter((l) => l.startsWith("[error]"));
assert(sink.errors.length === 0, `no uncaught page errors (${sink.errors.length})`);
if (sink.errors.length) for (const e of sink.errors) console.error(`  ⚠ ${e}`);
assert(errorLevel.length === 0, `no error-level console messages (${errorLevel.length})`);
assert(
  sink.logs.some((l) => l.includes("[fixture] send:")),
  "fixture logged the send interaction",
);
assert(
  sink.logs.some((l) => l.includes("phase=responding")),
  "fixture logged the responding phase transition",
);

console.log(`\nScreenshots (${shot}) written to ${outDir}`);
if (failures > 0) {
  console.error(`\nCHAT-SHEET E2E FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nCHAT-SHEET E2E PASSED");
