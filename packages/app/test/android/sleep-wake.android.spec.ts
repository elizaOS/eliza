// Android lifecycle regression for #9943.
//
// Drives the installed Capacitor app through a real device sleep/wake cycle and
// proves the WebView emits pause/resume lifecycle signals, returns to the home
// shell, and remains interactive against the live host backend.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  captureAndroidLogcat,
  captureAndroidScreenshot,
  startAndroidScreenRecord,
} from "../../scripts/lib/android-capture.mjs";
import {
  APP_ID,
  foregroundApp,
  MAIN_ACTIVITY,
  resolveAdb,
} from "../../scripts/lib/android-device.mjs";
import {
  expect,
  isFirstRunShowing,
  ORIGIN,
  test,
  waitForShellReady,
} from "./android-harness";

const API = process.env.API ?? "http://127.0.0.1:31337";
const ARTIFACT_DIR = path.resolve(
  process.env.ELIZA_ANDROID_ARTIFACT_DIR ??
    path.join(
      process.cwd(),
      "..",
      "..",
      ".github",
      "issue-evidence",
      "9943-android-sleep-wake",
    ),
  "sleep-wake",
);

const APP_PAUSE_EVENT = "eliza:app-pause";
const APP_RESUME_EVENT = "eliza:app-resume";
const FIRST_RUN_REMOTE_DEEPLINK = `elizaos://first-run/runtime/remote?api=${encodeURIComponent(
  API,
)}`;

type LifecycleEventName =
  | typeof APP_PAUSE_EVENT
  | typeof APP_RESUME_EVENT
  | "blur"
  | "focus"
  | "pagehide"
  | "pageshow"
  | "visibilitychange";

interface SleepWakeEvent {
  event: LifecycleEventName;
  visibilityState: DocumentVisibilityState;
  hidden: boolean;
  at: number;
}

interface SleepWakeWindow extends Window {
  __ELIZA_ANDROID_SLEEP_WAKE_EVENTS__?: SleepWakeEvent[];
}

function adbShell(adb: string, serial: string, ...args: string[]): string {
  return execFileSync(adb, ["-s", serial, "shell", ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
}

function tryAdbShell(adb: string, serial: string, ...args: string[]): string {
  try {
    return adbShell(adb, serial, ...args);
  } catch {
    return "";
  }
}

async function installLifecycleProbe(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(
    ({ pauseEvent, resumeEvent }) => {
      const sleepWakeWindow = window as SleepWakeWindow;
      sleepWakeWindow.__ELIZA_ANDROID_SLEEP_WAKE_EVENTS__ = [];
      const record = (event: LifecycleEventName) => {
        sleepWakeWindow.__ELIZA_ANDROID_SLEEP_WAKE_EVENTS__?.push({
          event,
          visibilityState: document.visibilityState,
          hidden: document.hidden,
          at: performance.now(),
        });
      };

      for (const event of [
        pauseEvent,
        resumeEvent,
        "blur",
        "focus",
        "pagehide",
        "pageshow",
      ] as LifecycleEventName[]) {
        window.addEventListener(event, () => record(event), { passive: true });
        document.addEventListener(event, () => record(event), {
          passive: true,
        });
      }
      document.addEventListener(
        "visibilitychange",
        () => record("visibilitychange"),
        { passive: true },
      );
      record("pageshow");
    },
    { pauseEvent: APP_PAUSE_EVENT, resumeEvent: APP_RESUME_EVENT },
  );
}

async function lifecycleEvents(
  page: import("@playwright/test").Page,
): Promise<SleepWakeEvent[]> {
  return page.evaluate(
    () =>
      ((window as SleepWakeWindow).__ELIZA_ANDROID_SLEEP_WAKE_EVENTS__ ??
        []) as SleepWakeEvent[],
  );
}

function startDeepLink(adb: string, serial: string, url: string): void {
  execFileSync(
    adb,
    [
      "-s",
      serial,
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-c",
      "android.intent.category.BROWSABLE",
      "-d",
      url,
      APP_ID,
    ],
    { stdio: "inherit" },
  );
}

async function ensureHostFirstRunComplete(): Promise<void> {
  const status = await fetch(`${API}/api/first-run/status`, {
    headers: { "X-ElizaOS-Client-Id": "android-sleep-wake" },
  }).then((response) => response.json() as Promise<{ complete?: boolean }>);
  if (status.complete === true) return;

  const response = await fetch(`${API}/api/first-run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-ElizaOS-Client-Id": "android-sleep-wake",
    },
    body: JSON.stringify({ name: "Android Sleep Wake Agent" }),
  });
  if (!response.ok) {
    throw new Error(
      `/api/first-run failed: ${response.status} ${response.statusText}`,
    );
  }
}

async function waitForInteractiveHome(
  page: import("@playwright/test").Page,
): Promise<void> {
  await waitForShellReady(page);
  await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect
    .poll(() => isFirstRunShowing(page), {
      timeout: 60_000,
      message: "first-run UI still intercepts the home shell",
    })
    .toBe(false);
  await expect(page.getByTestId("home-launcher-surface")).toBeVisible({
    timeout: 60_000,
  });
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 60_000 });
  await composer.click({ timeout: 30_000 });
}

async function markFirstRunComplete(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(async () => {
    localStorage.setItem("eliza:first-run-complete", "1");
    localStorage.setItem("eliza:onboarding-complete", "1");
    localStorage.setItem("eliza:setup:step", "complete");
    (
      window as Window & {
        __ELIZAOS_UI_APP_STORE__?: {
          value?: {
            setState?: (key: string, value: unknown) => void;
          } | null;
        };
        Capacitor?: {
          Plugins?: {
            Preferences?: {
              set?: (args: { key: string; value: string }) => Promise<void>;
            };
          };
        };
      }
    ).__ELIZAOS_UI_APP_STORE__?.value?.setState?.("firstRunComplete", true);
    const preferences = (
      window as Window & {
        Capacitor?: {
          Plugins?: {
            Preferences?: {
              set?: (args: { key: string; value: string }) => Promise<void>;
            };
          };
        };
      }
    ).Capacitor?.Plugins?.Preferences;
    if (preferences?.set) {
      await Promise.all([
        preferences.set({ key: "eliza:first-run-complete", value: "1" }),
        preferences.set({ key: "eliza:onboarding-complete", value: "1" }),
        preferences.set({ key: "eliza:setup:step", value: "complete" }),
      ]);
    }
  });
}

async function connectHostRuntimeViaDeepLink({
  adb,
  serial,
  page,
}: {
  adb: string;
  serial: string;
  page: import("@playwright/test").Page;
}): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem("elizaos:active-server");
    localStorage.removeItem("eliza:onboarding-complete");
    localStorage.removeItem("eliza:first-run-complete");
    localStorage.removeItem("eliza:setup:step");
    localStorage.removeItem("eliza:mobile-runtime-mode");
  });
  await page.goto(`${ORIGIN}/?reset`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  startDeepLink(adb, serial, FIRST_RUN_REMOTE_DEEPLINK);
  await expect(page.getByTestId("home-launcher-surface")).toBeVisible({
    timeout: 90_000,
  });
  await markFirstRunComplete(page);
  await waitForInteractiveHome(page);
}

async function ensureReadyForSleepWake({
  adb,
  serial,
  page,
}: {
  adb: string;
  serial: string;
  page: import("@playwright/test").Page;
}): Promise<void> {
  const startupState = await expect
    .poll(
      async () => {
        if (await isFirstRunShowing(page)) return "first-run";
        if (
          (await page.getByTestId("home-launcher-surface").count()) > 0 &&
          (await page.getByTestId("chat-composer-textarea").count()) > 0
        ) {
          return "home";
        }
        return "pending";
      },
      {
        timeout: 90_000,
        message: "Android app never reached first-run or home shell",
      },
    )
    .not.toBe("pending")
    .then(async () => {
      if (await isFirstRunShowing(page)) return "first-run";
      return "home";
    });

  if (startupState === "first-run") {
    await connectHostRuntimeViaDeepLink({ adb, serial, page });
    return;
  }
  await waitForInteractiveHome(page);
}

test.describe
  .serial("android sleep/wake lifecycle (real WebView)", () => {
    test("emits pause/resume and stays interactive after device sleep/wake", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(240_000);

      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      const adb = resolveAdb();
      const serial = device.serial();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await ensureHostFirstRunComplete();

      const packageInfo = adbShell(adb, serial, "dumpsys", "package", APP_ID);
      fs.writeFileSync(
        path.join(ARTIFACT_DIR, "android-package.txt"),
        packageInfo,
      );

      await page.goto(ORIGIN, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await ensureReadyForSleepWake({ adb, serial, page });
      await installLifecycleProbe(page);

      const beforeScreenshot = captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "sleep-wake-before.png",
      });
      await testInfo.attach("before sleep screenshot", {
        path: beforeScreenshot,
        contentType: "image/png",
      });

      const recording = await startAndroidScreenRecord({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "sleep-wake.mp4",
        remotePath: "/sdcard/eliza-9943-sleep-wake.mp4",
        timeLimitSeconds: 90,
      });

      try {
        adbShell(adb, serial, "input", "keyevent", "KEYCODE_SLEEP");
        await page.waitForTimeout(2_000);
        adbShell(adb, serial, "input", "keyevent", "KEYCODE_WAKEUP");
        await page.waitForTimeout(1_000);
        tryAdbShell(adb, serial, "wm", "dismiss-keyguard");
        tryAdbShell(adb, serial, "input", "keyevent", "KEYCODE_MENU");
        foregroundApp(adb, serial);
        await page.waitForTimeout(1_000);
        tryAdbShell(adb, serial, "am", "start", "-W", "-n", MAIN_ACTIVITY);

        await waitForInteractiveHome(page);

        const events = await lifecycleEvents(page);
        const report = {
          benchmark: "android sleep/wake lifecycle real WebView",
          serial,
          appId: APP_ID,
          mainActivity: MAIN_ACTIVITY,
          visibilityState: await page.evaluate(() => document.visibilityState),
          url: page.url(),
          events,
          counts: {
            pause: events.filter((event) => event.event === APP_PAUSE_EVENT)
              .length,
            resume: events.filter((event) => event.event === APP_RESUME_EVENT)
              .length,
            hidden: events.filter(
              (event) => event.visibilityState === "hidden" || event.hidden,
            ).length,
            visible: events.filter(
              (event) => event.visibilityState === "visible" && !event.hidden,
            ).length,
          },
          pageErrors,
        };
        const reportPath = path.join(ARTIFACT_DIR, "sleep-wake-report.json");
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        await testInfo.attach("sleep/wake lifecycle report", {
          path: reportPath,
          contentType: "application/json",
        });

        const afterScreenshot = captureAndroidScreenshot({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "sleep-wake-after.png",
        });
        await testInfo.attach("after wake screenshot", {
          path: afterScreenshot,
          contentType: "image/png",
        });

        const logcatPath = captureAndroidLogcat({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "sleep-wake-logcat.txt",
          lines: 900,
        });
        await testInfo.attach("sleep/wake logcat", {
          path: logcatPath,
          contentType: "text/plain",
        });

        expect(
          report.counts.pause,
          "app pause lifecycle event",
        ).toBeGreaterThan(0);
        expect(
          report.counts.resume,
          "app resume lifecycle event",
        ).toBeGreaterThan(0);
        expect(
          report.counts.visible,
          "visible visibility signal after wake",
        ).toBeGreaterThan(1);
        expect(report.visibilityState, "app visible after wake").toBe(
          "visible",
        );
        expect(
          pageErrors.filter(
            (message) =>
              !message.includes(
                '"LlamaCpp" plugin is not implemented on android',
              ),
          ),
          "uncaught page errors",
        ).toEqual([]);
      } finally {
        const videoPath = await recording.stop();
        if (videoPath) {
          await testInfo.attach("sleep/wake screenrecord", {
            path: videoPath,
            contentType: "video/mp4",
          });
        }
      }
    });
  });
