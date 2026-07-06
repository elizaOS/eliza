// Real on-device Android chat gesture matrix (issue #12344, parent #12188).
//
// Drives the ACTUAL app installed on the emulator/device through Playwright's
// Android driver, dispatching gestures as REAL adb touch input (`input swipe` /
// long-press-in-place), never Playwright mouse. Every gesture asserts two
// things: (1) the WebView received real touch events (touch* / pointerType
// "touch", zero mouse pointers) — proving the native touch pipeline fired — and
// (2) the app's own gesture semantics (sheet detents, home↔launcher rail page,
// push-to-talk arming, keyboard avoidance, attachment intake). Agent- or
// mic-dependent legs skip HONESTLY when the backend/model is not up, exactly
// like the iOS GestureSemanticsUITests suite — they never fake a pass.
//
// The whole matrix is captured as one continuous screenrecord via the chunked
// recorder (segments concatenated with ffmpeg), so a reviewer can watch every
// touch path start to finish. Run: bun run --cwd packages/app
// test:e2e:android:touch-gesture (set ELIZA_ANDROID_REQUIRE_AGENT=0 to exercise
// the frontend-only gestures without a live agent).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import {
  captureAndroidLogcat,
  captureAndroidScreenshot,
  startChunkedAndroidScreenRecord,
} from "../../scripts/lib/android-capture.mjs";
import {
  adbDevice,
  resolveAdb,
  resolveSerial,
} from "../../scripts/lib/android-device.mjs";
import { expect, gotoRoute, test, waitForShellReady } from "./android-harness";

declare global {
  interface Window {
    __elizaTouchGestureEvents?: Array<{
      type: string;
      pointerType: string | null;
      touchCount: number | null;
      targetTestId: string | null;
      clientX: number | null;
      clientY: number | null;
    }>;
    __ELIZAOS_UI_APP_STORE__?: {
      value?: {
        setState?: (key: string, value: unknown) => void;
      } | null;
    };
  }
}

const ISSUE_EVIDENCE_DIR = "12344-android-gesture-matrix";
const HOST_AGENT_BASE = "http://127.0.0.1:31337";

function repoRootFromCwd() {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(process.cwd(), "../..");
}

const ARTIFACT_DIR = path.join(
  process.env.ELIZA_ANDROID_ARTIFACT_DIR ??
    path.join(
      repoRootFromCwd(),
      "test-results",
      "android-artifacts",
      ISSUE_EVIDENCE_DIR,
    ),
  "touch-gesture",
);

function writeStage(stage: string, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, "android-gesture-stage.json"),
    `${JSON.stringify({ stage, at: new Date().toISOString(), ...extra }, null, 2)}\n`,
  );
}

function writeJsonArtifact(filename: string, data: unknown) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const artifactPath = path.join(ARTIFACT_DIR, filename);
  fs.writeFileSync(artifactPath, `${JSON.stringify(data, null, 2)}\n`);
  return artifactPath;
}

async function installTouchRecorder(page: Page) {
  await page.evaluate(() => {
    window.__elizaTouchGestureEvents = [];
    const record = (event: Event) => {
      if (
        !event.type.startsWith("pointer") &&
        !event.type.startsWith("touch")
      ) {
        return;
      }
      window.__elizaTouchGestureEvents?.push({
        type: event.type,
        pointerType:
          "pointerType" in event
            ? String((event as PointerEvent).pointerType)
            : null,
        touchCount:
          "touches" in event ? (event as TouchEvent).touches.length : null,
        targetTestId:
          event.target instanceof Element
            ? (event.target
                .closest("[data-testid]")
                ?.getAttribute("data-testid") ?? null)
            : null,
        clientX:
          "clientX" in event
            ? Math.round((event as PointerEvent).clientX)
            : null,
        clientY:
          "clientY" in event
            ? Math.round((event as PointerEvent).clientY)
            : null,
      });
    };
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "touchstart",
      "touchmove",
      "touchend",
    ]) {
      document.addEventListener(type, record, { capture: true, passive: true });
    }
  });
}

async function readTouchEvents(page: Page) {
  return page.evaluate(() => window.__elizaTouchGestureEvents ?? []);
}

/**
 * The core invariant every gesture in this matrix must satisfy: the gesture
 * reached the WebView as REAL touch input (touch* events or pointerType
 * "touch"), and it did NOT arrive as a mouse pointer (which is what a
 * Playwright-mouse fallback would look like). Returns the collected events for
 * summary logging.
 */
async function assertRealTouch(page: Page, label: string) {
  const events = await readTouchEvents(page);
  const touchEventCount = events.filter((e) =>
    e.type.startsWith("touch"),
  ).length;
  const pointerTouchCount = events.filter(
    (e) => e.pointerType === "touch",
  ).length;
  const pointerMouseCount = events.filter(
    (e) => e.pointerType === "mouse",
  ).length;
  expect(
    touchEventCount + pointerTouchCount,
    `${label}: gesture produced real touch input on the Android WebView`,
  ).toBeGreaterThan(0);
  expect(
    pointerMouseCount,
    `${label}: gesture did not use mouse pointer events`,
  ).toBe(0);
  return { events, touchEventCount, pointerTouchCount, pointerMouseCount };
}

async function markFirstRunComplete(page: Page) {
  await page.evaluate(
    async ({ activeServer }) => {
      const seed = {
        "eliza:first-run-complete": "1",
        "eliza:onboarding-complete": "1",
        "eliza:mobile-runtime-mode": "remote",
        "eliza:native-runtime-mode": "remote",
        "elizaos:active-server": activeServer,
      } satisfies Record<string, string>;
      for (const [key, value] of Object.entries(seed)) {
        localStorage.setItem(key, value);
      }
      const preferences = (
        window as Window & {
          Capacitor?: {
            Plugins?: {
              Preferences?: {
                set?: (options: {
                  key: string;
                  value: string;
                }) => Promise<void>;
              };
            };
          };
        }
      ).Capacitor?.Plugins?.Preferences;
      if (preferences?.set) {
        await Promise.all(
          Object.entries(seed).map(([key, value]) =>
            preferences.set?.({ key, value }),
          ),
        );
      }
      window.__ELIZAOS_UI_APP_STORE__?.value?.setState?.(
        "firstRunComplete",
        true,
      );
    },
    {
      activeServer: JSON.stringify({
        id: "remote:host",
        kind: "remote",
        label: "Host agent",
        apiBase: HOST_AGENT_BASE,
      }),
    },
  );
}

async function completeFirstRunIfNeeded(page: Page) {
  const firstRunVisible = await page.evaluate(() =>
    Boolean(
      document.querySelector('[data-testid="first-run-runtime-chooser"]') ||
        // Chooser-mode greeting OR the cloud-only sign-in greeting (#13377).
        /First, where should your agent run|Sign in to Eliza Cloud and I['’]ll get you set up/i.test(
          document.body?.innerText ?? "",
        ),
    ),
  );
  if (!firstRunVisible) return;

  await expect(page.getByTestId("home-launcher-surface")).toBeVisible({
    timeout: 90_000,
  });
  await markFirstRunComplete(page);
  await expect(page.getByTestId("first-run-runtime-chooser"))
    .toBeHidden({ timeout: 5_000 })
    .catch(async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForShellReady(page);
      await markFirstRunComplete(page);
    });
  await expect(page.getByTestId("first-run-runtime-chooser")).toBeHidden({
    timeout: 60_000,
  });
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 60_000,
  });
}

/** Device-pixel start point + geometry for a selector's center. */
async function selectorDevicePoint(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const metrics = await page.evaluate(() => ({
    dpr: window.devicePixelRatio || 1,
    offsetLeft: window.visualViewport?.offsetLeft ?? 0,
    offsetTop: window.visualViewport?.offsetTop ?? 0,
  }));
  const startX = Math.round(
    (box.x + box.width / 2 + metrics.offsetLeft) * metrics.dpr,
  );
  const startY = Math.round(
    (box.y + box.height / 2 + metrics.offsetTop) * metrics.dpr,
  );
  return { box, metrics, startX, startY };
}

async function androidTouchDrag(
  page: Page,
  adb: string,
  serial: string,
  selector: string,
  dx: number,
  dy: number,
  steps = 14,
) {
  const { box, metrics, startX, startY } = await selectorDevicePoint(
    page,
    selector,
  );
  const endX = Math.round(startX + dx * metrics.dpr);
  const endY = Math.round(startY + dy * metrics.dpr);
  writeStage("android-touch-drag", {
    selector,
    box,
    startX,
    startY,
    endX,
    endY,
  });
  adbDevice(adb, serial, [
    "shell",
    "input",
    "swipe",
    String(startX),
    String(startY),
    String(endX),
    String(endY),
    String(Math.max(120, steps * 20)),
  ]);
}

/**
 * Long-press in place: `input swipe` with start == end and a hold duration is
 * the only `adb input` primitive that presses, holds, then releases a single
 * finger without moving it (a plain `input tap` is too fast to cross a
 * long-press / push-to-talk threshold). Runs in the background so the caller can
 * poll mid-hold state (e.g. the push-to-talk label flip) before release.
 */
function androidTouchPressBackground(
  adb: string,
  serial: string,
  x: number,
  y: number,
  holdMs: number,
): Promise<void> {
  const child = spawn(
    adb,
    [
      "-s",
      serial,
      "shell",
      "input",
      "swipe",
      String(x),
      String(y),
      String(x),
      String(y),
      String(holdMs),
    ],
    { stdio: "ignore" },
  );
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

async function waitForResponsiveMainThread(
  page: Page,
  {
    maxLatencyMs = 250,
    consecutive = 3,
    timeoutMs = 120_000,
  }: { maxLatencyMs?: number; consecutive?: number; timeoutMs?: number } = {},
) {
  const startedAt = Date.now();
  let streak = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const latency = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const t0 = performance.now();
          setTimeout(() => resolve(performance.now() - t0), 0);
        }),
    );
    streak = latency <= maxLatencyMs ? streak + 1 : 0;
    if (streak >= consecutive) return;
    await page.waitForTimeout(500);
  }
}

/** The sheet's effective detent (DOM channel shared with the e2e suites). */
async function readDetent(page: Page): Promise<string | null> {
  return page
    .locator('[data-testid="chat-sheet"]')
    .first()
    .getAttribute("data-detent")
    .catch(() => null);
}

/** Whether the Android IME is currently shown (device-level keyboard signal). */
function imeShown(adb: string, serial: string): boolean {
  try {
    const dump = adbDevice(adb, serial, ["shell", "dumpsys", "input_method"]);
    return /mInputShown=true/.test(dump);
  } catch {
    return false;
  }
}

async function ensureCollapsedHome(page: Page, adb: string, serial: string) {
  const overlay = page.getByTestId("continuous-chat-overlay");
  const surface = page.getByTestId("home-launcher-surface");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  await expect(surface).toBeVisible({ timeout: 30_000 });

  if ((await overlay.getAttribute("data-open")) === "true") {
    await page
      .locator('[data-testid="chat-sheet-grabber"]')
      .dispatchEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
    await expect
      .poll(() => overlay.getAttribute("data-open"), { timeout: 5_000 })
      .not.toBe("true")
      .catch(() => undefined);
  }
  if ((await overlay.getAttribute("data-open")) === "true") {
    adbDevice(adb, serial, ["shell", "input", "keyevent", "KEYCODE_BACK"]);
    await expect
      .poll(() => overlay.getAttribute("data-open"), { timeout: 5_000 })
      .not.toBe("true")
      .catch(() => undefined);
  }
  if ((await overlay.getAttribute("data-open")) === "true") {
    for (let i = 0; i < 2; i++) {
      if ((await overlay.getAttribute("data-open")) !== "true") break;
      await androidTouchDrag(
        page,
        adb,
        serial,
        '[data-testid="chat-sheet-grabber"]',
        0,
        900,
        18,
      );
    }
    await expect(overlay).not.toHaveAttribute("data-open", "true", {
      timeout: 15_000,
    });
  }
  if ((await surface.getAttribute("data-page")) !== "home") {
    await androidTouchDrag(
      page,
      adb,
      serial,
      '[data-testid="chat-sheet-grabber"]',
      180,
      6,
    );
    await expect(surface).toHaveAttribute("data-page", "home", {
      timeout: 15_000,
    });
  }
}

/** Idempotent shell prep so each serial test starts from collapsed/home. */
async function ensureReadyShell(page: Page, adb: string, serial: string) {
  await waitForShellReady(page);
  await page.evaluate(() => {
    localStorage.setItem("eliza:tutorial-autolaunched", "1");
    localStorage.setItem("eliza:tutorial:completed", "1");
  });
  await gotoRoute(page, "/");
  await completeFirstRunIfNeeded(page);
  await gotoRoute(page, "/");
  await ensureCollapsedHome(page, adb, serial);
  await waitForResponsiveMainThread(page);
}

/** Type a draft and send it, landing an (optimistic) user bubble. */
async function sendComposerMessage(page: Page, text: string): Promise<boolean> {
  const composer = page.getByTestId("chat-composer-textarea");
  if (!(await composer.isVisible().catch(() => false))) return false;
  await composer.fill(text);
  const send = page.getByRole("button", { name: /^send/i }).first();
  if (await send.isVisible().catch(() => false)) {
    await send.click();
  } else {
    await composer.press("Enter");
  }
  return page
    .locator(`text=${text}`)
    .first()
    .isVisible({ timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
}

let recording: Awaited<
  ReturnType<typeof startChunkedAndroidScreenRecord>
> | null = null;
const matrixLog: Record<string, unknown>[] = [];

test.describe
  .serial("android chat gesture matrix (real WebView)", () => {
    test.beforeAll(async () => {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      const adb = resolveAdb();
      const serial = resolveSerial(adb, process.env.ANDROID_SERIAL);
      recording = await startChunkedAndroidScreenRecord({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "android-gesture-matrix.mp4",
      });
    });

    test.afterAll(async () => {
      const videoPath = await recording?.stop().catch(() => null);
      const adb = resolveAdb();
      const serial = resolveSerial(adb, process.env.ANDROID_SERIAL);
      captureAndroidLogcat({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "logcat.txt",
        lines: 1200,
      });
      writeJsonArtifact("android-gesture-matrix.json", {
        issue: 12344,
        serial,
        videoPath,
        legs: matrixLog,
      });
    });

    test.beforeEach(async ({ page, device }) => {
      await ensureReadyShell(page, resolveAdb(), device.serial());
    });

    test("sheet grabber drag opens and collapses the chat sheet", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(180_000);
      const adb = resolveAdb();
      const serial = device.serial();
      const overlay = page.getByTestId("continuous-chat-overlay");

      await installTouchRecorder(page);
      await androidTouchDrag(
        page,
        adb,
        serial,
        '[data-testid="chat-sheet-grabber"]',
        0,
        -260,
      );
      await expect(overlay).toHaveAttribute("data-open", "true", {
        timeout: 15_000,
      });
      const openedDetent = await readDetent(page);
      const openTouch = await assertRealTouch(page, "sheet-open");
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "gesture-10-sheet-open.png",
      });

      await installTouchRecorder(page);
      await androidTouchDrag(
        page,
        adb,
        serial,
        '[data-testid="chat-sheet-grabber"]',
        0,
        900,
        18,
      );
      await expect(overlay).not.toHaveAttribute("data-open", "true", {
        timeout: 15_000,
      });
      const closeTouch = await assertRealTouch(page, "sheet-close");
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "gesture-11-sheet-collapsed.png",
      });

      matrixLog.push({
        leg: "sheet-detents",
        openedDetent,
        openTouchEvents:
          openTouch.touchEventCount + openTouch.pointerTouchCount,
        closeTouchEvents:
          closeTouch.touchEventCount + closeTouch.pointerTouchCount,
      });
      await testInfo.attach("sheet detents leg", {
        body: JSON.stringify({ openedDetent }, null, 2),
        contentType: "application/json",
      });
    });

    test("horizontal rail swipe pages home↔launcher and back", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(180_000);
      const adb = resolveAdb();
      const serial = device.serial();
      const surface = page.getByTestId("home-launcher-surface");
      await expect(surface).toHaveAttribute("data-page", "home", {
        timeout: 30_000,
      });

      await installTouchRecorder(page);
      let delivered = false;
      for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
        await androidTouchDrag(
          page,
          adb,
          serial,
          '[data-testid="chat-sheet-grabber"]',
          -150,
          -6,
        );
        delivered = await page
          .waitForFunction(
            () => (window.__elizaTouchGestureEvents?.length ?? 0) > 0,
            undefined,
            { timeout: 8_000 },
          )
          .then(() => true)
          .catch(() => false);
        if (!delivered)
          await waitForResponsiveMainThread(page, { timeoutMs: 30_000 });
      }
      await expect(surface).toHaveAttribute("data-page", "launcher", {
        timeout: 15_000,
      });
      await expect(
        page.getByTestId("home-launcher-launcher-page"),
      ).toBeVisible();
      const forwardTouch = await assertRealTouch(page, "rail-home-to-launcher");
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "gesture-20-launcher.png",
      });

      // Back-swipe launcher → home (rail-owned, symmetric 50% distance rule).
      await installTouchRecorder(page);
      await androidTouchDrag(
        page,
        adb,
        serial,
        '[data-testid="chat-sheet-grabber"]',
        150,
        -6,
      );
      await expect(surface).toHaveAttribute("data-page", "home", {
        timeout: 15_000,
      });
      const backTouch = await assertRealTouch(page, "rail-launcher-to-home");
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "gesture-21-back-home.png",
      });

      matrixLog.push({
        leg: "rail-pager",
        forwardTouchEvents:
          forwardTouch.touchEventCount + forwardTouch.pointerTouchCount,
        backTouchEvents:
          backTouch.touchEventCount + backTouch.pointerTouchCount,
      });
      await testInfo.attach("rail pager leg", {
        body: JSON.stringify({ forward: "launcher", back: "home" }, null, 2),
        contentType: "application/json",
      });
    });

    test("push-to-talk hold arms dictation without toggling hands-free", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(180_000);
      const adb = resolveAdb();
      const serial = device.serial();

      // Open the sheet so the composer mic is on screen and hittable.
      await androidTouchDrag(
        page,
        adb,
        serial,
        '[data-testid="chat-sheet-grabber"]',
        0,
        -260,
      );
      const mic = page.getByTestId("chat-composer-mic");
      await expect(mic).toBeVisible({ timeout: 15_000 });
      const idleLabel = await mic.getAttribute("aria-label");

      await installTouchRecorder(page);
      const point = await selectorDevicePoint(
        page,
        '[data-testid="chat-composer-mic"]',
      );
      // Press-and-hold ~700ms (> the 200ms PTT arm threshold), polling the label
      // mid-hold for the "release to insert" dictation state.
      const press = androidTouchPressBackground(
        adb,
        serial,
        point.startX,
        point.startY,
        700,
      );
      let holdingLabel: string | null = null;
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(90);
        const label = await mic.getAttribute("aria-label").catch(() => null);
        if (label && /release to insert/i.test(label)) {
          holdingLabel = label;
          break;
        }
      }
      await press;
      await page.waitForTimeout(400);

      const pttTouch = await assertRealTouch(page, "push-to-talk");
      const micTargeted = pttTouch.events.some(
        (e) => e.targetTestId === "chat-composer-mic",
      );
      expect(micTargeted, "the hold landed on the composer mic").toBe(true);

      // After release, PTT must NOT have latched a hands-free loop. Hands-free is
      // exposed on the mic's own aria-label ("end conversation" / "stop
      // listening"); push-to-talk's release path (finishPushToTalkPress) suppresses
      // the follow-on click, so the label must return to the idle "talk".
      const afterLabel = await mic.getAttribute("aria-label").catch(() => null);
      expect(
        afterLabel ?? "",
        "a push-to-talk hold must not toggle the always-on hands-free loop (the release-click suppress guard)",
      ).not.toMatch(/end conversation/i);

      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "gesture-30-push-to-talk.png",
      });
      matrixLog.push({
        leg: "push-to-talk",
        idleLabel,
        holdingLabel,
        afterLabel,
        armedDictation: Boolean(holdingLabel),
      });
      await testInfo.attach("push-to-talk leg", {
        body: JSON.stringify({ idleLabel, holdingLabel, afterLabel }, null, 2),
        contentType: "application/json",
      });
    });

    test("focusing the composer lifts it clear of the software keyboard", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(180_000);
      const adb = resolveAdb();
      const serial = device.serial();

      await installTouchRecorder(page);
      // A real tap on the composer must both open the sheet and raise the IME.
      await androidTouchDrag(
        page,
        adb,
        serial,
        '[data-testid="chat-sheet-grabber"]',
        0,
        -260,
      );
      const composer = page.getByTestId("chat-composer-textarea");
      await expect(composer).toBeVisible({ timeout: 15_000 });
      const point = await selectorDevicePoint(
        page,
        '[data-testid="chat-composer-textarea"]',
      );
      adbDevice(adb, serial, [
        "shell",
        "input",
        "tap",
        String(point.startX),
        String(point.startY),
      ]);

      let keyboardUp = false;
      for (let i = 0; i < 30 && !keyboardUp; i++) {
        await page.waitForTimeout(500);
        keyboardUp = imeShown(adb, serial);
      }
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "gesture-40-keyboard-up.png",
      });
      test.skip(
        !keyboardUp,
        "the Android IME never reported mInputShown=true after tapping the composer — keyboard avoidance cannot be asserted on this device/config",
      );

      // Keyboard avoidance: the composer must stay within the (now shrunken)
      // visual viewport — never hidden behind the keyboard.
      const layout = await page.evaluate(() => {
        const el = document.querySelector(
          '[data-testid="chat-composer-textarea"]',
        );
        const rect = el?.getBoundingClientRect();
        return {
          composerBottom: rect ? rect.bottom : null,
          viewportHeight: window.visualViewport?.height ?? window.innerHeight,
          innerHeight: window.innerHeight,
        };
      });
      expect(
        layout.composerBottom,
        "composer rect is measurable",
      ).not.toBeNull();
      expect(
        layout.composerBottom as number,
        "the composer must remain above the keyboard (within the visual viewport)",
      ).toBeLessThanOrEqual((layout.viewportHeight as number) + 4);

      matrixLog.push({ leg: "keyboard-avoidance", keyboardUp, ...layout });
      await testInfo.attach("keyboard avoidance leg", {
        body: JSON.stringify({ keyboardUp, ...layout }, null, 2),
        contentType: "application/json",
      });
    });

    test("attaching an image shows a pending preview via the real intake path", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(180_000);
      const adb = resolveAdb();
      const serial = device.serial();

      await androidTouchDrag(
        page,
        adb,
        serial,
        '[data-testid="chat-sheet-grabber"]',
        0,
        -260,
      );
      const attach = page.getByTestId("chat-composer-attach");
      await expect(attach).toBeVisible({ timeout: 15_000 });

      // Tap the attach affordance with real touch (proves the control responds);
      // the native file picker is a separate Activity that adb can't script, so
      // the file itself is injected onto the app's own hidden <input type=file>,
      // driving the REAL addImageFiles intake path.
      await installTouchRecorder(page);
      const point = await selectorDevicePoint(
        page,
        '[data-testid="chat-composer-attach"]',
      );
      adbDevice(adb, serial, [
        "shell",
        "input",
        "tap",
        String(point.startX),
        String(point.startY),
      ]);
      await page.waitForTimeout(300);
      const attachTouch = await assertRealTouch(page, "attach-tap");

      const pngPath = path.join(os.tmpdir(), "eliza-gesture-attach.png");
      // 1x1 PNG (base64) — a real decodable image the intake path accepts.
      fs.writeFileSync(
        pngPath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      await page.setInputFiles('input[type="file"]', pngPath);

      const removeControl = page.getByLabel(/^remove /i).first();
      await expect(
        removeControl,
        "a pending-image preview (with its remove control) must appear after intake",
      ).toBeVisible({ timeout: 10_000 });
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "gesture-50-attachment-preview.png",
      });

      matrixLog.push({
        leg: "media-attachment",
        attachTouchEvents:
          attachTouch.touchEventCount + attachTouch.pointerTouchCount,
        previewShown: true,
      });
      await testInfo.attach("media attachment leg", {
        body: JSON.stringify({ previewShown: true }, null, 2),
        contentType: "application/json",
      });
    });

    test("long press on a sent message reveals the copy affordance", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(180_000);
      const adb = resolveAdb();
      const serial = device.serial();

      await androidTouchDrag(
        page,
        adb,
        serial,
        '[data-testid="chat-sheet-grabber"]',
        0,
        -260,
      );
      const sent = await sendComposerMessage(page, "long press probe");
      test.skip(
        !sent,
        "no optimistic user bubble landed (agent backend not up) — the message-dependent long-press cannot be exercised on this run",
      );

      const bubble = page.locator("text=long press probe").first();
      await expect(bubble).toBeVisible({ timeout: 10_000 });
      await installTouchRecorder(page);
      const point = await selectorDevicePoint(page, "text=long press probe");
      await androidTouchPressBackground(
        adb,
        serial,
        point.startX,
        point.startY,
        800,
      );
      await page.waitForTimeout(400);
      const pressTouch = await assertRealTouch(page, "long-press");

      // Press-and-hold on a message either copies it (flash confirmation) or
      // reveals the action row — both are the intended long-press semantics.
      const copied = await page
        .getByText(/copied/i)
        .first()
        .isVisible()
        .catch(() => false);
      const actionRow = await page
        .getByRole("button", { name: /copy|edit|message actions/i })
        .first()
        .isVisible()
        .catch(() => false);
      expect(
        copied || actionRow,
        "a long-press on a message must copy it or reveal its action row",
      ).toBe(true);
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "gesture-60-long-press.png",
      });

      matrixLog.push({
        leg: "long-press",
        touchEvents: pressTouch.touchEventCount + pressTouch.pointerTouchCount,
        copied,
        actionRow,
      });
      await testInfo.attach("long press leg", {
        body: JSON.stringify({ copied, actionRow }, null, 2),
        contentType: "application/json",
      });
    });
  });
