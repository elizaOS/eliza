// Long seeded launcher gesture loop on the REAL on-device Android WebView
// (#12377, WI-8 of #12179). Where touch-gesture.android.spec.ts proves ONE
// home→launcher rail swipe delivers real touch input, this spec runs ≥200 real
// device actions — `adb shell input swipe`/`tap` gestures, not synthesized DOM
// events — from a seeded, replayable action stream and checks the launcher's rail
// invariants after every action. It is the device-lane counterpart to the web
// fast-check loop (#12373/#12375), scoped to the state observable through the
// WebView: `data-page`, the sr-only AX probe, page-half inertness, and focus.
//
// Recording: `adb screenrecord` caps a single file at 180s, so the loop rotates
// screenrecord segments (android-launcher-loop-01.mp4, -02.mp4, …) and attaches
// every segment plus logcat. The seed is printed and honored via ELIZA_LOOP_SEED
// so any failure replays the exact gesture sequence.
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
import {
  generateLauncherLoop,
  type LauncherLoopAction,
  type LauncherPage,
  resolveLoopSeed,
} from "./launcher-loop-model";

const ISSUE_EVIDENCE_DIR = "12377-mobile-launcher-loops";
const HOST_AGENT_BASE = "http://127.0.0.1:31337";
// Below the 180s screenrecord cap with margin for the pull/rotate handshake.
const SEGMENT_SECONDS = 150;
const LOOP_ACTIONS = Number.parseInt(
  process.env.ELIZA_LOOP_ACTIONS ?? "200",
  10,
);

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
  "launcher-gesture-loop",
);

function writeJsonArtifact(filename: string, data: unknown) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const artifactPath = path.join(ARTIFACT_DIR, filename);
  fs.writeFileSync(artifactPath, `${JSON.stringify(data, null, 2)}\n`);
  return artifactPath;
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
      (
        window as Window & {
          __ELIZAOS_UI_APP_STORE__?: {
            value?: { setState?: (key: string, value: unknown) => void } | null;
          };
        }
      ).__ELIZAOS_UI_APP_STORE__?.value?.setState?.("firstRunComplete", true);
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
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await waitForShellReady(page);
  await markFirstRunComplete(page);
  await expect(page.getByTestId("first-run-runtime-chooser")).toBeHidden({
    timeout: 60_000,
  });
}

/** Collapse the chat sheet and park the rail on home before the loop starts. */
async function normalizeToHome(page: Page, adb: string, serial: string) {
  const overlay = page.getByTestId("continuous-chat-overlay");
  const surface = page.getByTestId("home-launcher-surface");
  await expect(surface).toBeVisible({ timeout: 60_000 });

  for (let i = 0; i < 4; i += 1) {
    if (
      (await overlay.getAttribute("data-open").catch(() => null)) !== "true"
    ) {
      break;
    }
    adbDevice(adb, serial, ["shell", "input", "keyevent", "KEYCODE_BACK"]);
    await page.waitForTimeout(600);
  }

  if ((await surface.getAttribute("data-page")) !== "home") {
    const box = await surface.boundingBox();
    if (box) {
      const metrics = await page.evaluate(() => ({
        dpr: window.devicePixelRatio || 1,
        offsetLeft: window.visualViewport?.offsetLeft ?? 0,
        offsetTop: window.visualViewport?.offsetTop ?? 0,
      }));
      // Swipe right (toward home) across most of the surface width.
      const y = Math.round(
        (box.y + box.height * 0.5 + metrics.offsetTop) * metrics.dpr,
      );
      const x0 = Math.round(
        (box.x + box.width * 0.2 + metrics.offsetLeft) * metrics.dpr,
      );
      const x1 = Math.round(
        (box.x + box.width * 0.85 + metrics.offsetLeft) * metrics.dpr,
      );
      adbDevice(adb, serial, [
        "shell",
        "input",
        "swipe",
        String(x0),
        String(y),
        String(x1),
        String(y),
        "220",
      ]);
    }
    await expect(surface).toHaveAttribute("data-page", "home", {
      timeout: 15_000,
    });
  }
}

interface DeviceMetrics {
  dpr: number;
  offsetLeft: number;
  offsetTop: number;
}

async function readMetrics(page: Page): Promise<DeviceMetrics> {
  return page.evaluate(() => ({
    dpr: window.devicePixelRatio || 1,
    offsetLeft: window.visualViewport?.offsetLeft ?? 0,
    offsetTop: window.visualViewport?.offsetTop ?? 0,
  }));
}

/** Convert a CSS-space point on the surface to a physical device pixel. */
function toDevice(
  box: { x: number; y: number; width: number; height: number },
  metrics: DeviceMetrics,
  fracX: number,
  fracY: number,
): { x: number; y: number } {
  return {
    x: Math.round(
      (box.x + box.width * fracX + metrics.offsetLeft) * metrics.dpr,
    ),
    y: Math.round(
      (box.y + box.height * fracY + metrics.offsetTop) * metrics.dpr,
    ),
  };
}

function adbSwipe(
  adb: string,
  serial: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number,
) {
  adbDevice(adb, serial, [
    "shell",
    "input",
    "swipe",
    String(from.x),
    String(from.y),
    String(to.x),
    String(to.y),
    String(durationMs),
  ]);
}

function adbTap(adb: string, serial: string, at: { x: number; y: number }) {
  adbDevice(adb, serial, ["shell", "input", "tap", String(at.x), String(at.y)]);
}

/** Drive one loop action as a real device gesture on the launcher surface. */
async function performAction(
  page: Page,
  adb: string,
  serial: string,
  action: LauncherLoopAction,
) {
  const surface = page.getByTestId("home-launcher-surface");
  const box = await surface.boundingBox();
  if (!box) throw new Error("home-launcher-surface has no bounding box");
  const metrics = await readMetrics(page);
  const midY = 0.55;

  switch (action.kind) {
    case "swipe-left":
      adbSwipe(
        adb,
        serial,
        toDevice(box, metrics, 0.85, midY),
        toDevice(box, metrics, 0.1, midY),
        180,
      );
      break;
    case "swipe-right":
      adbSwipe(
        adb,
        serial,
        toDevice(box, metrics, 0.15, midY),
        toDevice(box, metrics, 0.9, midY),
        180,
      );
      break;
    case "sub-threshold-swipe-left":
      // Short, well under the 50% commit distance → must snap back.
      adbSwipe(
        adb,
        serial,
        toDevice(box, metrics, 0.6, midY),
        toDevice(box, metrics, 0.42, midY),
        260,
      );
      break;
    case "sub-threshold-swipe-right":
      adbSwipe(
        adb,
        serial,
        toDevice(box, metrics, 0.4, midY),
        toDevice(box, metrics, 0.58, midY),
        260,
      );
      break;
    case "vertical-scroll":
      // Vertical drag on the active page — axis-locks to scroll, must not flip.
      adbSwipe(
        adb,
        serial,
        toDevice(box, metrics, 0.5, 0.7),
        toDevice(box, metrics, 0.5, 0.3),
        220,
      );
      break;
    case "tap-center":
      // Tap a neutral region (upper area, away from tiles/composer) — a bare tap
      // must never move the rail.
      adbTap(adb, serial, toDevice(box, metrics, 0.5, 0.2));
      break;
    default: {
      const exhaustive: never = action.kind;
      throw new Error(`unhandled action kind: ${String(exhaustive)}`);
    }
  }
}

interface InvariantResult {
  page: string | null;
  probe: string | null;
  homeInert: boolean;
  launcherInert: boolean;
  activeElementInInert: boolean;
}

/** Read the launcher's post-action state for the per-action invariant checks. */
async function readInvariants(page: Page): Promise<InvariantResult> {
  return page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(
      '[data-testid="home-launcher-surface"]',
    );
    const home = document.querySelector<HTMLElement>(
      '[data-testid="home-launcher-home-page"]',
    );
    const launcher = document.querySelector<HTMLElement>(
      '[data-testid="home-launcher-launcher-page"]',
    );
    const probeEl = document.querySelector<HTMLElement>(
      '[data-testid="home-launcher-page-probe"]',
    );
    const active = document.activeElement;
    return {
      page: surface?.getAttribute("data-page") ?? null,
      probe: probeEl?.textContent?.trim() ?? null,
      homeInert: home?.hasAttribute("inert") ?? false,
      launcherInert: launcher?.hasAttribute("inert") ?? false,
      activeElementInInert:
        active instanceof Element ? Boolean(active.closest("[inert]")) : false,
    };
  });
}

async function waitForExpectedPage(
  page: Page,
  expectedPage: LauncherPage,
): Promise<string | null> {
  const surface = page.getByTestId("home-launcher-surface");
  await expect
    .poll(() => surface.getAttribute("data-page"), { timeout: 10_000 })
    .toBe(expectedPage);
  return surface.getAttribute("data-page");
}

test.describe
  .serial("android launcher gesture loop (real WebView)", () => {
    test("seeded ≥200-action loop keeps the rail invariant on real device input", async ({
      page,
      device,
    }, testInfo) => {
      const totalActions = Math.max(LOOP_ACTIONS, 200);
      // Real device swipes are ~0.5s each; 200+ of them plus settle polls need a
      // long ceiling. Kept explicit so a slow emulator does not false-fail.
      test.setTimeout(20 * 60_000);

      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      const adb = resolveAdb();
      const serial = device.serial();
      const seed = resolveLoopSeed();
      const actions = generateLauncherLoop(seed, totalActions, "home");
      console.log(
        `[launcher-loop] seed=${seed} actions=${totalActions} ` +
          `(reproduce with ELIZA_LOOP_SEED=${seed})`,
      );

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

      const segmentPaths: string[] = [];
      let segmentIndex = 0;
      let recording = await startAndroidScreenRecord({
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: `android-launcher-loop-${String(++segmentIndex).padStart(2, "0")}.mp4`,
        remotePath: "/sdcard/eliza-launcher-loop.mp4",
        timeLimitSeconds: SEGMENT_SECONDS,
      });
      let segmentStartedAt = Date.now();

      async function rotateSegmentIfDue() {
        if ((Date.now() - segmentStartedAt) / 1000 < SEGMENT_SECONDS - 10) {
          return;
        }
        const finished = await recording.stop();
        if (finished) segmentPaths.push(finished);
        recording = await startAndroidScreenRecord({
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: `android-launcher-loop-${String(++segmentIndex).padStart(2, "0")}.mp4`,
          remotePath: "/sdcard/eliza-launcher-loop.mp4",
          timeLimitSeconds: SEGMENT_SECONDS,
        });
        segmentStartedAt = Date.now();
      }

      const failures: Array<{
        index: number;
        reason: string;
        state: InvariantResult;
      }> = [];

      try {
        await waitForShellReady(page);
        await page.evaluate(() => {
          localStorage.setItem("eliza:tutorial-autolaunched", "1");
          localStorage.setItem("eliza:tutorial:completed", "1");
        });
        await gotoRoute(page, "/");
        await completeFirstRunIfNeeded(page);
        await gotoRoute(page, "/");
        await normalizeToHome(page, adb, serial);

        let modelPage: LauncherPage = "home";
        let reportedPageErrors = 0;
        for (let i = 0; i < actions.length; i += 1) {
          const action = actions[i];
          await performAction(page, adb, serial, action);
          modelPage = action.expectedPageAfter;

          // The rail must converge to the modelled page. A committing swipe
          // flips it; a sub-threshold/scroll/tap must leave it where it was.
          const landed = await waitForExpectedPage(page, modelPage).catch(
            () => null,
          );
          const state = await readInvariants(page);

          const problems: string[] = [];
          if (landed !== modelPage) {
            problems.push(
              `data-page=${landed} expected=${modelPage} after ${action.kind}`,
            );
          }
          if (state.probe !== `home-launcher-page:${modelPage}`) {
            problems.push(
              `AX probe=${state.probe} expected=home-launcher-page:${modelPage}`,
            );
          }
          // Exactly one page-half is inert (the offscreen one).
          if (state.homeInert === state.launcherInert) {
            problems.push(
              `inert invariant broken: homeInert=${state.homeInert} launcherInert=${state.launcherInert}`,
            );
          } else {
            const inertIsOffscreen =
              modelPage === "home" ? state.launcherInert : state.homeInert;
            if (!inertIsOffscreen) {
              problems.push(
                `wrong half inert for page=${modelPage} (home=${state.homeInert} launcher=${state.launcherInert})`,
              );
            }
          }
          if (state.activeElementInInert) {
            problems.push("focus escaped into an [inert] offscreen half");
          }
          // A page error at any point fails the run, but record each new one
          // once rather than re-reporting the accumulated list every action.
          if (pageErrors.length > reportedPageErrors) {
            problems.push(
              `page error(s): ${pageErrors.slice(reportedPageErrors).join(" | ")}`,
            );
            reportedPageErrors = pageErrors.length;
          }

          if (problems.length > 0) {
            failures.push({ index: i, reason: problems.join("; "), state });
          }

          await rotateSegmentIfDue();
        }

        if (pageErrors.length > reportedPageErrors) {
          failures.push({
            index: actions.length,
            reason: `page error(s) after final action: ${pageErrors
              .slice(reportedPageErrors)
              .join(" | ")}`,
            state: await readInvariants(page),
          });
        }

        writeJsonArtifact("android-launcher-loop-summary.json", {
          issue: 12377,
          serial,
          seed,
          reproduce: `ELIZA_LOOP_SEED=${seed}`,
          totalActions: actions.length,
          finalPage: modelPage,
          failures,
          segments: segmentPaths.map((p) => path.basename(p)),
        });

        const shot = captureAndroidScreenshot({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "android-launcher-loop-final.png",
        });
        await testInfo.attach("Android launcher loop final state", {
          path: shot,
          contentType: "image/png",
        });

        expect(
          failures,
          `launcher loop invariants held across ${actions.length} real device ` +
            `actions (seed=${seed}); first failures: ${failures
              .slice(0, 5)
              .map((f) => `#${f.index}: ${f.reason}`)
              .join(" || ")}`,
        ).toHaveLength(0);
      } finally {
        const finished = await recording.stop().catch(() => null);
        if (finished) segmentPaths.push(finished);
        for (const segment of segmentPaths) {
          await testInfo
            .attach(`Android launcher loop ${path.basename(segment)}`, {
              path: segment,
              contentType: "video/mp4",
            })
            .catch(() => {});
        }

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
          lines: 1200,
        });
        await testInfo.attach("Android logcat", {
          path: logcatPath,
          contentType: "text/plain",
        });
      }
    });
  });
