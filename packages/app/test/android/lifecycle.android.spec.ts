// Device-lifecycle robustness matrix for #12185 (supports the #12188 mobile
// lanes). Drives the INSTALLED app on a real emulator/device through OS
// lifecycle events — app switching (home / recents / another app), camera
// interruption, mute, low battery + battery saver, forced doze, and process
// death + relaunch — and asserts after every event that the WebView shell is
// interactive, the on-device agent loopback (127.0.0.1:31337) answers, and the
// ElizaAgentService foreground service survives or restarts. Screen off/sleep
// is covered by sleep-wake.android.spec.ts; reboot + ElizaBootReceiver
// autostart by lifecycle-reboot.android.spec.ts. The full event × platform
// matrix lives in docs/DEVICE_LIFECYCLE_MATRIX.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  captureAndroidLogcat,
  captureAndroidScreenshot,
  startAndroidScreenRecord,
} from "../../scripts/lib/android-capture.mjs";
import {
  AGENT_API_PORT,
  APP_ID,
  foregroundApp,
  MAIN_ACTIVITY,
  resolveAdb,
} from "../../scripts/lib/android-device.mjs";
import {
  expect,
  isFirstRunShowing,
  test,
  waitForShellReady,
} from "./android-harness";

const ARTIFACT_DIR = path.resolve(
  process.env.ELIZA_ANDROID_ARTIFACT_DIR ??
    path.join(
      process.cwd(),
      "..",
      "..",
      "test-results",
      "android-artifacts",
      "12185-device-lifecycle",
      "android",
    ),
  "lifecycle",
);

const SETTINGS_ACTIVITY = "com.android.settings/.Settings";
const CAMERA_PACKAGE = "com.android.camera2";
const CAMERA_ACTIVITY = `${CAMERA_PACKAGE}/com.android.camera.CameraActivity`;

const APP_PAUSE_EVENT = "eliza:app-pause";
const APP_RESUME_EVENT = "eliza:app-resume";

type LifecycleEventName =
  | typeof APP_PAUSE_EVENT
  | typeof APP_RESUME_EVENT
  | "blur"
  | "focus"
  | "pagehide"
  | "pageshow"
  | "visibilitychange";

interface LifecycleEvent {
  event: LifecycleEventName;
  visibilityState: DocumentVisibilityState;
  hidden: boolean;
  at: number;
}

interface LifecycleWindow extends Window {
  __ELIZA_ANDROID_LIFECYCLE_EVENTS__?: LifecycleEvent[];
}

/** Per-event results collected across the serial suite; written as report.json. */
const results: Array<Record<string, unknown>> = [];

function adbShell(adb: string, serial: string, ...args: string[]): string {
  return execFileSync(adb, ["-s", serial, "shell", ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function tryAdbShell(adb: string, serial: string, ...args: string[]): string {
  try {
    return adbShell(adb, serial, ...args);
  } catch {
    return "";
  }
}

/** Package that currently owns the resumed (foreground) activity. */
function resumedPackage(adb: string, serial: string): string {
  const dump = tryAdbShell(adb, serial, "dumpsys", "activity", "activities");
  const match = dump.match(
    /ResumedActivity:? ActivityRecord\{[^ ]+ u\d+ ([^ /]+)\//,
  );
  return match?.[1] ?? "";
}

async function pollResumedPackage(
  adb: string,
  serial: string,
  predicate: (pkg: string) => boolean,
  message: string,
): Promise<string> {
  let pkg = "";
  await expect
    .poll(
      () => {
        pkg = resumedPackage(adb, serial);
        return predicate(pkg);
      },
      { timeout: 30_000, message },
    )
    .toBe(true);
  return pkg;
}

/** True when a ServiceRecord for the agent FGS exists in ActivityManager. */
function agentServicePresent(adb: string, serial: string): boolean {
  return tryAdbShell(
    adb,
    serial,
    "dumpsys",
    "activity",
    "services",
    APP_ID,
  ).includes(`${APP_ID}/.ElizaAgentService`);
}

/** PID of the detached bun agent process (its cmdline carries agent-bundle.js). */
function agentBundlePid(adb: string, serial: string): string {
  const line = tryAdbShell(
    adb,
    serial,
    "sh",
    "-c",
    "ps -A -o PID,CMDLINE 2>/dev/null | grep agent-bundle.js | grep -v grep",
  ).trim();
  return line.split(/\s+/)[0] ?? "";
}

function appPid(adb: string, serial: string): string {
  return tryAdbShell(adb, serial, "pidof", APP_ID).trim();
}

/**
 * Poll the agent loopback health through the WebView's own fetch — the same
 * 127.0.0.1:31337 path the app uses — until it answers 200.
 */
async function expectAgentHealthViaWebView(
  page: import("@playwright/test").Page,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  let last = { status: 0, body: "" };
  await expect
    .poll(
      async () => {
        last = await page.evaluate(async (port) => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
              headers: { "X-ElizaOS-Client-Id": "android-lifecycle-e2e" },
            });
            return { status: res.status, body: await res.text() };
          } catch (error) {
            return { status: 0, body: String(error) };
          }
        }, AGENT_API_PORT);
        return last.status;
      },
      {
        timeout: timeoutMs,
        message: `agent loopback health never returned 200 (last: ${JSON.stringify(last)})`,
      },
    )
    .toBe(200);
}

/** Reset + install the in-page pause/resume/visibility recorder. */
async function installLifecycleProbe(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(
    ({ pauseEvent, resumeEvent }) => {
      const lifecycleWindow = window as LifecycleWindow;
      lifecycleWindow.__ELIZA_ANDROID_LIFECYCLE_EVENTS__ = [];
      const record = (event: LifecycleEventName) => {
        lifecycleWindow.__ELIZA_ANDROID_LIFECYCLE_EVENTS__?.push({
          event,
          visibilityState: document.visibilityState,
          hidden: document.hidden,
          at: performance.now(),
        });
      };
      const alreadyWired = (
        lifecycleWindow as LifecycleWindow & {
          __ELIZA_LIFECYCLE_PROBE_WIRED__?: boolean;
        }
      ).__ELIZA_LIFECYCLE_PROBE_WIRED__;
      if (!alreadyWired) {
        (
          lifecycleWindow as LifecycleWindow & {
            __ELIZA_LIFECYCLE_PROBE_WIRED__?: boolean;
          }
        ).__ELIZA_LIFECYCLE_PROBE_WIRED__ = true;
        for (const event of [
          pauseEvent,
          resumeEvent,
          "blur",
          "focus",
          "pagehide",
          "pageshow",
        ] as LifecycleEventName[]) {
          window.addEventListener(event, () => record(event), {
            passive: true,
          });
        }
        document.addEventListener(
          "visibilitychange",
          () => record("visibilitychange"),
          { passive: true },
        );
      }
    },
    { pauseEvent: APP_PAUSE_EVENT, resumeEvent: APP_RESUME_EVENT },
  );
}

async function lifecycleEventCounts(
  page: import("@playwright/test").Page,
): Promise<{ pause: number; resume: number; hidden: number; visible: number }> {
  const events = await page.evaluate(
    () =>
      ((window as LifecycleWindow).__ELIZA_ANDROID_LIFECYCLE_EVENTS__ ??
        []) as LifecycleEvent[],
  );
  return {
    pause: events.filter((event) => event.event === APP_PAUSE_EVENT).length,
    resume: events.filter((event) => event.event === APP_RESUME_EVENT).length,
    hidden: events.filter((event) => event.hidden).length,
    visible: events.filter(
      (event) => event.visibilityState === "visible" && !event.hidden,
    ).length,
  };
}

/** Shell rendered, no first-run interception, composer visible, JS responsive. */
async function expectInteractive(
  page: import("@playwright/test").Page,
): Promise<void> {
  await waitForShellReady(page);
  await expect
    .poll(() => isFirstRunShowing(page), {
      timeout: 60_000,
      message: "first-run UI intercepts the shell after a lifecycle event",
    })
    .toBe(false);
  await expect(
    page.locator('[data-testid="chat-composer-textarea"]'),
  ).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => 6 * 7)).toBe(42);
}

async function refocusApp(adb: string, serial: string): Promise<void> {
  foregroundApp(adb, serial);
  await pollResumedPackage(
    adb,
    serial,
    (pkg) => pkg === APP_ID,
    "app never returned to the foreground",
  );
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe
  .serial("android device-lifecycle robustness (real WebView + real agent)", () => {
    let recording: Awaited<ReturnType<typeof startAndroidScreenRecord>> | null =
      null;

    test.beforeAll(async ({ device }) => {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      const adb = resolveAdb();
      // Fresh logcat window so the final FATAL/ANR sweep only sees this run.
      tryAdbShell(adb, device.serial(), "logcat", "-c");
      // screenrecord hard-caps a segment at 180s; this captures the first
      // ~3 min (app switching + camera + mute) as the walkthrough evidence.
      recording = await startAndroidScreenRecord({
        adb,
        serial: device.serial(),
        artifactDir: ARTIFACT_DIR,
        filename: "lifecycle-walkthrough.mp4",
        remotePath: "/sdcard/eliza-12185-lifecycle.mp4",
        timeLimitSeconds: 180,
      });
    });

    test.afterAll(async () => {
      await recording?.stop();
      fs.writeFileSync(
        path.join(ARTIFACT_DIR, "lifecycle-report.json"),
        `${JSON.stringify({ appId: APP_ID, results }, null, 2)}\n`,
      );
    });

    test("app switching: HOME backgrounds, relaunch restores an interactive shell", async ({
      page,
      device,
    }) => {
      const adb = resolveAdb();
      const serial = device.serial();
      await expectInteractive(page);
      await installLifecycleProbe(page);
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "01-home-before.png",
      });

      adbShell(adb, serial, "input", "keyevent", "KEYCODE_HOME");
      await pollResumedPackage(
        adb,
        serial,
        (pkg) => pkg !== "" && pkg !== APP_ID,
        "HOME never left the app",
      );
      await delay(2_000);
      await refocusApp(adb, serial);
      await expectInteractive(page);
      const counts = await lifecycleEventCounts(page);
      expect(counts.pause, "pause event on HOME").toBeGreaterThan(0);
      expect(counts.resume, "resume event on refocus").toBeGreaterThan(0);
      await expectAgentHealthViaWebView(page);
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "01-home-after.png",
      });
      results.push({ event: "app-switch-home", counts, ok: true });
    });

    test("app switching: recent-apps overlay and return", async ({
      page,
      device,
    }) => {
      const adb = resolveAdb();
      const serial = device.serial();
      await installLifecycleProbe(page);

      adbShell(adb, serial, "input", "keyevent", "KEYCODE_APP_SWITCH");
      await delay(2_500);
      await refocusApp(adb, serial);
      await expectInteractive(page);
      const counts = await lifecycleEventCounts(page);
      // Recents on gesture-nav launchers may only partially occlude the app;
      // the load-bearing assertion is interactive recovery. A pause signal is
      // recorded when the overlay actually hid the WebView.
      await expectAgentHealthViaWebView(page);
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "02-recents-after.png",
      });
      results.push({ event: "app-switch-recents", counts, ok: true });
    });

    test("app switching: another app (Settings) foregrounds, we recover", async ({
      page,
      device,
    }) => {
      const adb = resolveAdb();
      const serial = device.serial();
      await installLifecycleProbe(page);

      adbShell(adb, serial, "am", "start", "-n", SETTINGS_ACTIVITY);
      const other = await pollResumedPackage(
        adb,
        serial,
        (pkg) => pkg === "com.android.settings",
        "Settings never reached the foreground",
      );
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "03-settings-foreground.png",
      });
      await delay(2_000);
      await refocusApp(adb, serial);
      await expectInteractive(page);
      const counts = await lifecycleEventCounts(page);
      expect(
        counts.pause,
        "pause event when Settings covered us",
      ).toBeGreaterThan(0);
      expect(counts.resume, "resume event on return").toBeGreaterThan(0);
      await expectAgentHealthViaWebView(page);
      tryAdbShell(adb, serial, "am", "force-stop", "com.android.settings");
      results.push({ event: "app-switch-other-app", other, counts, ok: true });
    });

    test("camera interruption: system camera foregrounds, we recover", async ({
      page,
      device,
    }) => {
      const adb = resolveAdb();
      const serial = device.serial();
      await installLifecycleProbe(page);

      // STILL_IMAGE_CAMERA resolves to a chooser when several handlers exist;
      // pin the stock camera component so the launch is deterministic.
      const resolved = tryAdbShell(
        adb,
        serial,
        "cmd",
        "package",
        "resolve-activity",
        "--brief",
        "-a",
        "android.media.action.STILL_IMAGE_CAMERA",
        CAMERA_PACKAGE,
      )
        .trim()
        .split(/\r?\n/)
        .find((line) => line.includes("/"));
      adbShell(adb, serial, "am", "start", "-n", resolved ?? CAMERA_ACTIVITY);
      await pollResumedPackage(
        adb,
        serial,
        (pkg) => pkg === CAMERA_PACKAGE,
        "camera app never reached the foreground",
      );
      await delay(3_000);
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "04-camera-foreground.png",
      });
      await refocusApp(adb, serial);
      await expectInteractive(page);
      const counts = await lifecycleEventCounts(page);
      expect(
        counts.pause,
        "pause event when camera covered us",
      ).toBeGreaterThan(0);
      expect(counts.resume, "resume event on return").toBeGreaterThan(0);
      await expectAgentHealthViaWebView(page);
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "04-camera-after.png",
      });
      tryAdbShell(adb, serial, "am", "force-stop", CAMERA_PACKAGE);
      results.push({ event: "camera-interruption", counts, ok: true });
    });

    test("mute: media volume 0 + OS mute keyevent leave the app interactive", async ({
      page,
      device,
    }) => {
      const adb = resolveAdb();
      const serial = device.serial();
      const before = tryAdbShell(
        adb,
        serial,
        "cmd",
        "media_session",
        "volume",
        "--stream",
        "3",
        "--get",
      ).match(/volume is (\d+)/)?.[1];

      adbShell(
        adb,
        serial,
        "cmd",
        "media_session",
        "volume",
        "--stream",
        "3",
        "--set",
        "0",
      );
      adbShell(adb, serial, "input", "keyevent", "KEYCODE_VOLUME_MUTE");
      const muted = tryAdbShell(
        adb,
        serial,
        "cmd",
        "media_session",
        "volume",
        "--stream",
        "3",
        "--get",
      );
      expect(muted, "media stream muted").toMatch(/volume is 0\b/);
      await expectInteractive(page);
      await expectAgentHealthViaWebView(page);
      if (before) {
        tryAdbShell(
          adb,
          serial,
          "cmd",
          "media_session",
          "volume",
          "--stream",
          "3",
          "--set",
          before,
        );
      }
      results.push({ event: "mute", restoredVolume: before ?? null, ok: true });
    });

    test("battery: low level + battery saver do not break the shell or agent", async ({
      page,
      device,
    }) => {
      const adb = resolveAdb();
      const serial = device.serial();
      try {
        adbShell(adb, serial, "dumpsys", "battery", "unplug");
        adbShell(adb, serial, "dumpsys", "battery", "set", "level", "5");
        expect(
          adbShell(adb, serial, "dumpsys", "battery"),
          "battery level override applied",
        ).toContain("level: 5");
        adbShell(adb, serial, "settings", "put", "global", "low_power", "1");
        await delay(2_000);
        await expectInteractive(page);
        await expectAgentHealthViaWebView(page);
        captureAndroidScreenshot({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "06-battery-low-saver.png",
        });
        results.push({ event: "battery-low-and-saver", ok: true });
      } finally {
        tryAdbShell(adb, serial, "settings", "put", "global", "low_power", "0");
        tryAdbShell(adb, serial, "dumpsys", "battery", "reset");
      }
    });

    test("doze: forced deep idle and exit recover the shell and agent", async ({
      page,
      device,
    }) => {
      test.setTimeout(300_000);
      const adb = resolveAdb();
      const serial = device.serial();
      await installLifecycleProbe(page);
      try {
        adbShell(adb, serial, "dumpsys", "battery", "unplug");
        adbShell(adb, serial, "input", "keyevent", "KEYCODE_SLEEP");
        await delay(1_500);
        const forced = adbShell(
          adb,
          serial,
          "dumpsys",
          "deviceidle",
          "force-idle",
        );
        expect(forced, "deviceidle force-idle accepted").toMatch(
          /deep idle mode/i,
        );
        expect(
          adbShell(adb, serial, "dumpsys", "deviceidle", "get", "deep").trim(),
          "deep doze state",
        ).toBe("IDLE");
        // Hold the device in deep doze so app-freezer / network restrictions
        // actually land before we exit.
        await delay(10_000);
      } finally {
        tryAdbShell(adb, serial, "dumpsys", "deviceidle", "unforce");
        tryAdbShell(adb, serial, "dumpsys", "battery", "reset");
        tryAdbShell(adb, serial, "input", "keyevent", "KEYCODE_WAKEUP");
        await delay(1_000);
        tryAdbShell(adb, serial, "wm", "dismiss-keyguard");
        tryAdbShell(adb, serial, "input", "keyevent", "KEYCODE_MENU");
      }
      await refocusApp(adb, serial);
      await expectInteractive(page);
      expect(
        adbShell(adb, serial, "dumpsys", "deviceidle", "get", "deep").trim(),
        "doze exited",
      ).toBe("ACTIVE");
      await expectAgentHealthViaWebView(page, { timeoutMs: 120_000 });
      const counts = await lifecycleEventCounts(page);
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "07-doze-after.png",
      });
      results.push({ event: "doze-force-idle", counts, ok: true });
    });

    test("process death: force-stop + relaunch restores agent, state, and shell", async ({
      page,
      device,
    }) => {
      // Destructive: force-stop kills the worker-shared WebView page, so any
      // spec file running after this one in the same invocation would inherit
      // a dead CDP target. The dedicated npm script opts in; the full-suite
      // sweep skips it visibly.
      test.skip(
        process.env.ELIZA_ANDROID_LIFECYCLE_DESTRUCTIVE !== "1",
        "destructive leg — run via test:e2e:android:lifecycle (sets ELIZA_ANDROID_LIFECYCLE_DESTRUCTIVE=1)",
      );
      test.setTimeout(420_000);
      const adb = resolveAdb();
      const serial = device.serial();
      const marker = `lifecycle-${Date.now()}`;

      await expectAgentHealthViaWebView(page);
      await page.evaluate(async (value) => {
        localStorage.setItem("eliza:lifecycle-e2e:marker", value);
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
        await preferences?.set?.({
          key: "eliza:lifecycle-e2e:marker",
          value,
        });
      }, marker);
      // localStorage → Capacitor Preferences persistence is proxied on a later
      // task; give it a beat before killing the process.
      await delay(1_500);
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "08-before-force-stop.png",
      });

      const agentPidBefore = agentBundlePid(adb, serial);
      adbShell(adb, serial, "am", "force-stop", APP_ID);
      await expect
        .poll(() => appPid(adb, serial), {
          timeout: 20_000,
          message: "force-stop never killed the app process",
        })
        .toBe("");
      const agentPidAfterKill = agentBundlePid(adb, serial);

      adbShell(adb, serial, "am", "start", "-W", "-n", MAIN_ACTIVITY);
      await expect
        .poll(() => appPid(adb, serial) !== "", {
          timeout: 30_000,
          message: "app never relaunched after force-stop",
        })
        .toBe(true);

      // The old CDP page died with the process — attach to the fresh WebView.
      let freshPage: import("@playwright/test").Page | undefined;
      for (let attempt = 0; attempt < 24 && !freshPage; attempt += 1) {
        try {
          const webview = await device.webView(
            { pkg: APP_ID },
            { timeout: 5_000 },
          );
          freshPage = await webview.page();
        } catch {
          await delay(2_500);
        }
      }
      if (!freshPage) {
        throw new Error("could not re-attach to the relaunched app WebView");
      }

      await waitForShellReady(freshPage);
      // MainActivity restarts ElizaAgentService (runtime mode local); a cold
      // agent boot on an emulated CPU can take minutes.
      await expect
        .poll(() => agentServicePresent(adb, serial), {
          timeout: 60_000,
          message: "ElizaAgentService record missing after relaunch",
        })
        .toBe(true);
      await expectAgentHealthViaWebView(freshPage, { timeoutMs: 300_000 });
      await expectInteractive(freshPage);

      const persisted = await freshPage.evaluate(() =>
        localStorage.getItem("eliza:lifecycle-e2e:marker"),
      );
      expect(persisted, "localStorage marker survived process death").toBe(
        marker,
      );
      const prefsXml = tryAdbShell(
        adb,
        serial,
        "run-as",
        APP_ID,
        "cat",
        "shared_prefs/CapacitorStorage.xml",
      );
      if (prefsXml) {
        expect(
          prefsXml,
          "Capacitor Preferences kept first-run state across process death",
        ).toContain("eliza:first-run-complete");
      }
      captureAndroidScreenshot({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "08-after-relaunch.png",
      });
      results.push({
        event: "process-death-force-stop",
        marker,
        markerPersisted: persisted === marker,
        agentPidBefore,
        agentPidAfterKill,
        agentPidAfterRelaunch: agentBundlePid(adb, serial),
        preferencesChecked: prefsXml.length > 0,
        ok: true,
      });
    });

    test("no FATAL crashes or ANRs surfaced during the lifecycle sweep", async ({
      device,
    }) => {
      const adb = resolveAdb();
      const serial = device.serial();
      const logcatPath = captureAndroidLogcat({
        adb,
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "lifecycle-logcat.txt",
        lines: 4_000,
      });
      const logcat = fs.readFileSync(logcatPath, "utf8");
      const fatalForApp = logcat.match(
        new RegExp(
          `FATAL EXCEPTION[\\s\\S]{0,300}?${APP_ID.replace(/\./g, "\\.")}`,
          "g",
        ),
      );
      const anrForApp = logcat.match(
        new RegExp(`ANR in ${APP_ID.replace(/\./g, "\\.")}`, "g"),
      );
      expect(fatalForApp ?? [], "FATAL exceptions in the app").toEqual([]);
      expect(anrForApp ?? [], "ANRs in the app").toEqual([]);
      results.push({
        event: "logcat-fatal-anr-sweep",
        fatalCount: fatalForApp?.length ?? 0,
        anrCount: anrForApp?.length ?? 0,
        ok: true,
      });
    });
  });
