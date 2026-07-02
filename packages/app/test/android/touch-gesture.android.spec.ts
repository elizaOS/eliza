import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import {
  captureAndroidLogcat,
  captureAndroidScreenshot,
  startAndroidScreenRecord,
} from "../../scripts/lib/android-capture.mjs";
import { adbDevice, resolveAdb } from "../../scripts/lib/android-device.mjs";
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

const ISSUE_EVIDENCE_DIR = "9943-android-touch-gesture";
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
  repoRootFromCwd(),
  ".github",
  "issue-evidence",
  ISSUE_EVIDENCE_DIR,
);

function writeStage(stage: string, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, "android-touch-stage.json"),
    `${JSON.stringify(
      {
        stage,
        at: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

function writeJsonArtifact(filename: string, data: unknown) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const artifactPath = path.join(ARTIFACT_DIR, filename);
  fs.writeFileSync(`${artifactPath}`, `${JSON.stringify(data, null, 2)}\n`);
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
      document.addEventListener(type, record, {
        capture: true,
        passive: true,
      });
    }
  });
}

async function readTouchEvents(page: Page) {
  return page.evaluate(() => window.__elizaTouchGestureEvents ?? []);
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
        /First, where should your agent run/i.test(
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

async function androidTouchDrag(
  page: Page,
  adb: string,
  serial: string,
  selector: string,
  dx: number,
  dy: number,
  steps = 14,
) {
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
  const endX = Math.round(startX + dx * metrics.dpr);
  const endY = Math.round(startY + dy * metrics.dpr);
  writeStage("android-touch-drag", {
    selector,
    box,
    metrics,
    startX,
    startY,
    endX,
    endY,
  });
  writeJsonArtifact("android-touch-drag.json", {
    selector,
    box,
    metrics,
    startX,
    startY,
    endX,
    endY,
    dx,
    dy,
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
 * Wait until the WebView main thread is responsive enough to receive input.
 * On a software-GPU emulator the embedded runtime's boot stalls the main
 * thread in multi-second chunks (logcat `Davey! duration=1793ms`, `Skipped 47
 * frames`); while stalled, Android's input pipeline can drop the ENTIRE adb
 * swipe sequence — the page then sees zero pointer events, and no commit
 * logic can fire on events that never arrive. Requires several consecutive
 * low-latency event-loop samples before letting the gesture proceed.
 */
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
  let lastLatency = -1;
  while (Date.now() - startedAt < timeoutMs) {
    lastLatency = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const t0 = performance.now();
          setTimeout(() => resolve(performance.now() - t0), 0);
        }),
    );
    streak = lastLatency <= maxLatencyMs ? streak + 1 : 0;
    if (streak >= consecutive) {
      writeStage("main-thread-responsive", {
        lastLatency,
        waitedMs: Date.now() - startedAt,
      });
      return;
    }
    await page.waitForTimeout(500);
  }
  // Proceed anyway — the retry loop around the drag still gets its chance —
  // but record that the settle gate never opened (this run will be slow).
  writeStage("main-thread-still-janked", {
    lastLatency,
    waitedMs: Date.now() - startedAt,
  });
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
    if ((await overlay.getAttribute("data-open")) === "true") {
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
    if ((await overlay.getAttribute("data-open")) === "true") {
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

test.describe
  .serial("android touch gesture smoke (real WebView)", () => {
    test("chat grabber finger swipe opens launcher rail without mouse fallback", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(180_000);

      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      const adb = resolveAdb();
      const serial = device.serial();
      const consoleLines: string[] = [];
      const pageErrors: string[] = [];

      page.on("console", (message) => {
        consoleLines.push(
          JSON.stringify({ type: message.type(), text: message.text() }),
        );
      });
      page.on("pageerror", (error) => {
        pageErrors.push(error.stack || error.message);
      });

      const recording = await startAndroidScreenRecord({
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "android-touch-gesture.mp4",
        remotePath: "/sdcard/eliza-android-touch-gesture.mp4",
      });

      try {
        writeStage("wait-shell-ready", { serial });
        await waitForShellReady(page);
        writeStage("seed-tutorial", { serial });
        await page.evaluate(() => {
          localStorage.setItem("eliza:tutorial-autolaunched", "1");
          localStorage.setItem("eliza:tutorial:completed", "1");
        });
        writeStage("goto-home", { serial });
        await gotoRoute(page, "/");
        writeStage("complete-first-run-if-needed", { serial });
        await completeFirstRunIfNeeded(page);
        await gotoRoute(page, "/");

        const overlay = page.getByTestId("continuous-chat-overlay");
        const surface = page.getByTestId("home-launcher-surface");
        writeStage("ensure-collapsed-home", { serial });
        await ensureCollapsedHome(page, adb, serial);
        writeStage("assert-home-collapsed", { serial });
        await expect(surface).toHaveAttribute("data-page", "home", {
          timeout: 30_000,
        });
        await expect(overlay).not.toHaveAttribute("data-open", "true");

        const beforePage = await surface.getAttribute("data-page");
        writeStage("install-touch-recorder", { beforePage, serial });
        await installTouchRecorder(page);
        // A stalled main thread drops the whole adb swipe before the page sees
        // a single pointer event — settle first, then dispatch with bounded,
        // LOGGED retries whenever zero events were delivered (no silent
        // retries; the final assertion below is unchanged and strict).
        await waitForResponsiveMainThread(page);
        const maxDragAttempts = 3;
        for (let attempt = 1; attempt <= maxDragAttempts; attempt++) {
          writeStage("dispatch-horizontal-touch", {
            attempt,
            beforePage,
            serial,
          });
          await androidTouchDrag(
            page,
            adb,
            serial,
            '[data-testid="chat-sheet-grabber"]',
            -150,
            -6,
          );
          const delivered = await page
            .waitForFunction(
              () => (window.__elizaTouchGestureEvents?.length ?? 0) > 0,
              undefined,
              { timeout: 8_000 },
            )
            .then(() => true)
            .catch(() => false);
          if (delivered) break;
          writeStage("retry-dispatch-no-events-delivered", {
            attempt,
            serial,
          });
          await waitForResponsiveMainThread(page, { timeoutMs: 30_000 });
        }

        writeStage("assert-launcher", { beforePage, serial });
        await expect
          .poll(
            async () => ({
              page: await surface.getAttribute("data-page"),
              eventCount: (await readTouchEvents(page)).length,
              eventTargets: Array.from(
                new Set(
                  (await readTouchEvents(page)).map(
                    (event) => event.targetTestId,
                  ),
                ),
              ),
            }),
            { timeout: 15_000 },
          )
          .toMatchObject({ page: "launcher" });
        await expect(overlay).not.toHaveAttribute("data-open", "true");
        await expect(
          page.getByTestId("home-launcher-launcher-page"),
        ).toBeVisible();

        const afterPage = await surface.getAttribute("data-page");
        const touchEvents = await readTouchEvents(page);
        const touchEventCount = touchEvents.filter((event) =>
          event.type.startsWith("touch"),
        ).length;
        const pointerTouchCount = touchEvents.filter(
          (event) => event.pointerType === "touch",
        ).length;
        const pointerMouseCount = touchEvents.filter(
          (event) => event.pointerType === "mouse",
        ).length;
        expect(
          touchEventCount + pointerTouchCount,
          "gesture produced real touch input on the installed Android WebView",
        ).toBeGreaterThan(0);
        expect(
          pointerMouseCount,
          "gesture did not use mouse pointer events",
        ).toBe(0);

        const screenshotPath = captureAndroidScreenshot({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "android-touch-launcher.png",
        });
        await testInfo.attach("Android launcher after touch swipe", {
          path: screenshotPath,
          contentType: "image/png",
        });

        const summaryPath = path.join(
          ARTIFACT_DIR,
          "android-touch-gesture.json",
        );
        fs.writeFileSync(
          summaryPath,
          `${JSON.stringify(
            {
              issue: 9943,
              serial,
              route: page.url(),
              beforePage,
              afterPage,
              touchEventCount,
              pointerTouchCount,
              pointerMouseCount,
              eventTypes: touchEvents.reduce<Record<string, number>>(
                (counts, event) => {
                  counts[event.type] = (counts[event.type] ?? 0) + 1;
                  return counts;
                },
                {},
              ),
            },
            null,
            2,
          )}\n`,
        );
        await testInfo.attach("Android touch gesture summary", {
          path: summaryPath,
          contentType: "application/json",
        });
      } finally {
        const touchEvents = await readTouchEvents(page).catch(() => []);
        writeJsonArtifact("android-touch-debug.json", {
          issue: 9943,
          serial,
          url: page.url(),
          eventCount: touchEvents.length,
          eventTypes: touchEvents.reduce<Record<string, number>>(
            (counts, event) => {
              counts[event.type] = (counts[event.type] ?? 0) + 1;
              return counts;
            },
            {},
          ),
          pointerTypes: touchEvents.reduce<Record<string, number>>(
            (counts, event) => {
              const pointerType = event.pointerType ?? "none";
              counts[pointerType] = (counts[pointerType] ?? 0) + 1;
              return counts;
            },
            {},
          ),
          targetTestIds: touchEvents.reduce<Record<string, number>>(
            (counts, event) => {
              const target = event.targetTestId ?? "none";
              counts[target] = (counts[target] ?? 0) + 1;
              return counts;
            },
            {},
          ),
          firstEvents: touchEvents.slice(0, 12),
        });

        const consolePath = path.join(ARTIFACT_DIR, "webview-console.log");
        fs.writeFileSync(
          consolePath,
          `${consoleLines.join("\n")}\n${pageErrors
            .map((error) => `[pageerror] ${error}`)
            .join("\n")}\n`,
        );
        await testInfo.attach("WebView console", {
          path: consolePath,
          contentType: "text/plain",
        });

        const logcatPath = captureAndroidLogcat({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "logcat.txt",
          lines: 800,
        });
        await testInfo.attach("Android logcat", {
          path: logcatPath,
          contentType: "text/plain",
        });

        const videoPath = await recording.stop();
        if (videoPath) {
          await testInfo.attach("Android touch gesture screenrecord", {
            path: videoPath,
            contentType: "video/mp4",
          });
        }
      }
    });
  });
