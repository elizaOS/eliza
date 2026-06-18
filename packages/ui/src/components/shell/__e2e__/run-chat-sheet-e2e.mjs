/**
 * Real-browser e2e for the iOS-style three-detent continuous-chat sheet — no app
 * server. Bundles chat-sheet-fixture.tsx with esbuild, loads it in headless
 * chromium via Playwright, and drives the sheet with REAL pointer gestures.
 *
 * Coverage (the user asked for exhaustive interaction + state testing):
 *   - DETENTS: peek (76px) → half (46vh) → full (72vh), stepped by pulls.
 *   - GESTURES, per input type (MOUSE on desktop, TOUCH on mobile):
 *       slow drag (distance threshold) · flick (velocity threshold) ·
 *       sub-threshold nudge (snaps back) · drag-and-hold at an arbitrary mid
 *       height (live 1:1 tracking) · drag BEYOND full (rubber-band overscroll).
 *   - EVERY control/state via deterministic fixture loads + interactions:
 *       empty · peek/half/full · typing→send · attach image→thumbnail→remove ·
 *       mic press→recording · voice speaking→mute toggle · responding typing
 *       dots · booting (disabled) · suggestions · reduced-motion.
 *   - Screenshots every state; captures the browser console and fails on any
 *     page error or error-level log.
 *
 * Run: bun run --cwd packages/ui test:chat-sheet-e2e
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
function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// 1) Bundle the fixture (stub the API-touching prompt-suggestions hook).
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

// --- DOM probes ----------------------------------------------------------
const variant = (p) =>
  p.getByTestId("chat-sheet").getAttribute("data-variant");
const detent = (p) =>
  p.getByTestId("chat-sheet").getAttribute("data-detent");
// The history (thread) is the element whose height animates 0 → half → full;
// the panel (chat-sheet) also holds the always-present input, so measure the
// thread for detent heights.
const sheetHeight = (p) =>
  p.evaluate(
    () =>
      document
        .querySelector('[data-testid="chat-thread"]')
        ?.getBoundingClientRect().height ?? 0,
  );
const viewportH = (p) =>
  p.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
const grabberBox = (p) => p.getByTestId("chat-sheet-grabber").boundingBox();

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

function attachConsole(p, sink) {
  p.on("console", (m) => sink.logs.push(`[${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => sink.errors.push(String(e)));
}

const SETTLE = 480; // spring settle time before measuring a detent

/**
 * Real pointer gesture on the grabber. `up` px is the pull distance (positive =
 * up/open, negative = down/close). `pointer` is "mouse" (real Playwright mouse,
 * pointerType=mouse) or "touch" (dispatched PointerEvents, pointerType=touch).
 * `slow` inserts per-step waits so elapsed time is real → LOW velocity (forces a
 * distance-threshold decision); without it the moves fire back-to-back → HIGH
 * velocity (a flick). `hold` leaves the pointer down for a mid-drag screenshot.
 */
async function gesture(
  p,
  up,
  { pointer = "mouse", slow = false, hold = false, steps = 12 } = {},
) {
  const b = await grabberBox(p);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const targetY = (i) => cy - (up * i) / steps;
  if (pointer === "mouse") {
    await p.mouse.move(cx, cy);
    await p.mouse.down();
    for (let i = 1; i <= steps; i += 1) {
      await p.mouse.move(cx, targetY(i));
      if (slow) await p.waitForTimeout(28);
    }
    if (!hold) await p.mouse.up();
  } else {
    await p.evaluate(
      ({ cx, cy }) => {
        const el = document.querySelector('[data-testid="chat-sheet-grabber"]');
        window.__g = el;
        el.dispatchEvent(
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
      await p.evaluate(
        ({ cx, y }) =>
          window.__g.dispatchEvent(
            new PointerEvent("pointermove", {
              pointerId: 1,
              pointerType: "touch",
              clientX: cx,
              clientY: y,
              bubbles: true,
            }),
          ),
        { cx, y: targetY(i) },
      );
      if (slow) await p.waitForTimeout(28);
    }
    if (!hold) {
      await p.evaluate(
        ({ cx, y }) =>
          window.__g.dispatchEvent(
            new PointerEvent("pointerup", {
              pointerId: 1,
              pointerType: "touch",
              clientX: cx,
              clientY: y,
              bubbles: true,
            }),
          ),
        { cx, y: targetY(steps) },
      );
    }
  }
}
async function release(p, pointer, up = 0) {
  if (pointer === "mouse") {
    await p.mouse.up();
  } else {
    const b = await grabberBox(p);
    const y = (b?.y ?? 0) + (b?.height ?? 0) / 2 - up;
    await p.evaluate(
      (y) =>
        window.__g?.dispatchEvent(
          new PointerEvent("pointerup", {
            pointerId: 1,
            pointerType: "touch",
            clientX: 0,
            clientY: y,
            bubbles: true,
          }),
        ),
      y,
    );
  }
}

/** Full detent-stepping + flick + sub-threshold + rubber-band suite for one input type. */
async function runDragSuite(p, pointer, tag) {
  const vh = await viewportH(p);
  const halfH = Math.round(vh * 0.46);
  const fullH = Math.round(vh * 0.72);
  const TOL = 36;
  await p.waitForTimeout(150);

  // fully collapsed at rest — the thread is gone (height 0), just the input
  assert((await variant(p)) === "closed", `[${pointer}] starts COLLAPSED (closed)`);
  assert((await detent(p)) === "collapsed", `[${pointer}] detent is collapsed at rest`);
  assert(near(await sheetHeight(p), 0, 6), `[${pointer}] COLLAPSED thread height ≈ 0px`);
  await snap(p, `${tag}-collapsed`);

  // slow pull up → HALF
  await gesture(p, 110, { pointer, slow: true });
  await p.waitForTimeout(SETTLE);
  assert((await detent(p)) === "half", `[${pointer}] slow pull-up steps COLLAPSED→HALF`);
  assert(near(await sheetHeight(p), halfH, TOL), `[${pointer}] HALF height ≈ ${halfH}px (got ${Math.round(await sheetHeight(p))})`);
  await snap(p, `${tag}-half`);

  // slow pull up again → FULL
  await gesture(p, 220, { pointer, slow: true });
  await p.waitForTimeout(SETTLE);
  assert((await detent(p)) === "full", `[${pointer}] slow pull-up steps HALF→FULL`);
  assert(near(await sheetHeight(p), fullH, TOL), `[${pointer}] FULL height ≈ ${fullH}px (got ${Math.round(await sheetHeight(p))})`);
  await snap(p, `${tag}-full`);

  // drag BEYOND full (held) → rubber-band, not 1:1
  await gesture(p, 260, { pointer, hold: true });
  await p.waitForTimeout(120);
  const beyondH = await sheetHeight(p);
  assert(
    beyondH > fullH - 4 && beyondH < fullH + 80,
    `[${pointer}] BEYOND full rubber-bands (got ${Math.round(beyondH)}, full ${fullH}, raw would be ~${fullH + 260})`,
  );
  await snap(p, `${tag}-beyond-full-rubberband`);
  await release(p, pointer, 260);
  await p.waitForTimeout(SETTLE);
  assert(near(await sheetHeight(p), fullH, TOL), `[${pointer}] springs back to FULL after overscroll`);

  // mid-drag HOLD between detents (live 1:1 tracking)
  await gesture(p, -150, { pointer, hold: true }); // pull down ~150 from full
  await p.waitForTimeout(120);
  const midH = await sheetHeight(p);
  assert(
    midH < fullH - 60 && midH > halfH - 80,
    `[${pointer}] mid-drag tracks the finger 1:1 (got ${Math.round(midH)} between full ${fullH} and half ${halfH})`,
  );
  await snap(p, `${tag}-mid-drag-hold`);
  await release(p, pointer, -150);
  await p.waitForTimeout(SETTLE);

  // pull down → HALF, then → COLLAPSED
  await gesture(p, -220, { pointer, slow: true });
  await p.waitForTimeout(SETTLE);
  // (from wherever the mid-drag settled) ensure we can step down to collapsed
  if ((await variant(p)) === "open") {
    await gesture(p, -260, { pointer, slow: true });
    await p.waitForTimeout(SETTLE);
  }
  assert((await variant(p)) === "closed", `[${pointer}] pull-down returns to COLLAPSED`);
  assert(near(await sheetHeight(p), 0, 6), `[${pointer}] back COLLAPSED, thread ≈ 0px`);
  await snap(p, `${tag}-back-to-collapsed`);

  // click-out collapses: open, then click the dimmed scrim → collapses.
  await gesture(p, 120, { pointer, slow: true });
  await p.waitForTimeout(SETTLE);
  assert((await variant(p)) === "open", `[${pointer}] re-opened for the click-out check`);
  await p
    .getByTestId("chat-sheet-backdrop")
    .click({ position: { x: 16, y: 16 }, force: true });
  await p.waitForTimeout(SETTLE);
  assert((await variant(p)) === "closed", `[${pointer}] clicking outside COLLAPSES the chat`);
  await snap(p, `${tag}-clicked-out-collapsed`);

  // FLICK up (short + fast → velocity threshold, distance < 56). Few steps so
  // the down→up wall-clock is tiny → high velocity, the whole point of a flick.
  await gesture(p, 48, { pointer, slow: false, steps: 2 });
  await p.waitForTimeout(SETTLE);
  assert((await variant(p)) === "open", `[${pointer}] FLICK up opens despite <56px travel (velocity)`);
  await snap(p, `${tag}-flick-open`);

  // sub-threshold NUDGE (small + slow → neither threshold → snaps back)
  const beforeNudge = await variant(p);
  await gesture(p, -34, { pointer, slow: true });
  await p.waitForTimeout(SETTLE);
  assert((await variant(p)) === beforeNudge, `[${pointer}] sub-threshold nudge snaps back (no detent change)`);
  await snap(p, `${tag}-nudge-snapback`);
}

const browser = await chromium.launch();
const sink = { logs: [], errors: [] };
try {
  // ===== DESKTOP + MOUSE =====
  const desktop = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  attachConsole(desktop, sink);
  await desktop.goto(url);
  await desktop.waitForSelector('[data-testid="chat-sheet"]');
  await desktop.waitForTimeout(700);
  await runDragSuite(desktop, "mouse", "desktop");

  // ===== MOBILE + TOUCH =====
  const mobile = await browser.newPage({
    viewport: { width: 402, height: 874 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  attachConsole(mobile, sink);
  await mobile.goto(url);
  await mobile.waitForSelector('[data-testid="chat-sheet"]');
  await mobile.waitForTimeout(700);
  await runDragSuite(mobile, "touch", "mobile");

  // ===== CONTROLS + INPUT STATES (mobile viewport for the tactile surface) =====
  const ctrl = async () =>
    browser.newPage({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 });

  // empty thread: no sheet, just composer + suggestions
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?empty`);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(650);
    assert((await p.locator('[data-testid="chat-thread"]').count()) === 0, "EMPTY: no thread/history mounted (just the input panel)");
    assert(await p.getByTestId("chat-suggestions").isVisible(), "EMPTY: suggestion strip shown");
    assert(await p.getByTestId("chat-composer-attach").isVisible(), "EMPTY: attach (+) button shown");
    assert((await p.getByTestId("chat-composer-mic").count()) === 1, "EMPTY: mic button shown (no draft)");
    await snap(p, "state-empty");
    await p.close();
  }

  // booting: placeholder + disabled controls
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?phase=booting`);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(650);
    assert(
      (await p.getByTestId("chat-composer-textarea").getAttribute("placeholder")) === "connecting…",
      "BOOTING: composer placeholder is 'connecting…'",
    );
    assert(
      (await p.getByTestId("chat-composer-attach").getAttribute("aria-disabled")) === "true",
      "BOOTING: attach (+) is disabled",
    );
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-disabled")) === "true",
      "BOOTING: mic is disabled",
    );
    await snap(p, "state-booting");
    await p.close();
  }

  // recording: mic active + interim transcript
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?recording&phase=listening`);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(650);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-pressed")) === "true",
      "RECORDING: mic shows active (aria-pressed)",
    );
    assert(
      (await p.getByText("tell me the plan for", { exact: false }).count()) > 0,
      "LISTENING: interim transcript line is rendered",
    );
    await snap(p, "state-recording-listening");
    await p.close();
  }

  // speaking: assistant voice mute control appears
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?speaking`);
    await p.waitForSelector('[data-testid="chat-voice-mute"]');
    await p.waitForTimeout(500);
    assert(await p.getByTestId("chat-voice-mute").isVisible(), "SPEAKING: voice-mute (speaker) button shown");
    assert(
      (await p.getByTestId("chat-voice-mute").getAttribute("aria-label")) === "mute assistant voice",
      "SPEAKING: voice-mute labelled 'mute assistant voice'",
    );
    await snap(p, "state-speaking");
    // click it → muted
    await p.getByTestId("chat-voice-mute").click();
    await p.waitForTimeout(300);
    assert(
      (await p.getByTestId("chat-voice-mute").getAttribute("aria-label")) === "unmute assistant voice",
      "SPEAKING→MUTE: clicking toggles to 'unmute assistant voice' (active)",
    );
    await snap(p, "state-muted");
    await p.close();
  }

  // responding: typing dots inside the (opened) sheet
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?phase=responding`);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(500);
    await p.getByTestId("chat-sheet-grabber").focus();
    await p.keyboard.press("ArrowUp"); // open to half so the dots are visible
    await p.waitForTimeout(450);
    assert(await p.getByTestId("typing-dots").isVisible(), "RESPONDING: typing-dots shown in the open sheet");
    await snap(p, "state-responding");
    await p.close();
  }

  // typing → send button morph, and Enter sends
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(600);
    const input = p.getByTestId("chat-composer-textarea");
    await input.fill("draft message");
    await p.waitForTimeout(200);
    assert(await p.getByTestId("chat-composer-action").isVisible(), "TYPING: trailing control morphs mic→send");
    assert((await p.getByTestId("chat-composer-mic").count()) === 0, "TYPING: mic hidden while a draft exists");
    assert((await variant(p)) === "open", "TYPING: composing pulls the sheet open");
    await snap(p, "state-typing-send");
    await input.press("Enter");
    await p.waitForTimeout(300);
    assert((await input.inputValue()) === "", "SEND: composer clears after Enter");
    await p.close();
  }

  // attach image → thumbnail + remove button (real file through the hidden input)
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-attach"]');
    await p.waitForTimeout(600);
    // 1x1 transparent PNG
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await p.setInputFiles('input[type="file"]', {
      name: "shot.png",
      mimeType: "image/png",
      buffer: Buffer.from(pngB64, "base64"),
    });
    await p.waitForTimeout(350);
    assert((await p.locator('img[alt="shot.png"]').count()) === 1, "ATTACH: pending image thumbnail rendered");
    assert(await p.getByTestId("chat-composer-action").isVisible(), "ATTACH: send button shown for image-only turn");
    assert(await p.getByLabel("remove shot.png").isVisible(), "ATTACH: per-image remove button shown");
    await snap(p, "state-image-attached");
    await p.getByLabel("remove shot.png").click();
    await p.waitForTimeout(250);
    assert((await p.locator('img[alt="shot.png"]').count()) === 0, "REMOVE: thumbnail cleared after remove");
    await p.close();
  }

  // mic press → recording (interactive toggle, not URL-seeded)
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(600);
    await p.getByTestId("chat-composer-mic").click();
    await p.waitForTimeout(300);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-pressed")) === "true",
      "MIC CLICK: toggles recording on",
    );
    await snap(p, "state-mic-clicked-recording");
    await p.getByTestId("chat-composer-mic").click();
    await p.waitForTimeout(300);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-pressed")) !== "true",
      "MIC CLICK: toggles recording back off",
    );
    await p.close();
  }

  // suggestions: tapping one sends + opens
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(`${url}?empty`);
    await p.waitForSelector('[data-testid="chat-suggestion-0"]');
    await p.waitForTimeout(500);
    await snap(p, "state-suggestions");
    await p.getByTestId("chat-suggestion-0").click();
    await p.waitForTimeout(400);
    assert((await variant(p)) === "open", "SUGGESTION: tapping sends and opens the sheet");
    await p.close();
  }

  // multi-line: the composer auto-grows with newlines
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(500);
    const ta = p.getByTestId("chat-composer-textarea");
    const h1 = await ta.evaluate((el) => el.getBoundingClientRect().height);
    await ta.fill("line one\nline two\nline three\nline four");
    await p.waitForTimeout(250);
    const h2 = await ta.evaluate((el) => el.getBoundingClientRect().height);
    assert(
      h2 > h1 + 24,
      `MULTILINE: composer grows with newlines (${Math.round(h1)} → ${Math.round(h2)}px)`,
    );
    await snap(p, "state-multiline-input");
    await p.close();
  }

  // keyboard: focusing opens; tapping the scrim blurs the input + collapses
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(500);
    const focused = () =>
      p.evaluate(
        () =>
          document.activeElement?.getAttribute("data-testid") ===
          "chat-composer-textarea",
      );
    await p.getByTestId("chat-composer-textarea").focus();
    await p.waitForTimeout(150);
    assert(await focused(), "FOCUS: composer holds focus");
    assert((await variant(p)) === "open", "FOCUS: focusing opens the chat");
    await p
      .getByTestId("chat-sheet-backdrop")
      .click({ position: { x: 16, y: 16 }, force: true });
    await p.waitForTimeout(350);
    assert(
      (await focused()) === false,
      "CLICK-OUT: blurs the composer (mobile keyboard drops)",
    );
    assert((await variant(p)) === "closed", "CLICK-OUT: collapses the chat");
    await p.close();
  }

  // reduced-motion still opens via flick
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.goto(url);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, 120, { pointer: "mouse", slow: true });
    await p.waitForTimeout(200);
    assert((await variant(p)) === "open", "REDUCED-MOTION: pull-up still opens");
    await snap(p, "state-reduced-motion-open");
    await p.close();
  }
} finally {
  await browser.close();
}

// --- Logs + errors review ---
console.log("\n── browser console (sample) ──");
for (const line of sink.logs.slice(0, 6)) console.log(`  ${line}`);
const errorLevel = sink.logs.filter((l) => l.startsWith("[error]"));
assert(sink.errors.length === 0, `no uncaught page errors (${sink.errors.length})`);
if (sink.errors.length) for (const e of sink.errors) console.error(`  ⚠ ${e}`);
assert(errorLevel.length === 0, `no error-level console messages (${errorLevel.length})`);
assert(
  sink.logs.some((l) => l.includes("[fixture] toggleRecording") || l.includes("startRecording")),
  "fixture logged a recording interaction",
);

console.log(`\nScreenshots (${shot}) written to ${outDir}`);
if (failures > 0) {
  console.error(`\nCHAT-SHEET E2E FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nCHAT-SHEET E2E PASSED");
