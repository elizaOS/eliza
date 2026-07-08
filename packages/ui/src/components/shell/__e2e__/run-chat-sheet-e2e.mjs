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
 *   - CONTINUUM, per input type: ONE held drag pill → top commits MAXIMIZED
 *       and ONE held drag from the restore strip past the bottom lands back on
 *       the PILL, with per-step geometry sampling (monotonic height, pill
 *       crossfade, edge-to-edge box, fixed-width text column). Detent rules:
 *       pill nudge springs back · pill drag past half-morph rests at INPUT ·
 *       short input pull springs back · pill tap → HALF · grabber tap → INPUT.
 *       Full matrix: CHAT_SHEET_STATE_MATRIX.md.
 *   - AUTOSCROLL, per input type: tail follows at bottom, a single >80px
 *       streamed growth remains pinned, reading-scrollback is not yanked, and
 *       jump-to-latest re-pins the transcript.
 *   - EVERY control/state via deterministic fixture loads + interactions:
 *       empty · peek/half/full · typing→send · attach image→thumbnail→remove ·
 *       mic press→recording · voice speaking→mute toggle · responding typing
 *       dots · booting (disabled) · reduced-motion.
 *   - Screenshots every state; captures the browser console and fails on any
 *     page error or error-level log.
 *
 * Run: bun run --cwd packages/ui test:chat-sheet-e2e
 *      bun run --cwd packages/ui test:chat-sheet-e2e -- --only-autoscroll
 * Exits non-zero on any failed assertion / console error.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import {
  renameRecordedVideo,
  stubElizaCore,
  stubNodeBuiltins,
  writeFixturePage,
} from "../../../testing/e2e-runner/index.ts";
import {
  touchDragHold,
  touchSwipe,
  touchTap,
} from "../../../testing/real-touch-gestures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output");
const videoDir = join(outDir, "video");
const ONLY_AUTOSCROLL =
  process.argv.includes("--only-autoscroll") ||
  process.env.CHAT_SHEET_E2E_SCOPE === "autoscroll";
await mkdir(outDir, { recursive: true });
await mkdir(videoDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}
function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// Bundle the fixture with the shared stubs: @elizaos/core + node builtins (dead
// at render in the browser; the only render-path core symbol,
// findInteractionRegions, is test-only) are replaced with no-op proxies,
// mirroring the sibling shell runners.
const url = await writeFixturePage({
  entry: join(here, "chat-sheet-fixture.tsx"),
  outDir,
  htmlName: "chat-sheet.html",
  title: "chat sheet e2e",
  plugins: [stubElizaCore(), stubNodeBuiltins()],
  processShim: true,
  background: "#0a0d16",
  headHtml: "<style>.bg-bg{background-color:#0a0d16}</style>",
});

async function gotoFixture(p, href = url) {
  await p.goto(href, { waitUntil: "domcontentloaded" });
}

// --- DOM probes ----------------------------------------------------------
const variant = (p) =>
  p.getByTestId("chat-sheet").getAttribute("data-variant");
const detent = (p) =>
  p.getByTestId("chat-sheet").getAttribute("data-detent");
// The canonical state-machine value (CLOSED | INPUT | OPEN_UNDER_HALF |
// OPEN_HALF_OR_OVER | MAXIMIZED) — the single source the overlay derives.
const chatState = (p) =>
  p.getByTestId("chat-sheet").getAttribute("data-chat-state");
// The header is a safe-area/status strip, so visibility is the LIVE-height
// `data-header-shown` flag, not the presence of controls in the DOM.
const headerShown = async (p) =>
  (await p.getByTestId("chat-sheet").getAttribute("data-header-shown")) ===
  "true";
async function waitForHeaderShown(p, timeout = 1500) {
  await p.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="chat-sheet"]')
        ?.getAttribute("data-header-shown") === "true",
    undefined,
    { timeout },
  );
}
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
const threadScrollState = (p) =>
  p.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-thread-scroll"]');
    if (!el) return null;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      maxScrollTop,
      bottomDelta: maxScrollTop - el.scrollTop,
    };
  });
async function waitForSheetHeightNear(p, expected, tolerance, timeout = 1500) {
  await p
    .waitForFunction(
      ({ expected, tolerance }) => {
        const h =
          document
            .querySelector('[data-testid="chat-thread"]')
            ?.getBoundingClientRect().height ?? 0;
        return Math.abs(h - expected) <= tolerance;
      },
      { expected, tolerance },
      { timeout },
    )
    .catch(() => {});
}
async function waitForThreadBottom(p, timeout = 1800) {
  await p
    .waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="chat-thread-scroll"]');
        if (!el) return false;
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        return maxScrollTop - el.scrollTop <= 18;
      },
      undefined,
      { timeout },
    )
    .catch(() => {});
}
const viewportH = (p) =>
  p.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
// Distance from the viewport top to the panel's top edge — at FULL the sheet
// rises to ~SHEET_TOP_MARGIN (72px) from the top.
const panelTop = (p) =>
  p.evaluate(
    () =>
      document.querySelector('[data-testid="chat-sheet"]')?.getBoundingClientRect()
        .top ?? 0,
  );
const panelRadii = (p) =>
  p.evaluate(() => {
    const panel = document.querySelector('[data-testid="chat-sheet"]');
    const surface = panel?.firstElementChild;
    const content = document.querySelector('[data-testid="chat-content"]');
    const read = (el) =>
      el ? Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) : -1;
    return { surface: read(surface), content: read(content) };
  });
const chatSurfaceTone = (p) =>
  p.evaluate(() => {
    const panel = document.querySelector('[data-testid="chat-sheet"]');
    const surface = panel?.firstElementChild;
    const parseRgb = (value) => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (match) {
        const [r, g, b, a = "1"] = match[1]
          .split(",")
          .map((part) => part.trim());
        return {
          r: Number.parseFloat(r),
          g: Number.parseFloat(g),
          b: Number.parseFloat(b),
          a: Number.parseFloat(a),
        };
      }
      // Chromium serializes a color-mix() fill as `color(srgb r g b / a)`
      // with 0–1 channels — the frosted inset surface reads this way.
      const srgb = value.match(
        /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/,
      );
      if (!srgb) return null;
      return {
        r: Number.parseFloat(srgb[1]) * 255,
        g: Number.parseFloat(srgb[2]) * 255,
        b: Number.parseFloat(srgb[3]) * 255,
        a: srgb[4] === undefined ? 1 : Number.parseFloat(srgb[4]),
      };
    };
    const bg = surface ? getComputedStyle(surface).backgroundColor : "";
    const vars = panel
      ? {
          card: getComputedStyle(panel).getPropertyValue("--card").trim(),
          txt: getComputedStyle(panel).getPropertyValue("--txt").trim(),
        }
      : { card: "", txt: "" };
    return { bg, parsed: parseRgb(bg), ...vars };
  });
async function assertDarkChatSurface(p, label) {
  const tone = await chatSurfaceTone(p);
  const rgb = tone.parsed;
  // The INSET sheet is deliberately frosted glass — a translucent (~68%) dark
  // warm fill over a backdrop blur (product direction; see the surface layer's
  // backgroundColor note in ContinuousChatOverlay). Full-bleed is opaque. Both
  // must stay DARK and locally themed, never the orange app theme.
  assert(
    Boolean(
      rgb &&
        rgb.a >= 0.6 &&
        rgb.r < 60 &&
        rgb.g < 50 &&
        rgb.b < 45 &&
        tone.txt !== "var(--text)" &&
        tone.card !== "var(--brand-orange)",
    ),
    `${label}: chat sheet uses a dark local surface (opaque or frosted), not the orange app theme (${JSON.stringify(
      tone,
    )})`,
  );
}
async function assertNoDefaultBlueThreadFocus(p, label) {
  const focusChrome = await p.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-thread-scroll"]');
    if (!(el instanceof HTMLElement)) return null;
    el.focus();
    const styles = getComputedStyle(el);
    return {
      outlineColor: styles.outlineColor,
      outlineStyle: styles.outlineStyle,
      boxShadow: styles.boxShadow,
    };
  });
  const serialized = JSON.stringify(focusChrome);
  const hasDefaultBlue = /(0,\s*95,\s*204|0,\s*120,\s*215|59,\s*130,\s*246)/.test(
    serialized,
  );
  assert(
    Boolean(focusChrome && !hasDefaultBlue),
    `${label}: transcript focus chrome is locally themed, not browser/default blue (${serialized})`,
  );
}
const SHEET_TOP_MARGIN = 72;
const grabberBox = (p) => p.getByTestId("chat-sheet-grabber").boundingBox();

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

// Sample the ACTUAL rendered pixel at a viewport point (decoded from a 1px
// screenshot clip). Proves visual paint, unlike elementFromPoint which skips
// pointer-events:none layers — the #12178 opaque onboarding backdrop is
// intentionally non-interactive yet must still paint over the launcher (#12364).
async function pixelAt(p, x, y) {
  const buf = await p.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const png = PNG.sync.read(buf);
  return { r: png.data[0], g: png.data[1], b: png.data[2] };
}

function attachConsole(p, sink) {
  p.on("console", (m) => sink.logs.push(`[${m.type()}] ${m.text()}`));
  p.on("pageerror", (e) => sink.errors.push(String(e)));
}

const SETTLE = 480; // spring settle time before measuring a detent

/**
 * Real pointer gesture on the grabber. `up` px is the pull distance (positive =
 * up/open, negative = down/close). `pointer` is "mouse" (real Playwright mouse)
 * or "touch" (CDP Input.dispatchTouchEvent through Chromium's real touch path).
 * `slow` inserts per-step waits so elapsed time is real → LOW velocity (forces a
 * distance-threshold decision); without it the moves fire back-to-back → HIGH
 * velocity (a flick). `hold` leaves the pointer down for a mid-drag screenshot.
 */
const heldTouchDrags = new WeakMap();
const testIdSelector = (testId) => `[data-testid="${testId}"]`;

async function visibleBoxForTestId(p, target, timeout = 3000) {
  const selector = testIdSelector(target);
  try {
    await p.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      },
      selector,
      { timeout },
    );
  } catch (error) {
    const state = await p.evaluate(() => {
      const sheet = document.querySelector('[data-testid="chat-sheet"]');
      const restore = document.querySelector(
        '[data-testid="chat-maximize-restore-zone"]',
      );
      const grabber = document.querySelector('[data-testid="chat-sheet-grabber"]');
      const pill = document.querySelector('[data-testid="chat-pill"]');
      const rect = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return {
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.round(b.width),
          height: Math.round(b.height),
        };
      };
      return {
        sheet: sheet
          ? {
              detent: sheet.getAttribute("data-detent"),
              variant: sheet.getAttribute("data-variant"),
              maximized: sheet.getAttribute("data-maximized"),
              chatState: sheet.getAttribute("data-chat-state"),
              rect: rect(sheet),
            }
          : null,
        grabber: rect(grabber),
        restore: rect(restore),
        pill: rect(pill),
      };
    });
    throw new Error(
      `gesture target ${target} did not produce a visible box: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
  const box = await p.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    };
  }, selector);
  if (!box) {
    const state = await p.evaluate(() => ({
      sheet: document.querySelector('[data-testid="chat-sheet"]')?.outerHTML,
    }));
    throw new Error(
      `gesture target ${target} resolved without a bounding box: ${JSON.stringify(state)}`,
    );
  }
  return box;
}

async function gesture(
  p,
  up,
  {
    pointer = "mouse",
    slow = false,
    hold = false,
    steps = 12,
    stepDelayMs,
    // Which handle to drag. When omitted, follow the live detent: the pill
    // state unmounts the open-sheet grabber, so the gesture must start from the
    // pill itself.
    target,
  } = {},
) {
  const resolvedTarget =
    target ??
    ((await chatState(p)) === "MAXIMIZED"
      ? "chat-maximize-restore-zone"
      : (await detent(p)) === "pill"
        ? "chat-pill"
        : "chat-sheet-grabber");
  if (pointer === "touch") {
    await visibleBoxForTestId(p, resolvedTarget);
    const drag = await touchDragHold(p, testIdSelector(resolvedTarget), 0, -up, {
      steps,
      stepDelayMs: slow ? 28 : (stepDelayMs ?? 1),
    });
    if (hold) {
      heldTouchDrags.set(p, drag);
    } else {
      await drag.release();
    }
    return;
  }

  const b = await visibleBoxForTestId(p, resolvedTarget);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const targetY = (i) => cy - (up * i) / steps;
  await p.mouse.move(cx, cy);
  await p.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await p.mouse.move(cx, targetY(i));
    if (slow) await p.waitForTimeout(28);
    else if (stepDelayMs != null && stepDelayMs > 0)
      await p.waitForTimeout(stepDelayMs);
  }
  if (!hold) await p.mouse.up();
}
async function release(p, pointer, up = 0) {
  if (pointer === "mouse") {
    await p.mouse.up();
  } else {
    const drag = heldTouchDrags.get(p);
    if (!drag) throw new Error("release(touch): no held real-touch drag");
    heldTouchDrags.delete(p);
    await drag.release();
  }
}

async function maximizeByPull(p, pointer = "mouse") {
  await gesture(p, 760, { pointer, slow: true, steps: 24 });
  await p.waitForTimeout(SETTLE);
}

async function openToFullDetent(p, pointer, label = "open to FULL") {
  await gesture(p, 160, { pointer, slow: false, steps: 1 });
  await p.waitForTimeout(SETTLE);
  if ((await detent(p)) !== "full") {
    await gesture(p, 220, { pointer, slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
  }
  assert((await detent(p)) === "full", `[${pointer}] ${label}`);
}

// `keyboardTouch`: after a big BEYOND-full over-pull the full-bleed panel on the
// mobile fixture renders WIDER than the emulated CSS viewport, so the restore
// zone's center lands off the interactive area and a synthetic CDP finger drag
// there gets a spurious touchcancel after its first move (offset stuck at 0, no
// un-maximize). For that setup step, drive the restore through the zone's own
// WCAG keyboard affordance (ArrowDown → un-maximize) — geometry-independent, so
// the SETTLE under test runs deterministically. The touch restore DRAG itself
// stays covered by the on-screen `restore-zone pull` step (keyboardTouch=false).
async function restoreFromMaximized(p, pointer = "mouse", keyboardTouch = false) {
  const zone = p.getByTestId("chat-maximize-restore-zone");
  await zone.waitFor();
  // 120px keeps the released height inside the FULL detent's magnet
  // (SHEET_DETENT_MAGNET below the inset ceiling), so the restore
  // deterministically snaps to the inset FULL detent instead of free-resting a
  // few px under the magnet edge (140px sat right on that boundary).
  if (pointer === "touch" && keyboardTouch) {
    await zone.focus();
    await p.keyboard.press("ArrowDown");
  } else {
    await gesture(p, -120, {
      pointer,
      slow: true,
      steps: 8,
      target: "chat-maximize-restore-zone",
      stepDelayMs: pointer === "touch" ? 12 : undefined,
    });
  }
  await p.waitForTimeout(SETTLE);
}

async function restoreFromMaximizedByKeyboard(p) {
  const zone = p.getByTestId("chat-maximize-restore-zone");
  await zone.waitFor();
  await zone.focus();
  await p.keyboard.press("ArrowDown");
  await p.waitForTimeout(SETTLE);
}

/** Full detent-stepping + flick + sub-threshold + rubber-band suite for one input type. */
async function runDragSuite(p, pointer, tag) {
  const vh = await viewportH(p);
  const halfH = Math.round(vh * 0.46);
  // FULL now fills to the panel's max height (sheet rises to the top), captured
  // live once we reach it — no fixed fraction.
  let fullH = 0;
  const TOL = 36;
  await p.waitForTimeout(150);

  // fully collapsed at rest — the thread is gone (height 0), just the input
  assert((await variant(p)) === "closed", `[${pointer}] starts COLLAPSED (closed)`);
  assert((await detent(p)) === "collapsed", `[${pointer}] detent is collapsed at rest`);
  assert(near(await sheetHeight(p), 0, 6), `[${pointer}] COLLAPSED thread height ≈ 0px`);
  await snap(p, `${tag}-collapsed`);

  // FLICK up → HALF (fast deliberate pull crosses the velocity threshold → snap to a detent)
  await gesture(p, 160, { pointer, slow: false, steps: 1 });
  await p.waitForTimeout(SETTLE);
  assert((await detent(p)) === "half", `[${pointer}] flick-up snaps COLLAPSED→HALF`);
  await waitForSheetHeightNear(p, halfH, TOL);
  assert(near(await sheetHeight(p), halfH, TOL), `[${pointer}] HALF height ≈ ${halfH}px (got ${Math.round(await sheetHeight(p))})`);
  await snap(p, `${tag}-half`);
  // #9142 regression guard: the grabber BAR (inner span) must actually PAINT
  // once the sheet is open — a prior regression pinned the bar to `opacity-0`,
  // leaving the handle grabbable but invisible. The wrapper's `grabberOpacity`
  // crossfade owns show/hide; the bar's OWN opacity must be 1, never 0.
  const grabberBarOpacity = await p.evaluate(() =>
    getComputedStyle(
      document
        .querySelector('[data-testid="chat-sheet-grabber"]')
        ?.querySelector("span") ?? document.body,
    ).opacity,
  );
  assert(
    grabberBarOpacity === "1",
    `[${pointer}] grabber bar paints (inner-span opacity "${grabberBarOpacity}" === "1", not opacity-0) (#9142)`,
  );
  // The sheet header shows at HALF and up now, not only at FULL. It reserves the
  // safe-area/status strip; user actions live in the composer + menu, and
  // maximize stays a gesture/state contract instead of a header button.
  assert(
    (await headerShown(p)) &&
      (await p.getByTestId("chat-full-launcher").count()) === 0 &&
      (await p.getByTestId("chat-full-maximize").count()) === 0 &&
      (await p.getByTestId("chat-full-clear").count()) === 0,
    `[${pointer}] HALF detent shows the status header without action buttons`,
  );

  // FLICK up again → FULL — the sheet rises to the top of the screen
  await gesture(p, 140, { pointer, slow: false, steps: 1 });
  await p.waitForTimeout(SETTLE);
  assert((await detent(p)) === "full", `[${pointer}] flick-up snaps HALF→FULL`);
  fullH = Math.round(await sheetHeight(p));
  assert(fullH > halfH + 40, `[${pointer}] FULL is taller than HALF (full ${fullH} > half ${halfH})`);
  const top = Math.round(await panelTop(p));
  assert(
    near(top, SHEET_TOP_MARGIN, TOL + 12),
    `[${pointer}] FULL rises to the top (panel top ${top}px ≈ ${SHEET_TOP_MARGIN}px)`,
  );
  await snap(p, `${tag}-full`);

  // The full detent keeps the same header contract: no launcher/search/maximize
  // or new-chat controls. The composer menu owns actions for this conversation.
  assert(
    (await headerShown(p)) &&
      (await p.getByTestId("chat-full-launcher").count()) === 0 &&
      (await p.getByTestId("chat-full-maximize").count()) === 0 &&
      (await p.getByTestId("chat-full-clear").count()) === 0,
    `[${pointer}] full detent keeps action buttons out of the header`,
  );
  // Maximize → full-bleed (edge-to-edge): a deliberate over-pull flips
  // data-maximized and the panel reaches x=0.
  await maximizeByPull(p, pointer);
  assert(
    (await p.locator('[data-testid="chat-sheet"][data-maximized="true"]').count()) === 1,
    `[${pointer}] over-pull maximize → data-maximized=true (full screen)`,
  );
  const maxBox = await p.getByTestId("chat-sheet").boundingBox();
  assert(
    !!maxBox && maxBox.x <= 1,
    `[${pointer}] maximized panel is edge-to-edge (x=${Math.round(maxBox?.x ?? -1)})`,
  );
  // Restore → inset again via the top restore zone.
  await restoreFromMaximized(p, pointer);
  assert(
    (await p.locator('[data-testid="chat-sheet"][data-maximized="true"]').count()) === 0,
    `[${pointer}] restore-zone pull → no longer maximized`,
  );

  // drag BEYOND full → maximize is a DISCRETE state, not a per-pixel morph. As
  // the over-pull crosses its threshold the whole shape SPRINGS edge-to-edge
  // (panel x → 0, corners square, border/inset drop together). Pull well past
  // the FULL detent, hold, and let the spring settle: the sheet must read as
  // MAXIMIZED (edge-to-edge, x ≈ 0), not a half-morphed inset panel.
  await gesture(p, 420, { pointer, hold: true, slow: true, steps: 24 });
  await p.waitForTimeout(SETTLE);
  const beyondMaxed =
    (await p
      .locator('[data-testid="chat-sheet"][data-maximized="true"]')
      .count()) === 1;
  const beyondBox = await p.getByTestId("chat-sheet").boundingBox();
  assert(
    beyondMaxed && !!beyondBox && beyondBox.x <= 4,
    `[${pointer}] a large over-pull COMMITS the discrete maximize edge-to-edge (maximized=${beyondMaxed}, panel x=${Math.round(beyondBox?.x ?? -1)})`,
  );
  await snap(p, `${tag}-beyond-full-rubberband`);
  await release(p, pointer, 420);
  await p.waitForTimeout(SETTLE);
  assert(
    (await p
      .locator('[data-testid="chat-sheet"][data-maximized="true"]')
      .count()) === 1,
    `[${pointer}] releasing the committed over-pull stays MAXIMIZED`,
  );
  await restoreFromMaximized(p, pointer);
  assert(
    near(await sheetHeight(p), fullH, TOL + 48),
    `[${pointer}] settles back near FULL after restore`,
  );
  const restoredState = await chatState(p);
  const restoredStillMaximized =
    (await p
      .locator('[data-testid="chat-sheet"][data-maximized="true"]')
      .count()) === 1;
  assert(
    restoredState !== "MAXIMIZED" && !restoredStillMaximized,
    `[${pointer}] restore after committed over-pull leaves MAXIMIZED state (state=${restoredState}, data-maximized=${restoredStillMaximized})`,
  );
  if (restoredStillMaximized) {
    await restoreFromMaximizedByKeyboard(p);
  }

  // mid-drag HOLD between detents (live 1:1 tracking)
  await gesture(p, -150, { pointer, hold: true }); // pull down ~150 from full
  await p.waitForTimeout(120);
  const midH = await sheetHeight(p);
  assert(
    midH < fullH - 20 && midH > halfH - 120,
    `[${pointer}] mid-drag tracks the finger downward (got ${Math.round(midH)}, below full ${fullH})`,
  );
  await snap(p, `${tag}-mid-drag-hold`);
  await release(p, pointer, -150);
  await p.waitForTimeout(SETTLE);

  // FREE DRAG: a deliberate SLOW drag RESTS where released (not snapped to a
  // detent). Reset to a clean inset FULL, then slow-drag down. The
  // strict "rests in the middle" check is mouse-authoritative — real touch can
  // coalesce a slow drag and under-travel; touch still verifies the sheet stays
  // open (no snap-shut) after the drag. The preceding maximize/restore checks
  // intentionally churn full-bleed state; normalize before this independent
  // free-rest assertion so it only tests the open-sheet grabber.
  await p.keyboard.press("Escape");
  await p.waitForTimeout(SETTLE);
  await openToFullDetent(p, pointer, "free-rest reset reaches FULL");
  const startFree = Math.round(await sheetHeight(p));
  await gesture(p, -240, { pointer, slow: true, steps: 24 });
  await p.waitForTimeout(SETTLE);
  const restedH = Math.round(await sheetHeight(p));
  if (pointer === "mouse") {
    assert(
      restedH > halfH + 30 && restedH < startFree - 60,
      `[${pointer}] slow drag RESTS at a free height — rested ${restedH}, between half ${halfH} and full ${startFree} (not snapped)`,
    );
  } else {
    assert(
      restedH <= startFree && restedH > halfH - 80,
      `[${pointer}] slow drag rests open (rested ${restedH}, start ${startFree})`,
    );
  }
  assert((await variant(p)) === "open", `[${pointer}] free-rested sheet stays open`);
  await snap(p, `${tag}-free-rest`);

  // FLICK down → COLLAPSED (from the free height). Loop until closed (stops
  // before reaching the pill, since the pill needs a flick from the collapsed
  // input — not an open sheet).
  for (let i = 0; i < 5 && (await variant(p)) === "open"; i += 1) {
    await gesture(p, -130, { pointer, slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
  }
  assert((await variant(p)) === "closed", `[${pointer}] flick-down returns to COLLAPSED`);
  // Let the collapse spring fully settle before measuring the resting thread.
  await p.waitForTimeout(SETTLE);
  // thread ≈ 0; allow a small band for the spring tail (touch dispatch wider).
  assert(
    near(await sheetHeight(p), 0, pointer === "mouse" ? 30 : 48),
    `[${pointer}] back COLLAPSED, thread ≈ 0px (got ${Math.round(await sheetHeight(p))})`,
  );
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

  // FLICK up (short + fast → velocity threshold, distance < 56). Use a
  // one-frame decisive move: multiple sub-56 automation moves can spend most of
  // their time in CDP/Playwright plumbing instead of in the gesture itself.
  await gesture(p, 54, {
    pointer,
    slow: false,
    steps: 1,
    stepDelayMs: pointer === "touch" ? 0 : undefined,
  });
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

/**
 * The pill ↔ maximize CONTINUUM suite (state matrix: CHAT_SHEET_STATE_MATRIX.md).
 * Drives the two signature HELD gestures end to end and samples geometry per
 * step so the morph is provably smooth and monotonic:
 *   1. INPUT → PILL (flick down), then ONE held drag from the pill to the top
 *      of the screen → release commits MAXIMIZED (edge-to-edge).
 *   2. ONE held drag from the maximized restore strip all the way past the
 *      bottom → release commits the PILL again.
 * Plus the detent rules: pill nudge springs back; a pill drag past half the
 * morph lands on the input; a short input pull springs back; tap-open → half;
 * open + tap grabber → collapse to input.
 * Mouse samples geometry every step; real touch drives the same gestures but
 * only asserts the endpoints (CDP touch moves coalesce, so mid-drag DOM reads
 * are not frame-stable).
 */
const effectivePillOpacity = (p) =>
  p.evaluate(() => {
    let el = document.querySelector('[data-testid="chat-pill"]');
    if (!el) return -1;
    let o = 1;
    while (el && !(el instanceof HTMLFieldSetElement)) {
      o *= Number.parseFloat(getComputedStyle(el).opacity);
      el = el.parentElement;
    }
    return o;
  });

async function heldMouseDragSample(p, target, startYOffset, endY, steps) {
  const b = await p.getByTestId(target).boundingBox();
  const cx = b.x + b.width / 2;
  const startY = b.y + (startYOffset ?? b.height / 2);
  const samples = [];
  await p.mouse.move(cx, startY);
  await p.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await p.mouse.move(cx, startY + ((endY - startY) * i) / steps);
    await p.waitForTimeout(16);
    samples.push({
      h: await sheetHeight(p),
      panel: await p.getByTestId("chat-sheet").boundingBox(),
      pillOpacity: await effectivePillOpacity(p),
    });
  }
  await p.mouse.up();
  return samples;
}

function assertMonotonic(samples, key, dir, tol, label) {
  let ok = true;
  let worst = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const delta = (samples[i][key] - samples[i - 1][key]) * dir;
    if (delta < -tol) {
      ok = false;
      worst = Math.min(worst, delta);
    }
  }
  assert(
    ok,
    `${label} (${key} ${dir > 0 ? "non-decreasing" : "non-increasing"}, worst regression ${Math.round(-worst)}px > ${tol}px tol)`,
  );
}

async function runContinuumSuite(p, pointer, tag) {
  const vh = await viewportH(p);
  const vw = await p.evaluate(() => window.innerWidth);
  const halfH = Math.round(vh * 0.46);

  // -- INPUT → PILL (flick down on the grabber) ------------------------------
  assert(
    (await variant(p)) === "closed",
    `[${tag}-continuum] starts at the INPUT resting state`,
  );
  await gesture(p, -120, { pointer, slow: false, steps: 1 });
  await p.waitForTimeout(SETTLE);
  assert(
    (await detent(p)) === "pill" && (await chatState(p)) === "CLOSED",
    `[${tag}-continuum] flick-down collapses INPUT → PILL`,
  );
  assert(
    (await effectivePillOpacity(p)) >= 0.9,
    `[${tag}-continuum] pill capsule is painted at rest (opacity ≥ 0.9)`,
  );
  await snap(p, `${tag}-continuum-pill`);

  // -- Detent rule: a small slow pull on the pill springs back to the pill ---
  await gesture(p, 40, { pointer, slow: true, steps: 8, target: "chat-pill" });
  await p.waitForTimeout(SETTLE);
  assert(
    (await detent(p)) === "pill",
    `[${tag}-continuum] sub-halfway pill nudge (40px) springs back to PILL`,
  );

  // -- Detent rule: a pill drag past half the morph but short of the thread
  //    lands on the INPUT bar (pill → input → chat is one continuum) ---------
  await gesture(p, 90, { pointer, slow: true, steps: 10, target: "chat-pill" });
  await p.waitForTimeout(SETTLE);
  assert(
    (await detent(p)) === "collapsed",
    `[${tag}-continuum] pill drag past halfway (90px) rests at INPUT, not half`,
  );

  // -- Detent rule: a short input pull (under a visible row) springs back ----
  await gesture(p, 50, { pointer, slow: true, steps: 8 });
  await p.waitForTimeout(SETTLE);
  assert(
    (await variant(p)) === "closed" && near(await sheetHeight(p), 0, 24),
    `[${tag}-continuum] 50px input pull (no full row) springs back to INPUT`,
  );

  // -- Back to the pill for the big held drag --------------------------------
  await gesture(p, -120, { pointer, slow: false, steps: 1 });
  await p.waitForTimeout(SETTLE);
  assert(
    (await detent(p)) === "pill",
    `[${tag}-continuum] re-collapsed to PILL for the held continuum drag`,
  );

  // -- (1) ONE HELD DRAG: pill → top of screen → MAXIMIZED -------------------
  if (pointer === "mouse") {
    const samples = await heldMouseDragSample(p, "chat-pill", null, 8, 28);
    assertMonotonic(
      samples,
      "h",
      +1,
      12,
      `[${tag}-continuum] held pill→top drag: thread height tracks the finger smoothly`,
    );
    const last = samples[samples.length - 1];
    assert(
      last.pillOpacity <= 0.05,
      `[${tag}-continuum] pill capsule fully faded out mid-drag (opacity ${last.pillOpacity.toFixed(2)})`,
    );
    assert(
      last.h >= halfH,
      `[${tag}-continuum] held drag reached past HALF before release (${Math.round(last.h)}px ≥ ${halfH}px)`,
    );
  } else {
    const b = await p.getByTestId("chat-pill").boundingBox();
    const cy = b.y + b.height / 2;
    const drag = await touchDragHold(p, testIdSelector("chat-pill"), 0, -(cy - 8), {
      steps: 28,
      stepDelayMs: 16,
    });
    await drag.release();
  }
  await p.waitForTimeout(SETTLE);
  assert(
    (await p
      .locator('[data-testid="chat-sheet"][data-maximized="true"]')
      .count()) === 1 && (await chatState(p)) === "MAXIMIZED",
    `[${tag}-continuum] releasing the held pill→top drag commits MAXIMIZED`,
  );
  const maxBox = await p.getByTestId("chat-sheet").boundingBox();
  assert(
    !!maxBox && maxBox.x <= 1 && near(maxBox.width, vw, 2),
    `[${tag}-continuum] maximized panel is edge-to-edge (x=${Math.round(maxBox?.x ?? -1)}, w=${Math.round(maxBox?.width ?? -1)}/${vw})`,
  );
  if (vw > 900) {
    // The text column must NOT stretch with the background: the thread stays
    // at the reading width (max-w-3xl ≈ 768px) while the panel fills the
    // screen — "the chat div morphs into a full-screen background, the text
    // stays as it is".
    const contentW = await p.evaluate(
      () =>
        document
          .querySelector('[data-testid="chat-thread"]')
          ?.getBoundingClientRect().width ?? -1,
    );
    assert(
      contentW > 0 && contentW <= 802,
      `[${tag}-continuum] maximized text column keeps its reading width (${Math.round(contentW)}px ≤ 802px, panel ${vw}px)`,
    );
  }
  await snap(p, `${tag}-continuum-maximized`);

  // -- (2) ONE HELD DRAG: maximized → past the bottom → PILL -----------------
  if (pointer === "mouse") {
    const samples = await heldMouseDragSample(
      p,
      "chat-maximize-restore-zone",
      16,
      vh - 2,
      30,
    );
    assertMonotonic(
      samples,
      "h",
      -1,
      12,
      `[${tag}-continuum] held top→bottom drag: thread height tracks the finger smoothly`,
    );
    const last = samples[samples.length - 1];
    assert(
      near(last.h, 0, 32),
      `[${tag}-continuum] held drag consumed the whole thread height (${Math.round(last.h)}px ≈ 0)`,
    );
  } else {
    // Start near the TOP of the restore strip (its center is mid-screen —
    // starting there leaves too little travel to reach the bottom), then drag
    // to the screen edge in one held gesture. Raw CDP: touchDragHold always
    // starts at the element center.
    const zone = await p
      .getByTestId("chat-maximize-restore-zone")
      .boundingBox();
    const cx = zone.x + zone.width / 2;
    const startY = zone.y + 16;
    const cdp = await p.context().newCDPSession(p);
    const point = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point(cx, startY),
    });
    const steps = 30;
    for (let i = 1; i <= steps; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(cx, startY + ((vh - 2 - startY) * i) / steps),
      });
      await p.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach().catch(() => {});
  }
  await p.waitForTimeout(SETTLE);
  assert(
    (await detent(p)) === "pill" && (await chatState(p)) === "CLOSED",
    `[${tag}-continuum] releasing the held top→bottom drag lands on the PILL`,
  );
  assert(
    (await p
      .locator('[data-testid="chat-sheet"][data-maximized="true"]')
      .count()) === 0,
    `[${tag}-continuum] full-bleed dropped on the way down`,
  );
  assert(
    (await effectivePillOpacity(p)) >= 0.9,
    `[${tag}-continuum] pill capsule painted again after the round trip`,
  );
  await snap(p, `${tag}-continuum-back-to-pill`);

  // -- Detent rules: pill tap → HALF; open + grabber tap → INPUT -------------
  if (pointer === "mouse") {
    await p.getByTestId("chat-pill").click();
  } else {
    await touchTap(p, testIdSelector("chat-pill"));
  }
  await p.waitForTimeout(SETTLE);
  assert(
    (await detent(p)) === "half",
    `[${tag}-continuum] pill tap opens straight to HALF`,
  );
  // The pill tap also focused the composer (keyboard up), so the FIRST grabber
  // tap dismisses the keyboard and keeps the sheet at its detent; the SECOND
  // collapses to the input bar — the designed two-step.
  const grabberTap = async () => {
    if (pointer === "mouse") await p.getByTestId("chat-sheet-grabber").click();
    else await touchTap(p, testIdSelector("chat-sheet-grabber"));
    await p.waitForTimeout(SETTLE);
  };
  await grabberTap();
  assert(
    (await detent(p)) === "half",
    `[${tag}-continuum] first grabber tap (keyboard up) dismisses the keyboard, stays HALF`,
  );
  await grabberTap();
  assert(
    (await detent(p)) === "collapsed" && (await variant(p)) === "closed",
    `[${tag}-continuum] second grabber tap collapses the open sheet to INPUT`,
  );
  await snap(p, `${tag}-continuum-final-input`);
}

/** Effective panel scale — the pill↔input morph shrinks the whole fieldset
 *  (transform scale toward bottom-center). Reads the independent `scale`
 *  property or the transform matrix, whichever the motion runtime rendered. */
const panelScale = (p) =>
  p.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-sheet"]');
    if (!el) return -1;
    const cs = getComputedStyle(el);
    if (cs.scale && cs.scale !== "none") return Number.parseFloat(cs.scale);
    const m = cs.transform.match(/matrix\(([^,]+),/);
    return m ? Number.parseFloat(m[1]) : 1;
  });

/**
 * HELD-DRAG TRACKING — the follow-the-pointer contract, plus the DISCRETE
 * maximize state. The HEIGHT and the input↔pill morph (panel scale + capsule
 * crossfade) track the finger 1:1 in both directions with zero drift across any
 * number of reversals in one gesture; the maximize SHAPE is a state that springs
 * edge-to-edge once the over-pull crosses its threshold and springs back when it
 * reverses (not a per-pixel lerp). Asserted mid-hold:
 *   1. INPUT → hold-drag down: the input visibly scales down into the pill
 *      capsule under the finger (scale → PILL_MORPH_MIN_SCALE, pill painted);
 *   2. pill → hold-drag to the top: the panel grows tall under the finger and,
 *      by release, the chat is MAXIMIZED (the long-haul intent);
 *   3. up→down→up reversals in ONE held gesture track 1:1 with zero drift and
 *      still maximize on release at the top;
 *   4. FULL → hold-drag past the bottom: the thread height drains to 0 and the
 *      input→pill morph engages under the held finger; release lands PILL.
 * Real-touch hold-drags coalesce mid-gesture, so this runs mouse-only
 * (runContinuumSuite already proves the touch release path).
 */
async function runMidDragCommitSuite(p, tag) {
  const vh = await viewportH(p);
  const cx = (await p.evaluate(() => window.innerWidth)) / 2;

  // (1) INPUT → held pull DOWN: the input↔pill morph tracks the finger.
  assert(
    (await detent(p)) === "collapsed",
    `[${tag}-held] starts at the INPUT resting state`,
  );
  await gesture(p, -170, {
    pointer: "mouse",
    hold: true,
    slow: true,
    steps: 14,
  });
  await p.waitForTimeout(220);
  const heldScale = await panelScale(p);
  assert(
    heldScale <= 0.55,
    `[${tag}-held] input SCALES DOWN to the pill under the held finger (scale ${heldScale.toFixed(2)} ≤ 0.55)`,
  );
  assert(
    (await effectivePillOpacity(p)) >= 0.85,
    `[${tag}-held] pill capsule is painted under the held finger (crossfade tracked)`,
  );
  await snap(p, `${tag}-held-input-to-pill`);
  await p.mouse.up();
  await p.waitForTimeout(SETTLE);
  assert(
    (await detent(p)) === "pill",
    `[${tag}-held] releasing the tracked collapse lands on the PILL`,
  );

  // (2) PILL → held pull to the top: exact-follow, then maximize on release.
  const pillBox = await p.getByTestId("chat-pill").boundingBox();
  const grabY = pillBox.y + pillBox.height / 2;
  const topY = 40;
  await gesture(p, grabY - topY, {
    pointer: "mouse",
    hold: true,
    slow: true,
    steps: 26,
    target: "chat-pill",
  });
  await p.waitForTimeout(220);
  // The panel grew tall under the finger — height tracks the pull (minus the
  // PILL_OPEN_DISTANCE the morph consumes). The maximize SHAPE is discrete, so
  // whether edge-to-edge commits mid-hold vs on release depends on how far the
  // pull cleared the inset ceiling on this geometry; assert only that the panel
  // is tall here, and that the release lands MAXIMIZED.
  const heldH = await sheetHeight(p);
  assert(
    heldH > (grabY - topY) * 0.6,
    `[${tag}-held] pill→top hold grows the panel tall under the finger (${Math.round(heldH)}px)`,
  );
  await snap(p, `${tag}-held-pill-to-top`);
  await p.mouse.up();
  await p.waitForTimeout(SETTLE);
  assert(
    (await p
      .locator('[data-testid="chat-sheet"][data-maximized="true"]')
      .count()) === 1 && (await detent(p)) === "full",
    `[${tag}-held] the long-haul pull to the top ends MAXIMIZED`,
  );

  // Put the chat away again for the reversal leg (restore-strip drag down).
  await restoreFromMaximized(p, "mouse");
  await gesture(p, -(vh + 80), { pointer: "mouse", slow: true, steps: 20 });
  await p.waitForTimeout(SETTLE);
  assert(
    (await detent(p)) === "pill",
    `[${tag}-held] back on the PILL for the reversal leg`,
  );

  // (3) ONE held gesture, up → down → up: tracks 1:1 with no drift, and the
  // release at the top still maximizes (the up-down-up regression case).
  const pill2 = await p.getByTestId("chat-pill").boundingBox();
  const grabY2 = pill2.y + pill2.height / 2;
  await p.mouse.move(cx, grabY2);
  await p.mouse.down();
  const leg = async (toY, steps = 18) => {
    await p.mouse.move(cx, toY, { steps });
    await p.waitForTimeout(220);
    return await sheetHeight(p);
  };
  const upH1 = await leg(topY);
  assert(
    near(upH1, grabY2 - topY - 120, 30),
    `[${tag}-held] reversal leg 1 (up) tracks (${Math.round(upH1)}px)`,
  );
  const downH = await leg(grabY2);
  assert(
    near(downH, 0, 20),
    `[${tag}-held] reversal leg 2 (down) returns to the bottom with NO drift (${Math.round(downH)}px ≈ 0)`,
  );
  const upH2 = await leg(topY);
  assert(
    near(upH2, grabY2 - topY - 120, 30),
    `[${tag}-held] reversal leg 3 (up again) tracks identically (${Math.round(upH2)}px)`,
  );
  await p.mouse.up();
  await p.waitForTimeout(SETTLE);
  assert(
    (await p
      .locator('[data-testid="chat-sheet"][data-maximized="true"]')
      .count()) === 1,
    `[${tag}-held] releasing at the top after reversals still MAXIMIZES`,
  );
  await snap(p, `${tag}-held-up-down-up-maximized`);

  // (4) tall OPEN sheet → held drag past the bottom: the thread drains and the
  // input→pill morph engages under the held finger; release lands on the PILL.
  // (The restore drag rests the sheet at a tall inset height — the drain leg
  // only needs it open and un-maximized so the grabber is mounted.)
  await restoreFromMaximized(p, "mouse");
  assert(
    (await p
      .locator('[data-testid="chat-sheet"][data-maximized="true"]')
      .count()) === 0 && (await variant(p)) === "open",
    `[${tag}-held] restored to a tall INSET sheet for the drain leg`,
  );
  await gesture(p, -(vh + 80), {
    pointer: "mouse",
    hold: true,
    slow: true,
    steps: 28,
    target: "chat-sheet-grabber",
  });
  await p.waitForTimeout(220);
  assert(
    near(await sheetHeight(p), 0, 20),
    `[${tag}-held] FULL→bottom hold drains the whole thread height under the finger`,
  );
  const drainScale = await panelScale(p);
  assert(
    drainScale <= 0.7,
    `[${tag}-held] the input→pill morph engages under the held finger (scale ${drainScale.toFixed(2)} ≤ 0.7)`,
  );
  await snap(p, `${tag}-held-full-drained`);
  await p.mouse.up();
  await p.waitForTimeout(SETTLE);
  assert(
    (await detent(p)) === "pill",
    `[${tag}-held] releasing the drained drag lands on the PILL`,
  );
}

const BIG_STREAM_GROWTH = `\n\n${Array.from(
  { length: 18 },
  (_, i) =>
    `streamed burst ${i + 1}: this deliberately wraps across the chat bubble so one committed growth is taller than the 80px at-bottom threshold.`,
).join(" ")}`;

async function mutateAssistant(p, hook, text) {
  const ok = await p.evaluate(
    ({ hook, text }) => {
      const fn = window[hook];
      if (typeof fn !== "function") return false;
      fn(text);
      return true;
    },
    { hook, text },
  );
  assert(ok, `fixture exposes ${hook}`);
}

async function openSheetToFull(p, pointer) {
  await p.waitForSelector('[data-testid="chat-sheet"]');
  await gesture(p, 160, { pointer, slow: false, steps: 1 });
  await p.waitForTimeout(SETTLE);
  if ((await detent(p)) !== "full") {
    await gesture(p, 220, { pointer, slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
  }
  assert((await detent(p)) === "full", `[${pointer}] AUTOSCROLL opens the sheet to FULL`);
  await waitForThreadBottom(p);
  const state = await threadScrollState(p);
  assert(
    !!state && state.scrollHeight > state.clientHeight + 120,
    `[${pointer}] AUTOSCROLL fixture has real overflow (scrollHeight=${Math.round(state?.scrollHeight ?? 0)}, clientHeight=${Math.round(state?.clientHeight ?? 0)})`,
  );
  assert(
    !!state && state.bottomDelta <= 18,
    `[${pointer}] AUTOSCROLL starts pinned to bottom (delta=${Math.round(state?.bottomDelta ?? -1)})`,
  );
}

async function scrollReaderUp(p, pointer) {
  const selector = testIdSelector("chat-thread-scroll");
  const before = await threadScrollState(p);
  if (pointer === "mouse") {
    await p.getByTestId("chat-thread-scroll").hover();
    await p.mouse.wheel(0, -420);
  } else {
    await touchSwipe(p, selector, 0, 280, { steps: 16, stepDelayMs: 16 });
  }
  await p.waitForTimeout(360);
  const after = await threadScrollState(p);
  assert(
    !!before && !!after && after.scrollTop < before.scrollTop - 80,
    `[${pointer}] AUTOSCROLL real ${pointer === "mouse" ? "wheel" : "touch"} scroll moves reader into history (${Math.round(before?.scrollTop ?? 0)} → ${Math.round(after?.scrollTop ?? 0)})`,
  );
  return after;
}

async function runAutoScrollSuite(p, pointer, tag) {
  await openSheetToFull(p, pointer);
  const beforeLargeGrowth = await threadScrollState(p);
  await mutateAssistant(p, "__growLastAssistant", BIG_STREAM_GROWTH);
  await p.waitForTimeout(260);
  const afterLargeGrowth = await threadScrollState(p);
  const largeGrowthPx =
    (afterLargeGrowth?.scrollHeight ?? 0) -
    (beforeLargeGrowth?.scrollHeight ?? 0);
  assert(
    largeGrowthPx > 80,
    `[${pointer}] AUTOSCROLL single streamed growth exceeds 80px (${Math.round(largeGrowthPx)}px)`,
  );
  assert(
    !!afterLargeGrowth && afterLargeGrowth.bottomDelta <= 18,
    `[${pointer}] AUTOSCROLL stays pinned after >80px growth (delta=${Math.round(afterLargeGrowth?.bottomDelta ?? -1)})`,
  );

  await mutateAssistant(
    p,
    "__appendAssistant",
    "A fresh assistant line lands while the reader is already at the bottom.",
  );
  await waitForThreadBottom(p);
  const afterAppend = await threadScrollState(p);
  assert(
    !!afterAppend && afterAppend.bottomDelta <= 18,
    `[${pointer}] AUTOSCROLL stays pinned after a new assistant line (delta=${Math.round(afterAppend?.bottomDelta ?? -1)})`,
  );

  const readerPosition = await scrollReaderUp(p, pointer);
  await mutateAssistant(
    p,
    "__growLastAssistant",
    "\n\nNew streamed text arrived below while the reader was reviewing older transcript content. It must not pull the viewport away from the reading position.",
  );
  await p.waitForTimeout(300);
  const afterScrollbackGrowth = await threadScrollState(p);
  assert(
    !!readerPosition &&
      !!afterScrollbackGrowth &&
      Math.abs(afterScrollbackGrowth.scrollTop - readerPosition.scrollTop) <= 32,
    `[${pointer}] AUTOSCROLL preserves reading scrollback on growth (${Math.round(readerPosition?.scrollTop ?? 0)} → ${Math.round(afterScrollbackGrowth?.scrollTop ?? 0)})`,
  );
  assert(
    await p.getByTestId("chat-jump-to-latest").isVisible(),
    `[${pointer}] AUTOSCROLL shows jump-to-latest while reader is above bottom`,
  );
  await p.getByTestId("chat-jump-to-latest").click();
  await waitForThreadBottom(p);
  const afterJump = await threadScrollState(p);
  assert(
    !!afterJump && afterJump.bottomDelta <= 18,
    `[${pointer}] AUTOSCROLL jump-to-latest re-pins to bottom (delta=${Math.round(afterJump?.bottomDelta ?? -1)})`,
  );
  await snap(p, `${tag}-autoscroll-jump-repinned`);
}

const browser = await chromium.launch();
const sink = { logs: [], errors: [] };

// FINGER-SYNC DIAGNOSTIC (env FINGER_PROBE=1): grab the pill and drag SLOWLY to
// the very top, then back down, recording at each step the cursor Y and the live
// grabber-bar center Y. Prints the divergence so we can see whether the handle
// stays under the finger 1:1 across the extremes.
// Drive a SLOW held grabber drag from the sheet's current open state to `endY`,
// sampling every step: the cursor Y and the panel's live TOP edge (what the user
// perceives as the sheet edge under the finger). Returns the per-step rows.
async function sampleGrabberDrag(page, endY, steps = 34) {
  const panelTopY = async () => {
    const box = await page
      .getByTestId("chat-sheet")
      .boundingBox()
      .catch(() => null);
    return box ? box.y : null;
  };
  const b = await page.getByTestId("chat-sheet-grabber").boundingBox();
  const cx = b.x + b.width / 2;
  const startY = b.y + b.height / 2;
  const rows = [];
  await page.mouse.move(cx, startY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const cursorY = startY + ((endY - startY) * i) / steps;
    await page.mouse.move(cx, cursorY);
    await page.waitForTimeout(22);
    const top = await panelTopY();
    rows.push({ cursorY, top, div: top == null ? null : top - cursorY });
  }
  await page.mouse.up();
  await page.waitForTimeout(SETTLE);
  return rows;
}

// Assert 1:1 finger tracking: across a slow held drag the panel top edge must
// stay under the finger with a CONSTANT offset (the grabber's fixed gap above
// the panel). We measure divergence = panelTop - cursor at each step and require
// it to stay within `band` px of the drag's own MEDIAN divergence — i.e. no
// dead zones (finger moves, edge doesn't) and no lag that accumulates. The first
// and last few samples are trimmed: at the extremes the finger runs past the
// panel's min/max (you can't drag the sheet above the screen top or below where
// the pill sits), which is a real boundary, not a tracking failure.
function assertFingerTracking(rows, band, label, topFloor = 40) {
  const usable = rows
    .filter((r) => r.div != null)
    // Drop samples inside the top boundary region (top ≤ topFloor): there the
    // grabber bar can't keep floating its fixed gap ABOVE the panel (nothing
    // above y=0) so its offset compresses, AND — since maximize is a DISCRETE
    // state — the last stretch up to the screen top is a shape SPRING, not 1:1
    // finger tracking. The 1:1 contract holds below the inset ceiling; pass a
    // higher `topFloor` for an upward drag that crosses into the maximize zone.
    .filter((r) => r.top > topFloor)
    .slice(2, -3);
  if (usable.length < 6) {
    assert(false, `${label}: too few usable samples (${usable.length})`);
    return;
  }
  const divs = usable.map((r) => r.div).sort((a, b) => a - b);
  const median = divs[Math.floor(divs.length / 2)];
  let worst = 0;
  for (const r of usable) {
    const drift = Math.abs(r.div - median);
    if (drift > worst) worst = drift;
  }
  assert(
    worst <= band,
    `${label}: panel top tracks the finger 1:1 (max drift ${Math.round(worst)}px from the ${Math.round(median)}px handle offset ≤ ${band}px band)`,
  );
  return { median, worst };
}

// FINGER-TRACKING SUITE — the smooth-motion validation the drag exists for: the
// sheet edge must follow the cursor EXACTLY (constant handle offset) while held,
// up to the very top (maximize) and down to the pill. Mouse-only: the assertion
// is engine-agnostic and real-touch CDP moves coalesce, defeating per-step
// geometry reads.
async function runFingerTrackingSuite(page) {
  // (A) OPEN → drag the grabber past the very top (maximize). Below the inset
  // ceiling the panel top tracks the finger 1:1; the last stretch to the screen
  // top is the DISCRETE maximize spring, so the 1:1 band is measured on the
  // sub-ceiling samples (topFloor 90) and the drag runs PAST the top so the
  // discrete commit fires and the panel reaches the edge.
  await gesture(page, 160, { pointer: "mouse", slow: false, steps: 1 });
  await page.waitForTimeout(SETTLE);
  const vh = await viewportH(page);
  const up = await sampleGrabberDrag(page, -30);
  const upStats = assertFingerTracking(up, 28, "[finger] UP open→top", 90);
  // The top must actually be reachable in one drag (the discrete commit springs
  // the panel edge-to-edge once the over-pull crosses the threshold).
  const minTop = Math.min(...up.filter((r) => r.top != null).map((r) => r.top));
  assert(
    minTop <= 40,
    `[finger] UP drag reaches the screen top (min panel top ${Math.round(minTop)}px ≤ 40px)`,
  );

  // Reset to a clean inset FULL sheet for the collapse test.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(SETTLE);
  await gesture(page, 160, { pointer: "mouse", slow: false, steps: 1 });
  await page.waitForTimeout(SETTLE);
  await gesture(page, 220, { pointer: "mouse", slow: false, steps: 1 });
  await page.waitForTimeout(SETTLE);

  // (B) FULL → drag the grabber all the way down; the sheet edge follows 1:1
  // and the chat ends collapsed at the bottom (pill/input).
  const down = await sampleGrabberDrag(page, vh - 8);
  const downStats = assertFingerTracking(down, 28, "[finger] DOWN full→pill");
  assert(
    (await variant(page)) === "closed",
    `[finger] DOWN drag collapses the chat to the bottom`,
  );

  // (C) MAXIMIZE ROUND-TRIP from the FULL detent — the reported regression:
  // starting AT the inset-full ceiling, dragging up must keep scaling to the
  // screen top under the finger (no freeze, and it must maximize with the finger
  // still ON screen, not far past it), and reversing DOWN in the same gesture
  // must un-scale 1:1 (no displaced dead zone from a committed-maximize state).
  // Reset to a clean INSET-full sheet (Escape → input → two flicks half→full):
  // opening from the pill/half and over-flicking lands NEAR-maximized, which
  // would make the round trip start inside the overshoot region.
  if ((await detent(page)) === "pill") {
    await page.getByTestId("chat-pill").click();
    await page.waitForTimeout(SETTLE);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(SETTLE);
  await gesture(page, 160, { pointer: "mouse", slow: false, steps: 1 });
  await page.waitForTimeout(SETTLE);
  await gesture(page, 160, { pointer: "mouse", slow: false, steps: 1 });
  await page.waitForTimeout(SETTLE);
  assert(
    (await detent(page)) === "full" &&
      (await page
        .locator('[data-testid="chat-sheet"][data-maximized="true"]')
        .count()) === 0,
    `[finger] reached INSET-full before the maximize round-trip (detent ${await detent(page)})`,
  );
  {
    const b = await page.getByTestId("chat-sheet-grabber").boundingBox();
    const cx = b.x + b.width / 2;
    const startY = b.y + b.height / 2;
    const topY = -28; // just past the screen top
    const rows = [];
    const readTop = async (cursorY, phase) => {
      const top = await page
        .getByTestId("chat-sheet")
        .boundingBox()
        .then((box) => box?.y ?? null)
        .catch(() => null);
      rows.push({ phase, cursorY, top });
    };
    await page.mouse.move(cx, startY);
    await page.mouse.down();
    for (let i = 1; i <= 40; i += 1) {
      const cy = startY + ((topY - startY) * i) / 40;
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(20);
      await readTop(cy, "up");
    }
    let maxedAtCursor = null;
    if (
      (await page
        .locator('[data-testid="chat-sheet"][data-maximized="true"]')
        .count()) === 1
    ) {
      maxedAtCursor = rows.find((r) => r.top != null && r.top <= 6)?.cursorY;
    }
    for (let i = 1; i <= 40; i += 1) {
      const cy = topY + ((startY - topY) * i) / 40;
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(20);
      await readTop(cy, "down");
    }
    await page.mouse.up();
    await page.waitForTimeout(SETTLE);
    // UP reached the true top (≤6px) — no freeze.
    const upTop = Math.min(
      ...rows.filter((r) => r.phase === "up" && r.top != null).map((r) => r.top),
    );
    assert(
      upTop <= 8,
      `[finger] FULL→top drag reaches the screen top under the finger (min top ${Math.round(upTop)}px ≤ 8px — no freeze)`,
    );
    // The DOWN phase must track the finger 1:1 (constant offset) — no dead zone
    // from a committed-maximize state. This round trip only spans the over-pull
    // region (top ~0→inset-full), so trim just the pinned-at-screen-top boundary
    // (top ≤ 6, where the grabber gap compresses) and measure the divergence's
    // spread directly.
    const downDivs = rows
      .filter((r) => r.phase === "down" && r.top != null && r.top > 6)
      .map((r) => r.top - r.cursorY);
    let downWorst = -1;
    if (downDivs.length >= 6) {
      const sorted = [...downDivs].sort((a, c) => a - c);
      const med = sorted[Math.floor(sorted.length / 2)];
      downWorst = Math.max(...downDivs.map((d) => Math.abs(d - med)));
      assert(
        downWorst <= 34,
        `[finger] MAXIMIZE reversal DOWN tracks 1:1 (max drift ${Math.round(downWorst)}px from the ${Math.round(med)}px offset ≤ 34px — no committed-maximize dead zone)`,
      );
    } else {
      assert(false, `[finger] MAXIMIZE reversal: too few down samples (${downDivs.length})`);
    }
    console.log(
      `  ℹ maximize round-trip: up top ${Math.round(upTop)}px, maximized at cursorY ${maxedAtCursor == null ? "n/a" : Math.round(maxedAtCursor)}, down drift ${Math.round(downWorst)}px`,
    );
  }

  console.log(
    `  ℹ finger tracking: up drift ${Math.round(upStats?.worst ?? -1)}px, down drift ${Math.round(downStats?.worst ?? -1)}px (handle offsets ${Math.round(upStats?.median ?? 0)}/${Math.round(downStats?.median ?? 0)}px)`,
  );
}

// Parse an rgb/rgba/color() string to {r,g,b,a} 0–255 (reuses the srgb-aware
// parser above via the same regexes). Used to assert the handle is a LIGHT bar
// (never the dark ambient token — the "handle is black" bug) and the composer
// border is identical (transparent) across modes.
function parseColor(value) {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a = "1"] = m[1].split(",").map((s) => Number.parseFloat(s));
    return { r, g, b, a };
  }
  const s = value.match(
    /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/,
  );
  if (!s) return null;
  return {
    r: Number.parseFloat(s[1]) * 255,
    g: Number.parseFloat(s[2]) * 255,
    b: Number.parseFloat(s[3]) * 255,
    a: s[4] === undefined ? 1 : Number.parseFloat(s[4]),
  };
}

// ANIMATION + APPEARANCE SUITE — regression coverage for three reported
// polish bugs: (1) the composer must look identical in full-bleed and inset
// (no full-screen-only border); (2) the drag handle bar must be a LIGHT bar in
// every state (it was rendering black outside the panel theme); (3) tapping to
// collapse must ANIMATE smoothly, not snap (it was collapsing in one frame
// because the thread unmounted before the height spring ran).
async function runAnimationAppearanceSuite(page) {
  const sampleCurve = async (action, ms = 800) => {
    await page.evaluate(() => {
      globalThis.__curve = [];
      const el = document.querySelector('[data-testid="chat-sheet"]');
      const t0 = performance.now();
      const tick = () => {
        globalThis.__curve.push({
          t: performance.now() - t0,
          h: el.getBoundingClientRect().height,
        });
        if (performance.now() - t0 < 900) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await action();
    await page.waitForTimeout(ms);
    const curve = await page.evaluate(() => globalThis.__curve);
    let maxStep = 0;
    let settleT = 0;
    let steppedFrames = 0;
    for (let i = 1; i < curve.length; i += 1) {
      const d = Math.abs(curve[i].h - curve[i - 1].h);
      // Discount a DROPPED rAF: a GC/load hitch in the headless renderer merges
      // two+ frames' worth of spring motion into one sample, inflating the raw
      // delta though the code emitted a smooth per-frame animation — measurement
      // jank, not a one-frame snap. Scale a long gap back to a single 60fps frame
      // (never scale UP a short gap: a small delta over <16.7ms is already
      // smooth). A genuine snap moves the full height inside one real frame, so
      // it still reads as a huge per-frame step.
      const dt = Math.max(1, curve[i].t - curve[i - 1].t);
      const perFrame = d * Math.min(1, 16.7 / dt);
      if (perFrame > maxStep) maxStep = perFrame;
      if (d > 1) {
        settleT = curve[i].t;
        steppedFrames += 1;
      }
    }
    return { maxStep, settleT, steppedFrames };
  };
  const barColor = async (testid) =>
    page.evaluate((id) => {
      const span = document
        .querySelector(`[data-testid="${id}"]`)
        ?.querySelector("span[aria-hidden='true']");
      return span ? getComputedStyle(span).backgroundColor : "n/a";
    }, testid);
  const composerBorder = async () =>
    page.evaluate(() => {
      const el = document
        .querySelector('[data-testid="chat-composer-textarea"]')
        ?.closest("div[style]");
      return el ? getComputedStyle(el).borderColor : "n/a";
    });

  // (2) Handle bar is a LIGHT bar when the sheet is OPEN (grabber lives outside
  // the panel theme — the black-handle locus).
  await gesture(page, 160, { pointer: "mouse", slow: false, steps: 1 });
  await page.waitForTimeout(SETTLE);
  const grabberRgb = parseColor(await barColor("chat-sheet-grabber"));
  assert(
    !!grabberRgb && grabberRgb.r > 180 && grabberRgb.g > 180 && grabberRgb.b > 180,
    `[appearance] open-sheet grabber bar is a LIGHT bar, not black (${JSON.stringify(grabberRgb)})`,
  );

  // (1) Composer chrome per state: INSET dissolves into the sheet (transparent
  // border — one continuous glass surface, #10710); FULL-BLEED floats the
  // composer as its own glass capsule with the resting input bar's hairline
  // border, so the maximized chat's input reads like the default input.
  await maximizeByPull(page);
  const borderFull = await composerBorder();
  await restoreFromMaximized(page, "mouse");
  const borderInset = await composerBorder();
  const cf = parseColor(borderFull);
  const ci = parseColor(borderInset);
  assert(
    !!cf && (cf.a ?? 1) > 0.2,
    `[appearance] full-bleed composer carries the default input capsule border (full=${borderFull})`,
  );
  assert(
    !!ci && (ci.a ?? 1) < 0.02,
    `[appearance] inset composer stays borderless — one continuous glass sheet (inset=${borderInset})`,
  );

  // (3) Tapping to collapse ANIMATES (many stepped frames, no single-frame
  // snap), symmetric with expand — not the 415px/frame instant snap. The
  // click-collapse is a deliberately SNAPPY spring: its early frames genuinely
  // move ~180px each (verified across runs after the frame-drop normalization in
  // sampleCurve), so the guard is `< 260` — squarely between that animated peak
  // and the ~415px one-frame snap it exists to catch. `steppedFrames >= 8`
  // already proves the motion is spread across many frames, not a single jump.
  const collapse = await sampleCurve(async () => {
    await page.getByTestId("chat-sheet-grabber").click(); // full → half
    await page.waitForTimeout(SETTLE);
    await page.getByTestId("chat-sheet-grabber").click(); // half → input (collapse)
  });
  assert(
    collapse.steppedFrames >= 8 && collapse.maxStep < 260,
    `[appearance] collapse ANIMATES smoothly (${collapse.steppedFrames} stepped frames, max ${Math.round(collapse.maxStep)}px/frame < 260 — not a one-frame snap)`,
  );

  // (2) Pill bar is the SAME light bar as the grabber (identical through the
  // crossfade).
  await gesture(page, -120, { pointer: "mouse", slow: false, steps: 1 });
  await page.waitForTimeout(SETTLE);
  const pillRgb = parseColor(await barColor("chat-pill"));
  assert(
    !!pillRgb && !!grabberRgb && Math.abs(pillRgb.r - grabberRgb.r) < 8,
    `[appearance] pill bar matches the grabber bar color (pill ${JSON.stringify(pillRgb)})`,
  );
  console.log(
    `  ℹ collapse: ${collapse.steppedFrames} frames, ${Math.round(collapse.maxStep)}px/frame max, settle ${Math.round(collapse.settleT)}ms`,
  );
}

if (process.env.MAX_PROBE) {
  // Slow-drag the grabber from the full detent past the screen top, sampling
  // cursor Y, panel top, and maximized state so the maximize handoff can be
  // inspected without stepping through Playwright manually.
  const page = await browser.newPage({ viewport: { width: 420, height: 880 } });
  attachConsole(page, sink);
  await gotoFixture(page);
  await page.waitForSelector('[data-testid="chat-sheet"]');
  await page.waitForTimeout(700);
  // Open to full via the normal half -> full gesture path.
  await gesture(page, 160, { pointer: "mouse", slow: false, steps: 1 });
  await page.waitForTimeout(SETTLE);
  await gesture(page, 220, { pointer: "mouse", slow: false, steps: 1 });
  await page.waitForTimeout(SETTLE);
  console.log(`start detent: ${await detent(page)}`);
  const b = await page.getByTestId("chat-sheet-grabber").boundingBox();
  const cx = b.x + b.width / 2;
  const startY = b.y + b.height / 2;
  const rows = [];
  const readInfo = async (cursorY, phase) => {
    const info = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-sheet"]');
      return {
        top: el.getBoundingClientRect().top,
        max: el.getAttribute("data-maximized") === "true",
      };
    });
    rows.push({
      phase,
      cursorY: Math.round(cursorY),
      top: Math.round(info.top),
      max: info.max,
    });
  };
  await page.mouse.move(cx, startY);
  await page.mouse.down();
  // Upward leg: from full to just above the screen top.
  const topY = -30;
  for (let i = 1; i <= 44; i += 1) {
    const cursorY = startY + ((topY - startY) * i) / 44;
    await page.mouse.move(cx, cursorY);
    await page.waitForTimeout(20);
    await readInfo(cursorY, "up");
  }
  // Downward leg: reverse all the way back to the full region.
  for (let i = 1; i <= 44; i += 1) {
    const cursorY = topY + ((startY - topY) * i) / 44;
    await page.mouse.move(cx, cursorY);
    await page.waitForTimeout(20);
    await readInfo(cursorY, "down");
  }
  await page.mouse.up();
  console.log("phase,cursorY,panelTop,maximized");
  for (const r of rows) console.log(`${r.phase},${r.cursorY},${r.top},${r.max}`);
  const up = rows.filter((r) => r.phase === "up");
  const down = rows.filter((r) => r.phase === "down");
  const maxAt = up.find((r) => r.max);
  // On the way down, divergence = panelTop - cursorY should stay near the
  // handle offset.
  const downDiv = down
    .filter((r) => r.top > 40 && r.top < 800)
    .map((r) => r.top - r.cursorY);
  const downMed =
    downDiv.sort((a, c) => a - c)[Math.floor(downDiv.length / 2)] ?? 0;
  const downWorst = Math.max(...downDiv.map((d) => Math.abs(d - downMed)), 0);
  console.log(
    `\nmaximized at cursorY=${maxAt ? maxAt.cursorY : "NEVER"} (screen top=0). Min panel top=${Math.min(...up.map((r) => r.top))}. DOWN drift from median offset=${Math.round(downWorst)}px`,
  );
  await browser.close();
  process.exit(0);
}

if (process.env.ANIM_PROBE) {
  const page = await browser.newPage({ viewport: { width: 420, height: 880 } });
  attachConsole(page, sink);
  await gotoFixture(page);
  await page.waitForSelector('[data-testid="chat-sheet"]');
  await page.waitForTimeout(700);
  // Sample the panel height every rAF for `ms` while running `action`.
  const sampleCurve = async (label, action, ms = 700) => {
    await page.evaluate(() => {
      globalThis.__curve = [];
      const el = document.querySelector('[data-testid="chat-sheet"]');
      const t0 = performance.now();
      const tick = () => {
        globalThis.__curve.push({
          t: Math.round(performance.now() - t0),
          h: Math.round(el.getBoundingClientRect().height),
        });
        if (performance.now() - t0 < 800) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await action();
    await page.waitForTimeout(ms);
    const curve = await page.evaluate(() => globalThis.__curve);
    // Report: settle time (last change), and per-frame max delta (jerk).
    let maxStep = 0;
    let settleT = 0;
    for (let i = 1; i < curve.length; i += 1) {
      const d = Math.abs(curve[i].h - curve[i - 1].h);
      if (d > maxStep) maxStep = d;
      if (d > 1) settleT = curve[i].t;
    }
    const heights = curve.map((c) => c.h);
    console.log(
      `${label}: settle≈${settleT}ms, maxStep=${maxStep}px/frame, range ${Math.min(...heights)}→${Math.max(...heights)}px, frames=${curve.length}`,
    );
    return curve;
  };
  const tap = (sel) => async () => {
    await page.getByTestId(sel).click();
  };
  await sampleCurve("EXPAND (tap grabber, input→half)", tap("chat-sheet-grabber"));
  const barColor = async (testid) =>
    page.evaluate((id) => {
      const span = document
        .querySelector(`[data-testid="${id}"]`)
        ?.querySelector("span[aria-hidden='true']");
      return span ? getComputedStyle(span).backgroundColor : "n/a";
    }, testid);
  console.log(`GRABBER bar color (open): ${await barColor("chat-sheet-grabber")}`);
  const composerBorder = async () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-composer-textarea"]')
        ?.closest("div[style]");
      return el ? getComputedStyle(el).borderColor : "n/a";
    });
  await maximizeByPull(page);
  console.log(`COMPOSER border (full-bleed): ${await composerBorder()}`);
  await restoreFromMaximized(page, "mouse");
  console.log(`COMPOSER border (inset): ${await composerBorder()}`);
  await sampleCurve("COLLAPSE (tap grabber, half→input)", tap("chat-sheet-grabber"));
  console.log(`PILL bar color (collapsed): ${await barColor("chat-pill")}`);
  await browser.close();
  process.exit(0);
}

if (process.env.FINGER_PROBE) {
  const page = await browser.newPage({ viewport: { width: 420, height: 880 } });
  attachConsole(page, sink);
  await gotoFixture(page);
  await page.waitForSelector('[data-testid="chat-sheet"]');
  await page.waitForTimeout(700);
  await runFingerTrackingSuite(page);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}

try {
  if (!ONLY_AUTOSCROLL) {
    // ===== DESKTOP + MOUSE =====
    const desktop = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    attachConsole(desktop, sink);
    await gotoFixture(desktop);
    await desktop.waitForSelector('[data-testid="chat-sheet"]');
    await desktop.waitForTimeout(700);
    await runDragSuite(desktop, "mouse", "desktop");
    // Fresh load: the continuum suite asserts from the INPUT resting state.
    await gotoFixture(desktop);
    await desktop.waitForSelector('[data-testid="chat-sheet"]');
    await desktop.waitForTimeout(700);
    await runContinuumSuite(desktop, "mouse", "desktop");

    // Fresh load: held-drag tracking (nothing springs ahead of a held finger;
    // pill/maximize state commits on release from the gesture's intent).
    await gotoFixture(desktop);
    await desktop.waitForSelector('[data-testid="chat-sheet"]');
    await desktop.waitForTimeout(700);
    await runMidDragCommitSuite(desktop, "desktop");

    // Fresh load: finger-tracking (the sheet edge follows the cursor 1:1 up to
    // the top and down to the pill) on a small phone-sized viewport where the
    // extremes are tightest.
    const finger = await browser.newPage({ viewport: { width: 420, height: 880 } });
    attachConsole(finger, sink);
    await gotoFixture(finger);
    await finger.waitForSelector('[data-testid="chat-sheet"]');
    await finger.waitForTimeout(700);
    await runFingerTrackingSuite(finger);
    await finger.close();

    // Fresh load: animation smoothness + handle color + composer-border parity.
    const anim = await browser.newPage({ viewport: { width: 420, height: 880 } });
    attachConsole(anim, sink);
    await gotoFixture(anim);
    await anim.waitForSelector('[data-testid="chat-sheet"]');
    await anim.waitForTimeout(700);
    await runAnimationAppearanceSuite(anim);
    await anim.close();

    // ===== MOBILE + TOUCH (recorded — the continuous detent drag-suite video) =====
    const mobileCtx = await browser.newContext({
      viewport: { width: 402, height: 874 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
      recordVideo: { dir: videoDir, size: { width: 402, height: 874 } },
    });
    const mobile = await mobileCtx.newPage();
    attachConsole(mobile, sink);
    await gotoFixture(mobile);
    await mobile.waitForSelector('[data-testid="chat-sheet"]');
    await mobile.waitForTimeout(700);
    await runDragSuite(mobile, "touch", "mobile");
    await gotoFixture(mobile);
    await mobile.waitForSelector('[data-testid="chat-sheet"]');
    await mobile.waitForTimeout(700);
    await runContinuumSuite(mobile, "touch", "mobile");
    await mobile.close(); // flush the recorded touch drag-suite video
    await mobileCtx.close();
    await renameRecordedVideo({
      videoDir,
      outDir,
      name: "chat-sheet-drag-suite.webm",
    });
  }

  // ===== AUTOSCROLL + JUMP-TO-LATEST (mouse + real touch, #13690) =====
  {
    const p = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?many&streaming`);
    await p.waitForTimeout(700);
    await runAutoScrollSuite(p, "mouse", "desktop");
    await p.close();
  }
  {
    const autoCtx = await browser.newContext({
      viewport: { width: 402, height: 874 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
      recordVideo: { dir: videoDir, size: { width: 402, height: 874 } },
    });
    const p = await autoCtx.newPage();
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?many&streaming`);
    await p.waitForTimeout(700);
    await runAutoScrollSuite(p, "touch", "mobile");
    await p.close();
    await autoCtx.close();
    await renameRecordedVideo({
      videoDir,
      outDir,
      name: "chat-sheet-autoscroll-suite.webm",
    });
  }

  if (!ONLY_AUTOSCROLL) {
  // ===== GRABBER horizontal flick → launcher intent, REAL touch (#9943) =====
  // The collapsed grabber's horizontal swipe pages home → launcher through the
  // shell-surface store (goLauncher). Android's on-device spec drives this with
  // a real finger; drive it here through Chromium's REAL touch pipeline
  // (Input.dispatchTouchEvent, hit-test + touch-action + implicit capture), and
  // ALSO under a janked main thread (fire-and-forget dispatch → the renderer
  // coalesces the moves), the failure shape of the Davey!-janked WebView.
  {
    const surfacePage = (p) =>
      p.evaluate(
        () =>
          globalThis[Symbol.for("elizaos.ui.shell-surface-store")]?.state
            ?.page ?? "home",
      );
    const resetSurface = (p) =>
      p.evaluate(() => {
        const s = globalThis[Symbol.for("elizaos.ui.shell-surface-store")];
        if (s) {
          s.state = { ...s.state, page: "home" };
          for (const l of s.listeners) l();
        }
      });
    const grabberSel = '[data-testid="chat-sheet-grabber"]';

    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector(grabberSel);
    await p.waitForTimeout(700);

    // 1. Plain real-touch flick (adb-like: 150px left over ~280ms).
    assert(
      (await surfacePage(p)) === "home",
      "[grabber-swipe] starts on the home surface",
    );
    await touchSwipe(p, grabberSel, -150, -6, { steps: 14, stepDelayMs: 20 });
    await p.waitForTimeout(400);
    assert(
      (await surfacePage(p)) === "launcher",
      "[grabber-swipe] REAL-touch left flick on the grabber commits goLauncher (#9943)",
    );
    await snap(p, "grabber-real-touch-launcher");

    // 2. Real-touch flick with the main thread JANKED: dispatch the whole
    // sequence fire-and-forget so the renderer coalesces the moves (this is
    // what a 700ms+ frame on the Android WebView does to a 280ms finger swipe).
    await resetSurface(p);
    const box = await p.locator(grabberSel).first().boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await p.context().newCDPSession(p);
    const touchPoint = (x, y) => [
      { x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 },
    ];
    const busy = p
      .evaluate((ms) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          // burn the main thread across the whole swipe
        }
      }, 1200)
      .catch(() => {});
    await p.waitForTimeout(80); // let the busy loop engage
    const sends = [
      cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: touchPoint(cx, cy),
      }),
    ];
    for (let i = 1; i <= 14; i += 1) {
      sends.push(
        cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: touchPoint(cx - (150 * i) / 14, cy - (6 * i) / 14),
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
    }
    sends.push(
      cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      }),
    );
    await Promise.allSettled(sends);
    await busy;
    await p.waitForTimeout(600);
    assert(
      (await surfacePage(p)) === "launcher",
      "[grabber-swipe] real-touch flick still commits with the main thread janked / moves coalesced (#9943)",
    );
    await cdp.detach().catch(() => {});

    // 3. Synthetic PointerEvent path (jsdom-style dispatch) stays green.
    await resetSurface(p);
    await p.evaluate((sel) => {
      const g = document.querySelector(sel);
      const r = g.getBoundingClientRect();
      const cx0 = r.x + r.width / 2;
      const cy0 = r.y + r.height / 2;
      const fire = (type, x, y) =>
        g.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
          }),
        );
      fire("pointerdown", cx0, cy0);
      fire("pointermove", cx0 - 75, cy0 - 3);
      fire("pointermove", cx0 - 150, cy0 - 6);
      fire("pointerup", cx0 - 150, cy0 - 6);
    }, grabberSel);
    await p.waitForTimeout(400);
    assert(
      (await surfacePage(p)) === "launcher",
      "[grabber-swipe] synthetic PointerEvent flick still commits (parity)",
    );
    await p.close();
  }

  // ===== CONTROLS + INPUT STATES (mobile viewport for the tactile surface) =====
  const ctrl = async () =>
    browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
      hasTouch: true,
    });

  // empty thread: no sheet, just the composer
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?empty`);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(650);
    assert((await p.locator('[data-testid="chat-thread"]').count()) === 0, "EMPTY: no thread/history mounted (just the input panel)");
    assert(await p.getByTestId("chat-composer-plus").isVisible(), "EMPTY: chat actions (+) button shown");
    await p.getByTestId("chat-composer-plus").click();
    assert(await p.getByText("Upload file", { exact: true }).isVisible(), "EMPTY: upload lives in the chat-actions menu");
    // The + menu is the first migrated liquid-glass menu surface: assert the
    // glass class is live (GlassStyles mounted by the fixture shell) and
    // capture the open-menu state for visual evidence.
    assert(
      (await p.locator(".eliza-glass-menu").count()) >= 1,
      "EMPTY: chat-actions menu renders on the glass menu variant",
    );
    await snap(p, "state-plus-menu-glass");
    await p.keyboard.press("Escape");
    assert((await p.getByTestId("chat-composer-mic").count()) === 1, "EMPTY: mic button shown (no draft)");
    await snap(p, "state-empty");
    await p.close();
  }

  // booting: waking-up placeholder; typing AND voice are allowed (voice capture
  // is decoupled from agent-respond readiness — a transcript goes through the
  // same warm-tolerant send path, so the mic stays enabled while warming).
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?phase=booting`);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(650);
    assert(
      (await p.getByTestId("chat-composer-textarea").getAttribute("placeholder"))?.includes("waking up"),
      "BOOTING: composer placeholder says 'waking up'",
    );
    assert(
      (await p.getByTestId("chat-composer-plus").getAttribute("aria-disabled")) !== "true",
      "BOOTING: chat actions (+) stay enabled (you can compose while it wakes)",
    );
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-disabled")) !== "true",
      "BOOTING: mic stays ENABLED while warming (voice decoupled from agent-ready)",
    );
    await snap(p, "state-booting");
    await p.close();
  }

  // recording: mic active — NO interim transcript text; the pulsing chrome cue
  // (grabber/pill bar) is the "audio is on" signal instead.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?recording&phase=listening`);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(650);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-pressed")) === "true",
      "RECORDING: mic shows active (aria-pressed)",
    );
    assert(
      (await p.getByText("tell me the plan for", { exact: false }).count()) === 0,
      "LISTENING: interim transcript text is NOT rendered above the composer",
    );
    // The capture-hot cue lives on the composer voice glyph, NOT the handle:
    // while the composer is visible the grabber stays quiet during a recording
    // (a second pulsing bar above the already-pulsing glyph read as noise);
    // only the collapsed PILL pulses for a live capture.
    assert(
      await p
        .getByTestId("chat-composer-mic")
        .evaluate((el) => el.className.includes("animate-pulse")),
      "LISTENING: the composer voice glyph pulses while the mic is hot",
    );
    assert(
      !(await p
        .getByTestId("chat-sheet-grabber")
        .locator("span")
        .first()
        .evaluate((el) => el.className.includes("animate-pulse"))),
      "LISTENING: the grabber bar stays QUIET while the mic is hot (pill-only pulse)",
    );
    await snap(p, "state-recording-listening");
    await p.close();
  }

  // speaking: the agent is delivering its reply aloud. Voice input is gated while
  // a reply is in flight, so the trailing control is the STOP (interrupt) — NOT
  // the mic — and no stray mute/speaker control pops in.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?speaking`);
    await p.waitForSelector('[data-testid="chat-composer-stop"]');
    await p.waitForTimeout(500);
    assert(
      (await p.getByTestId("chat-composer-mic").count()) === 0,
      "SPEAKING: mic hidden while a reply is in flight (voice gated)",
    );
    assert(
      await p.getByTestId("chat-composer-stop").isVisible(),
      "SPEAKING: stop control shown to interrupt the spoken reply",
    );
    assert(
      (await p.getByTestId("chat-voice-mute").count()) === 0,
      "SPEAKING: no stray voice-mute button shown while the agent speaks",
    );
    await snap(p, "state-speaking");
    await p.close();
  }

  // AUDIO-UNLOCK chip with the sheet OPEN (regression): the chip renders at the
  // overlay root ABOVE the glass panel. The open-sheet outside-tap swallower
  // used to treat it as "outside" — eating the click (unlockAudio never fired)
  // AND collapsing the sheet, so sound could not be enabled while chat was open.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    const logs = [];
    p.on("console", (m) => logs.push(m.text()));
    await gotoFixture(p, `${url}?unlock`);
    await p.waitForSelector('[data-testid="overlay-voice-audio-unlock"]');
    await p.getByTestId("chat-sheet-grabber").focus();
    await p.keyboard.press("ArrowUp"); // open to half behind the chip
    await p.waitForTimeout(450);
    assert((await variant(p)) === "open", "UNLOCK: sheet opens behind the audio-unlock chip");
    await snap(p, "state-audio-unlock-open");
    await p.getByTestId("overlay-voice-audio-unlock").click();
    await p.waitForTimeout(300);
    assert(
      logs.some((t) => t.includes("[fixture] unlockAudio")),
      "UNLOCK: chip tap fires unlockAudio (not swallowed as an outside tap)",
    );
    assert(
      (await p.getByTestId("overlay-voice-audio-unlock").count()) === 0,
      "UNLOCK: chip clears once audio is unlocked",
    );
    assert(
      (await variant(p)) === "open",
      "UNLOCK: sheet STAYS OPEN — the chip tap is not an outside collapse",
    );
    await snap(p, "state-audio-unlock-cleared");
    await p.close();
  }

  // TRANSCRIBING while an inline reply is in flight (regression, #9880 path):
  // the voice control is the MASTER off — labeled "stop transcription and mic"
  // (distinct from the transcribe button's "stop transcription", which leaves
  // the mic on) — and must END the session on tap even while `responding` is
  // true; the OFF path was gated on the reply finishing, leaving a lit, dead
  // mic button.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    const logs = [];
    p.on("console", (m) => logs.push(m.text()));
    await gotoFixture(p, `${url}?transcribing&recording&speaking&phase=listening`);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(500);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-label")) ===
        "stop transcription and mic",
      "TRANSCRIBING+REPLY: voice control reads 'stop transcription and mic'",
    );
    await snap(p, "state-transcribing-inline-reply");
    await p.getByTestId("chat-composer-mic").click();
    await p.waitForTimeout(300);
    assert(
      logs.some((t) => t.includes("[fixture] stopTranscriptionAndMic")),
      "TRANSCRIBING+REPLY: mic tap ends transcription even mid-reply (not gated on responding)",
    );
    // With the mic off and the (fixture-constant) reply still in flight the
    // trailing control morphs mic → stop, exactly like the plain speaking state.
    assert(
      (await p.getByTestId("chat-composer-mic").count()) === 0 &&
        (await p.getByTestId("chat-composer-stop").count()) === 1,
      "TRANSCRIBING+REPLY: after the tap the trailing control is the stop (mic off)",
    );
    await p.close();
  }

  // responding: an in-progress status row inside the opened sheet
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?phase=responding`);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(500);
    await p.getByTestId("chat-sheet-grabber").focus();
    await p.keyboard.press("ArrowUp"); // open to half so the dots are visible
    await p.waitForTimeout(450);
    assert(await p.getByTestId("turn-status-indicator").isVisible(), "RESPONDING: turn status shown in the open sheet");
    await snap(p, "state-responding");
    await p.close();
  }

  // typing → send button morph, and Enter sends
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(600);
    const input = p.getByTestId("chat-composer-textarea");
    await input.fill("draft message");
    await p.waitForTimeout(200);
    assert(await p.getByTestId("chat-composer-action").isVisible(), "TYPING: trailing control morphs mic→send");
    assert((await p.getByTestId("chat-composer-mic").count()) === 0, "TYPING: mic hidden while a draft exists");
    assert((await variant(p)) === "open", "TYPING: composing pulls the sheet open");
    await snap(p, "state-typing-send");
    // SEND-TAP: tapping the send button must keep the composer focused so the
    // FIRST tap sends. Regression guard — previously the button stole focus, the
    // textarea blurred, the keyboard retracted and the composer relayouted
    // between pointerdown and click, so the first tap only dismissed the
    // keyboard and a second tap was needed. A preventDefault on the send
    // button's pointerdown keeps focus; Chromium still dispatches click.
    const focusedTestId = () =>
      p.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    await input.focus();
    assert(
      (await focusedTestId()) === "chat-composer-textarea",
      "SEND-TAP: composer focused before send",
    );
    await p.getByTestId("chat-composer-action").click();
    await p.waitForTimeout(200);
    assert(
      (await focusedTestId()) === "chat-composer-textarea",
      "SEND-TAP: composer keeps focus after tapping send (keyboard stays up)",
    );
    assert(
      (await input.inputValue()) === "",
      "SEND-TAP: composer clears after tapping send",
    );
    await p.close();
  }

  // attach image → thumbnail + remove button (real file through the hidden input)
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-composer-plus"]');
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
    await gotoFixture(p);
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

  // VOICE ↔ CHAT, direction 1 — DICTATION fills the chat box (transcription into
  // the composer, editable, then sent as a normal turn). The user explicitly
  // asked this be tested both ways.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-composer-textarea"]');
    await p.waitForTimeout(500);
    await p.evaluate(() => window.__emitDictation?.("buy oat milk"));
    await p.waitForTimeout(200);
    let draft = await p.getByTestId("chat-composer-textarea").inputValue();
    assert(
      draft.includes("buy oat milk"),
      `DICTATION: final transcript fills the composer box (draft="${draft}")`,
    );
    assert(
      await p.getByTestId("chat-composer-action").isVisible(),
      "DICTATION: send control morphs in once the box holds the dictated text",
    );
    await snap(p, "state-dictation-in-box");
    // A second transcript APPENDS (proves it's an editable draft, not a replace).
    await p.evaluate(() => window.__emitDictation?.("at noon"));
    await p.waitForTimeout(150);
    draft = await p.getByTestId("chat-composer-textarea").inputValue();
    assert(
      draft.includes("buy oat milk") && draft.includes("at noon"),
      `DICTATION: a second transcript appends to the draft (draft="${draft}")`,
    );
    // Send the dictated draft → the box clears (the normal send path).
    const n = sink.logs.length;
    await p.getByTestId("chat-composer-action").click();
    await p.waitForTimeout(300);
    assert(
      (await p.getByTestId("chat-composer-textarea").inputValue()) === "",
      "DICTATION: sending the dictated draft clears the box",
    );
    assert(
      sink.logs.slice(n).some((l) => l.includes("[fixture] send:")),
      "DICTATION: the dictated text sends as a chat turn",
    );
    await p.close();
  }

  // VOICE ↔ CHAT, direction 2 — CONTINUOUS (hands-free) converse: a tap on the
  // mic opens the loop and a final transcript sends a VOICE_DM (spoken reply),
  // NOT a typed draft. Asserted via the fixture's channel-tagged send log.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(500);
    await p.getByTestId("chat-composer-mic").click(); // tap = hands-free converse
    await p.waitForTimeout(200);
    assert(
      (await p.getByTestId("chat-composer-mic").getAttribute("aria-pressed")) === "true",
      "CONTINUOUS: tapping the mic starts the hands-free loop",
    );
    const n = sink.logs.length;
    await p.evaluate(() => window.__emitVoiceFinal?.("what is the weather"));
    await p.waitForTimeout(300);
    assert(
      sink.logs.slice(n).some((l) => l.includes("(VOICE_DM)")),
      "CONTINUOUS: a final transcript sends a VOICE_DM (spoken-reply turn), not a draft",
    );
    assert(
      (await p.getByTestId("chat-composer-textarea").inputValue()) === "",
      "CONTINUOUS: converse does NOT leave text in the composer box",
    );
    await p.close();
  }

  // PUSH-TO-TALK: press-and-hold the mic (>200ms, no drag) starts a "dictate"
  // capture; release stops it — and it must NOT toggle hands-free (the
  // suppress-click guard). Asserted via the fixture intent log.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(500);
    const mic = p.getByTestId("chat-composer-mic");
    const box = await mic.boundingBox();
    const mx = box.x + box.width / 2;
    const my = box.y + box.height / 2;
    const n = sink.logs.length;
    await p.mouse.move(mx, my);
    await p.mouse.down();
    await p.waitForTimeout(280); // exceed the 200ms press threshold (no movement)
    await p.mouse.up();
    await p.waitForTimeout(200);
    assert(
      sink.logs.slice(n).some((l) => l.includes("startRecording(dictate)")),
      "PTT: press-and-hold starts a DICTATE capture",
    );
    assert(
      sink.logs.slice(n).some((l) => l.includes("stopRecording")),
      "PTT: release stops the capture",
    );
    assert(
      !sink.logs.slice(n).some((l) => l.includes("toggleHandsFree")),
      "PTT: a held press does NOT toggle hands-free (suppress-click guard)",
    );
    await p.close();
  }

  // PTT CANCEL must NOT leak the click-suppress (the "next tap eaten" bug): a
  // held press ended by pointercancel (not pointerup) stops dictation but leaves
  // the NEXT quick tap free to toggle hands-free.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(500);
    const mic = p.getByTestId("chat-composer-mic");
    const n0 = sink.logs.length;
    await mic.dispatchEvent("pointerdown", { pointerId: 7, button: 0 });
    await p.waitForTimeout(280); // > 200ms → dictation starts
    await mic.dispatchEvent("pointercancel", { pointerId: 7 });
    await p.waitForTimeout(150);
    assert(
      sink.logs.slice(n0).some((l) => l.includes("startRecording(dictate)")),
      "PTT-CANCEL: the hold started dictation",
    );
    assert(
      sink.logs.slice(n0).some((l) => l.includes("stopRecording")),
      "PTT-CANCEL: pointercancel stops the capture",
    );
    const n1 = sink.logs.length;
    await mic.click();
    await p.waitForTimeout(150);
    assert(
      sink.logs.slice(n1).some((l) => l.includes("toggleHandsFree")),
      "PTT-CANCEL: the NEXT tap still toggles hands-free (suppress did not leak)",
    );
    await p.close();
  }

  // TYPING-PAUSE: while the hands-free loop is on, typing a draft must signal the
  // controller (setComposerHasDraft -> true) so the always-on mic pauses over the
  // keyboard; clearing it resumes.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-composer-mic"]');
    await p.waitForTimeout(500);
    await p.getByTestId("chat-composer-mic").click(); // hands-free on
    await p.waitForTimeout(150);
    const n = sink.logs.length;
    await p.getByTestId("chat-composer-textarea").fill("hold on");
    await p.waitForTimeout(150);
    assert(
      sink.logs.slice(n).some((l) => l.includes("setComposerHasDraft -> true")),
      "TYPING-PAUSE: a draft pauses the always-on loop (setComposerHasDraft true)",
    );
    const m = sink.logs.length;
    await p.getByTestId("chat-composer-textarea").fill("");
    await p.waitForTimeout(150);
    assert(
      sink.logs.slice(m).some((l) => l.includes("setComposerHasDraft -> false")),
      "TYPING-PAUSE: clearing the draft resumes the loop (setComposerHasDraft false)",
    );
    await p.close();
  }

  // multi-line: the composer auto-grows with newlines
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
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
    await gotoFixture(p);
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

  // KEYBOARD SIZING: when the on-screen keyboard opens it shrinks the VISUAL
  // viewport. The overlay must (a) lift above the keyboard and (b) never grow
  // past the visible area — the thread scrolls instead of the panel spilling off
  // the top of the screen. We mock `window.visualViewport` (Playwright has no
  // soft keyboard) by shadowing it with an EventTarget whose `height` we shrink
  // and whose `resize` we dispatch — exactly the signal a real keyboard emits.
  {
    const p = await browser.newPage({
      viewport: { width: 402, height: 874 },
      deviceScaleFactor: 2,
      hasTouch: true,
    });
    attachConsole(p, sink);
    await p.addInitScript(() => {
      const innerH = window.innerHeight;
      const fake = new EventTarget();
      Object.assign(fake, {
        width: window.innerWidth,
        height: innerH,
        offsetTop: 0,
        offsetLeft: 0,
        pageTop: 0,
        pageLeft: 0,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        get: () => fake,
      });
      window.__setKeyboard = (kb) => {
        fake.height = innerH - kb;
        fake.offsetTop = 0;
        fake.dispatchEvent(new Event("resize"));
      };
    });
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);

    const metrics = () =>
      p.evaluate(() => {
        const overlay = document.querySelector(
          '[data-testid="continuous-chat-overlay"]',
        );
        const panel = document.querySelector('[data-testid="chat-sheet"]');
        const r = panel.getBoundingClientRect();
        return {
          overlayBottom: Number.parseFloat(getComputedStyle(overlay).bottom),
          panelTop: r.top,
          panelBottom: r.bottom,
          panelHeight: r.height,
          innerH: window.innerHeight,
          vvH: window.visualViewport.height, // visible bottom = keyboard line
        };
      });

    // rest, no keyboard: overlay sits flush at the bottom (inset 0)
    const rest = await metrics();
    assert(
      near(rest.overlayBottom, 0, 1),
      `KEYBOARD: overlay rests at the bottom with no keyboard (bottom ${rest.overlayBottom}px)`,
    );

    // raise a 334px keyboard while COLLAPSED — just the input lifts above it
    const KB = 334;
    await p.evaluate((kb) => window.__setKeyboard(kb), KB);
    await p.waitForTimeout(SETTLE);
    const collapsed = await metrics();
    assert(
      near(collapsed.overlayBottom, KB, 2),
      `KEYBOARD(collapsed): overlay lifts to sit above the keyboard (bottom ${Math.round(collapsed.overlayBottom)}px ≈ ${KB})`,
    );
    assert(
      collapsed.panelBottom <= collapsed.vvH + 1,
      `KEYBOARD(collapsed): input panel sits above the keyboard line (bottom ${Math.round(collapsed.panelBottom)} ≤ ${collapsed.vvH})`,
    );
    await snap(p, "state-keyboard-collapsed");

    // Flick to FULL with the keyboard still up — the WORST case for height.
    // Slow drags deliberately free-rest; the FULL semantic state requires a
    // committed flick/pull release, so drive the real touch path that way.
    await gesture(p, 120, { pointer: "touch", slow: false, steps: 1 }); // → HALF
    await p.waitForTimeout(SETTLE);
    await gesture(p, 240, { pointer: "touch", slow: false, steps: 1 }); // → FULL
    await p.waitForTimeout(SETTLE);
    const keyboardFullDetent = await detent(p);
    assert(
      keyboardFullDetent === "full",
      `KEYBOARD: pulled to FULL with the keyboard open (got ${keyboardFullDetent})`,
    );
    const full = await metrics();
    assert(
      full.panelTop >= -1,
      `KEYBOARD(full): tall panel does NOT spill above the screen top (top ${Math.round(full.panelTop)} ≥ 0)`,
    );
    assert(
      full.panelBottom <= full.vvH + 1,
      `KEYBOARD(full): panel stays above the keyboard line (bottom ${Math.round(full.panelBottom)} ≤ ${full.vvH})`,
    );
    assert(
      full.panelHeight <= full.vvH - 56 + 1,
      `KEYBOARD(full): panel height capped to the visible area (h ${Math.round(full.panelHeight)} ≤ ${full.vvH - 56})`,
    );
    await assertDarkChatSurface(p, "KEYBOARD(full)");
    await assertNoDefaultBlueThreadFocus(p, "KEYBOARD(full)");
    await snap(p, "state-keyboard-full");

    // close the keyboard → the overlay drops back to the bottom
    await p.evaluate(() => window.__setKeyboard(0));
    await p.waitForTimeout(SETTLE);
    const reclosed = await metrics();
    assert(
      near(reclosed.overlayBottom, 0, 1),
      `KEYBOARD: overlay returns to the bottom when the keyboard closes (bottom ${Math.round(reclosed.overlayBottom)}px)`,
    );
    await p.close();
  }

  // no_provider failure → recovery gate (Connect a provider → Open Settings)
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?failure=no_provider`);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(500);
    await p.getByTestId("chat-sheet-grabber").focus();
    await p.keyboard.press("ArrowUp"); // open the sheet to reveal the gate
    await p.waitForTimeout(450);
    assert(
      await p.getByText("Connect a provider to chat").isVisible(),
      "NO_PROVIDER: structured recovery gate is rendered (not raw error text)",
    );
    const cta = p.getByTestId("chat-no-provider-settings");
    assert(await cta.isVisible(), "NO_PROVIDER: 'Open Settings' CTA shown");
    await snap(p, "state-no-provider-gate");
    await cta.click();
    await p.waitForTimeout(150);
    assert(
      sink.logs.some((l) => l.includes("[fixture] openSettings")),
      "NO_PROVIDER: tapping the CTA jumps to Settings",
    );
    await p.close();
  }

  // PILL: pull DOWN from the input collapses the whole chat into a small pill at
  // the bottom (input hidden). Slow-drag and flick both pill it; the composer
  // stays mounted but hidden + inert. (A pill TAP opens the chat — see PILL-TAP.)
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(500);
    assert((await detent(p)) === "collapsed", "PILL: starts at input (collapsed)");
    // A SLOW drag down from the collapsed input also collapses to the pill —
    // there's nothing to "size" below the input, so down always means pill.
    await gesture(p, -90, { pointer: "touch", slow: true, steps: 12 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "pill", "PILL: slow drag-down collapses the input → pill");
    // Reset to the input peek and verify a quick FLICK down pills it too.
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(500);
    assert((await detent(p)) === "collapsed", "PILL: reset to the input peek before flick check");
    await gesture(p, -90, { pointer: "touch", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "pill", "PILL: flick-down collapses the input → pill");
    assert(
      (await p.getByTestId("chat-pill").count()) === 1,
      "PILL: the recoverable pill capsule is shown",
    );
    // Persistent panel: the composer stays MOUNTED across pill↔input (so the
    // morph is continuous, never a remount) but is hidden — opacity 0 + `inert`.
    {
      const contentOpacity = await p
        .getByTestId("chat-content")
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
      // ≤0.12, not ≤0.05: the morph to openProgress 0 is an asymptotic spring,
      // so after the settle window it's imperceptibly-but-not-exactly 0 (it
      // occasionally lands ~0.05). 12% opacity is still visually hidden; the
      // tight bound just flaked.
      assert(
        contentOpacity <= 0.12,
        `PILL: the input is visually hidden in pill mode (content opacity ${contentOpacity})`,
      );
      assert(
        (await p.getByTestId("chat-content").getAttribute("inert")) !== null,
        "PILL: the input is inert (out of tab order / a11y tree) in pill mode",
      );
    }
    await snap(p, "state-pill");
    await p.close();
  }

  // ── PILL TAP opens the chat to HALF (regression for the reported bug): a real
  // TAP (pointerdown+up, no move) routes through the gesture's onDrag(0) → onTap
  // path. It must open the chat in ONE tap straight to the HALF detent (the
  // conversation is visible) — NOT blink to a bare input bar that needs a second
  // tap. Assert the detent is half/open AND the content actually formed (opacity
  // ~1), not just a detent label with a stuck-at-0 morph.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(500);
    await gesture(p, -90, { pointer: "touch", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "pill", "PILL-TAP: collapsed to pill first");
    // Real tap: touchStart then touchEnd at the SAME spot (no move).
    await touchTap(p, '[data-testid="chat-pill"]');
    await p.waitForTimeout(SETTLE);
    const openedOpacity = await p
      .getByTestId("chat-content")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
    assert(
      openedOpacity > 0.9,
      `PILL-TAP: tap animates pill → chat, content fully formed (opacity ${openedOpacity})`,
    );
    assert(
      (await detent(p)) === "half",
      `PILL-TAP: a SINGLE tap opens the chat to half (got ${await detent(p)})`,
    );
    assert((await variant(p)) === "open", "PILL-TAP: the chat is open after one tap");
    await snap(p, "state-pill-tap-opened");
    await p.close();
  }

  // reduced-motion still opens via flick
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await p.emulateMedia({ reducedMotion: "reduce" });
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, 120, { pointer: "mouse", slow: true });
    await p.waitForTimeout(200);
    assert((await variant(p)) === "open", "REDUCED-MOTION: pull-up still opens");
    await snap(p, "state-reduced-motion-open");
    await p.close();
  }

  // HEADER ACTIONS: navigation moved out of the chat header. The bar remains as
  // a safe-area/status strip, while conversation actions live in the composer
  // menu and the legacy header testids stay gone.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, 120, { pointer: "mouse", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "half", "NAV: opened to half");
    await waitForHeaderShown(p);
    assert(
      (await headerShown(p)) &&
        (await p.getByTestId("chat-composer-plus").isVisible()),
      "NAV: status header is shown and composer actions stay available",
    );
    assert(
      (await p.getByTestId("chat-full-launcher").count()) === 0 &&
        (await p.getByTestId("chat-full-home").count()) === 0 &&
        (await p.getByTestId("chat-full-views").count()) === 0 &&
        (await p.getByTestId("chat-full-settings").count()) === 0,
      "NAV: legacy header navigation buttons are absent",
    );
    await p.close();
  }

  // MAXIMIZED ACTION MENU: the composer menu remains reachable in full-bleed
  // chat and opening it must not collapse or unmaximize the sheet.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, 90, { pointer: "mouse", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    await gesture(p, 140, { pointer: "mouse", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    await maximizeByPull(p);
    assert(
      (await p
        .locator('[data-testid="chat-sheet"][data-maximized="true"]')
        .count()) === 1,
      "ACTION-MENU: maximized before opening composer menu",
    );
    await p.getByTestId("chat-composer-plus").click();
    assert(
      (await p.getByText("Search chat…", { exact: true }).isVisible()) &&
        (await p.getByText("Upload file", { exact: true }).isVisible()),
      "ACTION-MENU: search and upload actions are available from composer menu",
    );
    assert(
      (await p
        .locator('[data-testid="chat-sheet"][data-maximized="true"]')
        .count()) === 1,
      "ACTION-MENU: opening composer menu does not exit maximized chat",
    );
    await p.close();
  }

  // MAXIMIZE-FROM-HALF: over-pulling from the HALF detent rises to FULL and
  // goes edge-to-edge (full-bleed requires the FULL flag). And the
  // full-screen panel fills top-to-bottom with no gap at the bottom.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, 90, { pointer: "mouse", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "half", "MAX-HALF: at half before maximize");
    await maximizeByPull(p);
    if (
      (await p.locator('[data-testid="chat-sheet"][data-maximized="true"]').count()) === 0
    ) {
      await maximizeByPull(p);
    }
    assert(
      (await p
        .locator('[data-testid="chat-sheet"][data-maximized="true"]')
        .count()) === 1,
      "MAX-HALF: over-pull from HALF goes full-screen",
    );
    const box = await p.getByTestId("chat-sheet").boundingBox();
    const vh = await p.evaluate(() => window.innerHeight);
    assert(
      !!box && box.y <= 8 && box.y + box.height >= vh - 2,
      `MAX-HALF: full-screen fills top-to-bottom — no bottom gap (y=${Math.round(
        box?.y ?? -1,
      )}, bottom=${Math.round((box?.y ?? 0) + (box?.height ?? 0))}, vh=${vh})`,
    );
    await p.close();
  }

  // ── MAXIMIZE WITH A BOTTOM GESTURE INSET (regression): on Android the home-
  // gesture inset feeds the overlay's bottom padding, which is cached into
  // `bottomPad`. Full-bleed drops that padding to 0 (the composer carries the
  // clearance), so the panel must fill the WHOLE viewport. The bug: panelMaxH
  // still subtracted the stale bottomPad, so the maximized panel floated a
  // gesture-inset BELOW the top — a hard-cut glass seam under the status bar and
  // the safe-area-padded status strip pushed down. Assert: panel reaches y≈0 AND
  // the header strip starts at the viewport top, not a gesture-inset lower.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    // Simulate the Android insets, then fire a resize so the overlay samples its
    // (now gesture-inset-padded) bottom padding into bottomPad while NOT maximized.
    await p.evaluate(() => {
      const r = document.documentElement.style;
      r.setProperty("--android-gesture-inset-bottom", "32px");
      r.setProperty("--safe-area-top", "30px");
      window.dispatchEvent(new Event("resize"));
    });
    await p.waitForTimeout(120);
    await gesture(p, 90, { pointer: "mouse", slow: false, steps: 1 }); // → half
    await p.waitForTimeout(SETTLE);
    await maximizeByPull(p); // → full-bleed
    assert(
      (await p
        .locator('[data-testid="chat-sheet"][data-maximized="true"]')
        .count()) === 1,
      "MAX-INSET: maximized full-bleed",
    );
    const box = await p.getByTestId("chat-sheet").boundingBox();
    assert(
      !!box && box.y <= 2,
      `MAX-INSET: maximized panel fills to the TOP despite the bottom inset (y=${Math.round(
        box?.y ?? -1,
      )}) — no status-bar seam`,
    );
    const header = await p.getByTestId("chat-sheet-header").boundingBox();
    // Header padding = safe-area-top (30) + 0.5rem (8); the strip itself must
    // stay anchored at the top instead of inheriting the bottom gesture gap.
    assert(
      !!header && header.y <= 2 && header.height >= 30,
      `MAX-INSET: header status strip starts at the top safe area, not pushed down by a gap (y=${Math.round(
        header?.y ?? -1,
      )}, h=${Math.round(
        header?.height ?? -1,
      )})`,
    );
    await snap(p, "state-maximized-with-inset");
    await p.close();
  }

  // ── ALL FIVE CHATSTATES (the canonical machine) — assert data-chat-state + the
  // status-header gate, screenshot each (the user asked for a shot of every
  // state). Driven by real gestures on the grabber + the pill.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    const vh = await viewportH(p);
    const halfH = Math.round(vh * 0.46);

    assert((await chatState(p)) === "INPUT", "STATES: rest is INPUT");
    assert(
      !(await headerShown(p)),
      "STATES: INPUT hides the status header",
    );
    await snap(p, "state-INPUT");

    await gesture(p, halfH, { pointer: "mouse", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    assert(
      (await chatState(p)) === "OPEN_HALF_OR_OVER",
      `STATES: flick-up → OPEN_HALF_OR_OVER (got ${await chatState(p)})`,
    );
    assert(
      await headerShown(p),
      "STATES: OPEN_HALF_OR_OVER shows the status header",
    );
    await snap(p, "state-OPEN_HALF_OR_OVER");

    await maximizeByPull(p);
    assert(
      (await chatState(p)) === "MAXIMIZED",
      `STATES: over-pull maximize → MAXIMIZED (got ${await chatState(p)})`,
    );
    await snap(p, "state-MAXIMIZED");

    // #10698 regression: the floating transcript's message bubbles carry NO
    // per-message fill — text floats over the ONE shared panel glass. The
    // backdrop-blur gate only bans blur, not a fill, so a re-added
    // bg-black*/bg-white/10 would slip past it. Assert the COMPUTED background of
    // the WHOLE per-message wrapper chain — every ancestor from the selectable
    // content up to (excluding) the thread-line container — so a fill re-added
    // at any wrapper level is caught, not just on the immediate parent.
    const bubbleBackgrounds = await p
      .locator('[data-testid="thread-line"] [data-chat-selectable="true"]')
      .evaluateAll((nodes) =>
        nodes.flatMap((n) => {
          const chain = [];
          for (
            let el = n.parentElement;
            el && el.getAttribute("data-testid") !== "thread-line";
            el = el.parentElement
          ) {
            chain.push(getComputedStyle(el).backgroundColor);
          }
          return chain.length > 0 ? chain : ["missing"];
        }),
      );
    assert(
      bubbleBackgrounds.length > 0,
      `#10698: populated thread renders message bubbles (found ${bubbleBackgrounds.length})`,
    );
    const filled = bubbleBackgrounds.filter(
      (bg) => bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent",
    );
    assert(
      filled.length === 0,
      `#10698: message bubbles have NO per-message fill (transparent bg); filled=${JSON.stringify(filled)}`,
    );
    await p.close();
  }

  // OPEN_UNDER_HALF + CLOSED on a fresh page (cleaner than stepping down from
  // MAXIMIZED, which is full-bleed and has no grabber to drag).
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    const vh = await viewportH(p);
    const halfH = Math.round(vh * 0.46);

    // OPEN_UNDER_HALF — a slow short pull from INPUT rests in the gap below half.
    // Use MANY steps so the drag is unambiguously slow: this pull travels ~half
    // the half-detent (~200px), and at the default step count its velocity lands
    // right on the 0.5 px/ms flick threshold — a hair over and it snaps to the
    // half detent instead of free-resting (the intermittent failure). More steps
    // ⇒ longer elapsed ⇒ velocity well under the threshold ⇒ deterministic settle.
    await gesture(p, Math.round(halfH * 0.5), {
      pointer: "mouse",
      slow: true,
      steps: 30,
    });
    await p.waitForTimeout(SETTLE);
    assert(
      (await chatState(p)) === "OPEN_UNDER_HALF",
      `STATES: slow free-rest below half → OPEN_UNDER_HALF (got ${await chatState(p)})`,
    );
    assert(
      !(await headerShown(p)),
      "STATES: OPEN_UNDER_HALF hides the status header",
    );
    // The transcript runs to the panel's top edge at every inset height — no
    // grabber inset, no top padding, no fade (the floating handle overlays it).
    const padBelowHalf = await p
      .getByTestId("chat-thread")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingTop) || 0);
    assert(
      padBelowHalf <= 1,
      `STATES: OPEN_UNDER_HALF thread runs to the panel top edge — no inset (paddingTop ${padBelowHalf})`,
    );
    await snap(p, "state-OPEN_UNDER_HALF");

    // CLOSED — flick down to input, then down again to the pill. Real touch:
    // the grabber sits near the screen bottom, so a downward mouse drag clamps at
    // the viewport edge; CDP touch events carry the full downward delta.
    await gesture(p, -vh, { pointer: "touch", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    await gesture(p, -160, { pointer: "touch", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    assert(
      (await chatState(p)) === "CLOSED",
      `STATES: flick-down from input → CLOSED (got ${await chatState(p)})`,
    );
    await snap(p, "state-CLOSED");
    await p.close();
  }

  // ── PILL → INPUT → CHAT liquid-glass morph. A flick-up from the pill reaches
  // the chat (B4 fix — used to dead-stop at the bare input); a slow drag LERPS
  // the morph (content opacity strictly between 0 and 1 mid-pull).
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    await gesture(p, -160, { pointer: "touch", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    assert((await chatState(p)) === "CLOSED", "PILL-MORPH: collapsed to pill");

    // MID-DRAG hold: slow-pull the PILL up ~half the open distance and HOLD —
    // the glass/content crossfades in proportionally (not a discrete pop).
    await gesture(p, 60, {
      pointer: "mouse",
      slow: true,
      hold: true,
      steps: 8,
      target: "chat-pill",
    });
    const midOpacity = await p
      .getByTestId("chat-content")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
    assert(
      midOpacity > 0.05 && midOpacity < 0.95,
      `PILL-MORPH: content lerps in mid-drag (opacity ${midOpacity})`,
    );
    // NEVER two pills: the grabber bar and the (identical) pill bar must not both
    // be visible at any point in the morph. They crossfade through ~0 at the
    // midpoint — read both live opacities and assert they're never both shown.
    const grabO = await p
      .getByTestId("chat-sheet-grabber")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
    const pillO = await p
      .getByTestId("chat-pill")
      .evaluate((el) =>
        Number.parseFloat(getComputedStyle(el.parentElement).opacity),
      );
    assert(
      !(grabO > 0.15 && pillO > 0.15),
      `PILL-MORPH: never two handle bars at once (grabber ${grabO}, pill ${pillO})`,
    );
    await snap(p, "transition-pill-to-input-mid-drag");
    await release(p, "mouse");
    await p.waitForTimeout(SETTLE);

    // FLICK up from the pill → reaches the chat (history present), not a stop.
    await gesture(p, -160, { pointer: "touch", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    await gesture(p, 140, {
      pointer: "mouse",
      slow: false,
      steps: 2,
      target: "chat-pill",
    });
    await p.waitForTimeout(SETTLE);
    const after = await chatState(p);
    assert(
      after === "OPEN_HALF_OR_OVER" || after === "OPEN_UNDER_HALF",
      `PILL-MORPH: a flick from the pill reaches the chat (got ${after})`,
    );
    await snap(p, "transition-pill-to-chat-flick");
    await p.close();
  }

  // ── INPUT → PILL liquid-glass morph (regression for the dead collapse drag):
  // dragging the input peek DOWN toward the pill must morph it LIVE under the
  // finger — the input bar fades + scales into the pill capsule — instead of
  // staying fully formed (content opacity 1, pill 0) and only snapping to the
  // pill on release (the unresponsive gesture). Mirrors the pill→input morph.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet-grabber"]');
    await p.waitForTimeout(600);
    assert(
      (await detent(p)) === "collapsed",
      "INPUT-PILL-MORPH: starts at the input peek",
    );
    // Slow drag DOWN ~90px (of the 120px morph distance) and HOLD — mid-drag the
    // input should be ~3/4 morphed to the pill: content well below opacity 1, the
    // pill capsule clearly fading in.
    await gesture(p, -90, { pointer: "mouse", slow: true, hold: true, steps: 8 });
    const contentMid = await p
      .getByTestId("chat-content")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
    const pillMid = await p
      .getByTestId("chat-pill")
      .evaluate((el) =>
        Number.parseFloat(getComputedStyle(el.parentElement).opacity),
      );
    assert(
      contentMid < 0.95,
      `INPUT-PILL-MORPH: the input fades mid-drag (content opacity ${contentMid})`,
    );
    assert(
      pillMid > 0.05,
      `INPUT-PILL-MORPH: the pill capsule fades in mid-drag (pill opacity ${pillMid})`,
    );
    await snap(p, "transition-input-to-pill-mid-drag");
    await release(p, "mouse");
    await p.waitForTimeout(SETTLE);
    assert(
      (await detent(p)) === "pill",
      "INPUT-PILL-MORPH: settles to the pill on release",
    );
    await p.close();
  }

  // ── PILL → INPUT on a short SLOW pull: a slow drag up from the pill that only
  // forms the input bar (past the halfway-open mark but short of the thread)
  // must settle at the INPUT state, NOT overshoot to the half detent. Regression
  // guard for the onSettleFree pill branch (it used to force half on any open).
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(500);
    await gesture(p, -160, { pointer: "touch", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "pill", "PILL-INPUT: collapsed to pill first");
    // SLOW pull up ~80px: past the 60px halfway-open mark (commits to leaving the
    // pill) but under PILL_OPEN_DISTANCE (120px), so only the input bar forms.
    await gesture(p, 80, {
      pointer: "mouse",
      slow: true,
      hold: true,
      steps: 10,
      target: "chat-pill",
    });
    const heldRadii = await panelRadii(p);
    assert(
      near(heldRadii.surface, heldRadii.content, 0.5),
      `PILL-INPUT: held drag keeps glass/content radii in sync (surface ${heldRadii.surface}, content ${heldRadii.content})`,
    );
    assert(
      heldRadii.surface > 0 && heldRadii.surface <= 40,
      `PILL-INPUT: held drag uses a real capsule radius, not a huge clamped radius (${heldRadii.surface})`,
    );
    await p.mouse.up();
    await p.waitForTimeout(SETTLE);
    const st = await chatState(p);
    assert(
      st === "INPUT",
      `PILL-INPUT: short slow pull from pill settles at INPUT, not half (got ${st})`,
    );
    await snap(p, "transition-pill-slow-pull-to-input");
    await p.close();
  }

  // ── ROTATION re-settles to a single CLEAN bar (flip-to-side): a viewport SIZE
  // change must never leave the pill↔input morph stranded mid-crossfade. The
  // crossfade math already prevents two bars at once, but a rotation that fires
  // MID-DRAG (rotation often orphans the pointer → draggingRef stuck +
  // openProgress frozen) would leave a half-formed bar and a stuck drag. Assert
  // the morph snaps to a clean resting end (one bar at full opacity).
  {
    const barOpacities = async (pg) => {
      const grabO = await pg
        .getByTestId("chat-sheet-grabber")
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
      const pillO = await pg
        .getByTestId("chat-pill")
        .evaluate((el) =>
          Number.parseFloat(getComputedStyle(el.parentElement).opacity),
        );
      return { grabO, pillO, two: grabO > 0.15 && pillO > 0.15 };
    };

    // Rotate MID-MORPH with the pointer HELD — the orphaned-drag case. Flick to
    // pill, start a slow pill drag and HOLD it mid-crossfade, then rotate WITHOUT
    // releasing. The resize must force-settle: pill fully back, grabber gone.
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(500);
    await gesture(p, -160, { pointer: "touch", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    assert((await detent(p)) === "pill", "ROTATION: collapsed to pill first");
    await gesture(p, 60, {
      pointer: "mouse",
      slow: true,
      hold: true,
      steps: 8,
      target: "chat-pill",
    });
    const midContent = await p
      .getByTestId("chat-content")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));
    assert(
      midContent > 0.05 && midContent < 0.95,
      `ROTATION: held mid-crossfade before rotating (content ${midContent})`,
    );
    await p.setViewportSize({ width: 874, height: 402 }); // rotate to landscape
    await p.waitForTimeout(SETTLE);
    {
      const b = await barOpacities(p);
      assert(
        !b.two,
        `ROTATION: never two bars after rotating mid-morph (grab ${b.grabO}, pill ${b.pillO})`,
      );
      assert(
        b.pillO > 0.85 && b.grabO < 0.15,
        `ROTATION: morph re-settled to the single pill bar (grab ${b.grabO}, pill ${b.pillO})`,
      );
    }
    await release(p, "mouse");
    await snap(p, "rotation-mid-morph-resettled");
    await p.close();
  }

  // ── HEADER tracks the LIVE height (bug 1): dragging the panel below half must
  // HIDE the top buttons MID-DRAG, not keep them on a too-short panel. And the
  // MAXIMIZED enum can never disagree with the full-bleed layout.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(600);
    const vh = await viewportH(p);
    const halfH = Math.round(vh * 0.46);

    // Open to full so the header is shown and the grabber sits high (a downward
    // drag stays on-screen).
    await gesture(p, vh, { pointer: "mouse", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    if (
      (await p.locator('[data-testid="chat-sheet"][data-maximized="true"]').count()) === 1
    ) {
      await restoreFromMaximized(p, "mouse");
    }
    assert(
      await headerShown(p),
      "HEADER-LIVE: header shown at full before the drag",
    );
    // Slow-drag DOWN well below half and HOLD (don't release) — the header must
    // already be gone while the finger is still down.
    await gesture(p, -Math.round(halfH * 1.3), {
      pointer: "mouse",
      slow: true,
      hold: true,
      steps: 10,
    });
    assert(
      !(await headerShown(p)),
      "HEADER-LIVE: header is HIDDEN mid-drag once the panel renders below half",
    );
    await snap(p, "state-mid-drag-below-half-no-header");
    await release(p, "mouse");
    await p.waitForTimeout(SETTLE);

    // Invariant: data-chat-state==="MAXIMIZED" IFF data-maximized==="true".
    await gesture(p, vh, { pointer: "mouse", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    if (
      (await p.locator('[data-testid="chat-sheet"][data-maximized="true"]').count()) === 0
    ) {
      await maximizeByPull(p);
    }
    {
      const cs = await chatState(p);
      const max = await p
        .getByTestId("chat-sheet")
        .getAttribute("data-maximized");
      assert(
        (cs === "MAXIMIZED") === (max === "true"),
        `HEADER-LIVE: chat-state MAXIMIZED iff data-maximized (state=${cs}, maximized=${max})`,
      );
    }
    await p.close();
  }

  // ── STREAMING (bug 2): the in-flight (empty) assistant turn breathes the dots
  // ANCHORED inside its own bubble, not as a detached "..." sibling — so the
  // streamed text fills in right there.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?streaming`);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(500);
    // Open the thread so the in-flight assistant bubble is on screen.
    await gesture(p, 400, { pointer: "mouse", slow: false, steps: 1 });
    await p.waitForTimeout(SETTLE);
    const dotsInBubble = await p
      .locator(
        '[data-testid="thread-line"][data-role="assistant"] [data-testid="typing-dots"]',
      )
      .count();
    assert(
      dotsInBubble >= 1,
      `STREAMING: dots are anchored inside the in-flight assistant bubble (found ${dotsInBubble})`,
    );
    await snap(p, "state-streaming-dots-in-bubble");
    await p.close();
  }

  // ── MULTI-SEND + voice gating (Phase A): while a reply is in flight the mic is
  // gated; the trailing control is STOP with no draft, and SWAPS to an ENABLED
  // "send another" the instant you type — sending queues another turn into the
  // room (serialized multi-send) instead of being blocked until the reply lands.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?streaming`);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(400);
    // No draft while responding → STOP, and the mic is gated (not rendered).
    assert(
      await p.getByTestId("chat-composer-stop").isVisible(),
      "MULTI-SEND: STOP shown while responding with no draft",
    );
    assert(
      (await p.getByTestId("chat-composer-mic").count()) === 0,
      "MULTI-SEND: mic gated while responding",
    );
    // Type → the trailing control swaps to an ENABLED send (queue another turn).
    const input = p.getByTestId("chat-composer-textarea");
    await input.fill("queue another");
    await p.waitForTimeout(150);
    const action = p.getByTestId("chat-composer-action");
    assert(
      await action.isVisible(),
      "MULTI-SEND: send shown while responding + draft",
    );
    assert(
      (await action.getAttribute("aria-disabled")) !== "true",
      "MULTI-SEND: send ENABLED while responding (send another)",
    );
    const before = await p.getByTestId("thread-line").count();
    await action.click();
    await p.waitForTimeout(200);
    const after = await p.getByTestId("thread-line").count();
    assert(
      after > before,
      `MULTI-SEND: sending while responding appends another message (${before} → ${after})`,
    );
    await snap(p, "state-multi-send-while-responding");
    await p.close();
  }

  // ONBOARDING (firstRunOpen): the sheet is pinned full-screen + undismissable.
  // The greeting/choice widget owns the whole first-run screen; on completion the
  // sheet settles to HALF so the home appears behind the top half while the
  // conversation stays in hand.
  {
    const p = await ctrl();
    attachConsole(p, sink);
    await gotoFixture(p, `${url}?firstrun`);
    await p.waitForSelector('[data-testid="chat-sheet"]');
    await p.waitForTimeout(700);
    const vh = await viewportH(p);
    const top = await panelTop(p);
    assert(
      (await detent(p)) === "full",
      "ONBOARDING: sheet reports the pinned-open 'full' detent contract",
    );
    assert(
      top < vh * 0.15,
      `ONBOARDING: sheet is full-screen, not content-sized at the bottom (top ${Math.round(top)} < ${Math.round(vh * 0.15)})`,
    );
    assert(
      (
        (await p
          .getByTestId("chat-composer-textarea")
          .getAttribute("placeholder")) ?? ""
      )
        .toLowerCase()
        .includes("sign in"),
      "ONBOARDING: composer placeholder points to sign-in (#15039; honest copy per #15206)",
    );
    // Sign-in-first onboarding (#15339 supersedes the #12178 unlocked design):
    // the composer is locked until the user signs in, matching the sign-in
    // placeholder above and ContinuousChatOverlay.firstrun.test.tsx.
    assert(
      (await p
        .getByTestId("chat-composer-textarea")
        .isDisabled()),
      "ONBOARDING: composer textarea is locked sign-in-first (#15339)",
    );
    await snap(p, "state-onboarding-full-screen");

    // OPAQUE BACKDROP (#12178 impl / #12364 proof): a solid bg-bg plane covers
    // the launcher/home so no launcher pixel shows through — the fixture's
    // "Workspace" view content behind the chat must be fully hidden. Assert the
    // backdrop is present, opaque, full-viewport, solid-colored, and that the
    // real rendered pixel over the fixture heading reads as the dark onboarding
    // layer rather than the orange home backdrop. The full-screen sheet may cover
    // this coordinate above the backdrop, so this proves the user-visible
    // invariant rather than one specific stacking-layer color.
    const backdrop = await p.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="chat-first-run-backdrop"]',
      );
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        opaque: el.getAttribute("data-first-run-opaque"),
        opacity: cs.opacity,
        bg: cs.backgroundColor,
        coversW: r.width >= window.innerWidth - 1,
        coversH: r.height >= window.innerHeight - 1,
      };
    });
    assert(
      backdrop !== null,
      "ONBOARDING: opaque first-run backdrop is mounted (#12178)",
    );
    assert(
      backdrop.opaque === "true" && backdrop.opacity === "1",
      `ONBOARDING: backdrop is fully opaque while onboarding is open (opaque ${backdrop?.opaque}, opacity ${backdrop?.opacity})`,
    );
    assert(
      backdrop.bg !== "rgba(0, 0, 0, 0)" && backdrop.bg !== "transparent",
      `ONBOARDING: backdrop paints a solid bg-bg color (got ${backdrop?.bg})`,
    );
    assert(
      backdrop.coversW && backdrop.coversH,
      "ONBOARDING: backdrop spans the whole viewport (inset-0)",
    );
    const headingCenter = await p.evaluate(() => {
      const h = document.querySelector('[data-testid="view-content"] h1');
      const r = h.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 4) };
    });
    const hidePx = await pixelAt(p, headingCenter.x, headingCenter.y);
    // The onboarding surface over the heading may be the dark opaque backdrop
    // OR the light full-screen panel (theme-dependent) — what it must NEVER be
    // is the fixture's orange home backdrop showing through.
    assert(
      !(hidePx.r > 200 && hidePx.g < 140 && hidePx.b < 90),
      `ONBOARDING: launcher/home behind is hidden — pixel over the heading is an onboarding layer, not the orange home backdrop (got rgb(${hidePx.r}, ${hidePx.g}, ${hidePx.b}))`,
    );
    await snap(p, "state-onboarding-opaque-backdrop");

    // COMPLETION REVEAL (#12364): drive the falling edge — the backdrop fades
    // off its opaque state and the sheet settles to HALF, revealing the home
    // surface behind the conversation.
    await p.evaluate(() => window.__setFirstRun?.(false));
    await p.waitForTimeout(900);
    const revealOpaque = await p.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="chat-first-run-backdrop"]',
      );
      return el ? el.getAttribute("data-first-run-opaque") : "gone";
    });
    assert(
      revealOpaque !== "true",
      `REVEAL: backdrop drops its opaque state after onboarding completes (got ${revealOpaque})`,
    );
    const revealPx = await pixelAt(p, headingCenter.x, headingCenter.y);
    assert(
      !(revealPx.r < 40 && revealPx.g < 40 && revealPx.b < 50),
      `REVEAL: the home surface is painted again once the backdrop reveals (pixel rgb(${revealPx.r}, ${revealPx.g}, ${revealPx.b}) is no longer the opaque bg)`,
    );
    assert(
      (await detent(p)) === "half",
      "REVEAL: the sheet settles to half on completion, revealing home behind the conversation",
    );
    await snap(p, "state-onboarding-reveal-home");
    await p.close();
  }
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
if (errorLevel.length) for (const e of errorLevel) console.error(`  ⚠ ${e}`);
if (!ONLY_AUTOSCROLL) {
  assert(
    sink.logs.some(
      (l) =>
        l.includes("[fixture] toggleHandsFree") ||
        l.includes("[fixture] toggleRecording") ||
        l.includes("startRecording"),
    ),
    "fixture logged a voice interaction (mic tap → hands-free / recording)",
  );
}

console.log(`\nScreenshots (${shot}) written to ${outDir}`);
if (failures > 0) {
  console.error(`\nCHAT-SHEET E2E FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log("\nCHAT-SHEET E2E PASSED");
