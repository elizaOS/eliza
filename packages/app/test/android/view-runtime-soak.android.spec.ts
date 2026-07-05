// Android companion to `scripts/audit-views-soak.mjs` for #10196.
//
// This drives the real installed Capacitor WebView against the deterministic
// host agent (`ELIZA_ANDROID_BACKEND=host`), enumerates the live `/api/views`
// catalog, activates each view through the app's `eliza:navigate:view` channel,
// then drains the real view-runtime and module-cache telemetry rings.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  captureAndroidLogcat,
  startAndroidScreenRecord,
} from "../../scripts/lib/android-capture.mjs";
import { resolveAdb } from "../../scripts/lib/android-device.mjs";
import { expect, ORIGIN, test, waitForShellReady } from "./android-harness";

const API = process.env.API ?? "http://127.0.0.1:31337";
const ROUNDS = Number(process.env.ELIZA_ANDROID_VIEW_SOAK_ROUNDS ?? 4);
const APP_ID = "ai.elizaos.app";
const FIRST_RUN_REMOTE_DEEPLINK = `elizaos://first-run/runtime/remote?api=${encodeURIComponent(
  API,
)}`;
const ARTIFACT_DIR = path.resolve(
  process.env.ELIZA_ANDROID_ARTIFACT_DIR ??
    path.join(
      process.cwd(),
      "..",
      "..",
      ".github",
      "issue-evidence",
      "10196-views-state",
    ),
  "view-runtime-soak",
);

interface ViewCatalogEntry {
  id: string;
  name?: string;
  path?: string;
  viewKind?: string;
}

interface SoakTelemetry {
  viewRuntime: number;
  shows: number;
  hides: number;
  viewEvicts: number;
  maxRenderCount: number;
  module: number;
  moduleEvicts: number;
  render: number;
}

interface ViewRuntimeTelemetryEvent {
  reason?: string;
  renderCount?: number;
}

interface ModuleCacheTelemetryEvent {
  action?: string;
}

interface TelemetryWindow extends Window {
  __ELIZA_RENDER_TELEMETRY__?: unknown[];
  __ELIZA_MODULE_CACHE_TELEMETRY__?: ModuleCacheTelemetryEvent[];
  __ELIZA_VIEW_RUNTIME_TELEMETRY__?: ViewRuntimeTelemetryEvent[];
}

function captureSoakScreenshot({
  adb,
  serial,
  filename,
  screenshotErrors,
}: {
  adb: string;
  serial: string;
  filename: string;
  screenshotErrors: string[];
}): void {
  try {
    const png = execFileSync(
      adb,
      ["-s", serial, "exec-out", "screencap", "-p"],
      {
        maxBuffer: 12 * 1024 * 1024,
        timeout: 10_000,
      },
    );
    if (!png.length) {
      throw new Error("adb screencap returned no bytes");
    }
    fs.writeFileSync(path.join(ARTIFACT_DIR, filename), png);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    screenshotErrors.push(`${filename}: adb screencap failed: ${message}`);
  }
}

async function fetchViews(): Promise<ViewCatalogEntry[]> {
  const response = await fetch(`${API}/api/views`, {
    headers: { "X-ElizaOS-Client-Id": "android-view-runtime-soak" },
  });
  if (!response.ok) {
    throw new Error(
      `/api/views failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as { views?: ViewCatalogEntry[] };
  return (body.views ?? []).filter((view) => view.id && view.path);
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
    headers: { "X-ElizaOS-Client-Id": "android-view-runtime-soak" },
  }).then((response) => response.json() as Promise<{ complete?: boolean }>);
  if (status.complete === true) return;

  const response = await fetch(`${API}/api/first-run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-ElizaOS-Client-Id": "android-view-runtime-soak",
    },
    body: JSON.stringify({ name: "Android View Soak Agent" }),
  });
  if (!response.ok) {
    throw new Error(
      `/api/first-run failed: ${response.status} ${response.statusText}`,
    );
  }
}

async function ensureHomeShell(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(async () => {
    localStorage.setItem("eliza:first-run-complete", "1");
    localStorage.setItem("eliza:onboarding-complete", "1");
    (
      window as Window & {
        __ELIZAOS_UI_APP_STORE__?: {
          value?: {
            setState?: (key: string, value: unknown) => void;
          } | null;
        };
      }
    ).__ELIZAOS_UI_APP_STORE__?.value?.setState?.("firstRunComplete", true);
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  });
  await expect(
    page.locator(
      '[data-testid="first-run-runtime-chooser"], [data-testid="startup-first-run-background"]',
    ),
  ).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("home-launcher-surface")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 60_000,
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
  await expect(page.getByTestId("home-launcher-surface")).toHaveCount(0, {
    timeout: 30_000,
  });

  startDeepLink(adb, serial, FIRST_RUN_REMOTE_DEEPLINK);
  await ensureHomeShell(page);
}

test.describe
  .serial("android view-runtime soak (real WebView)", () => {
    test("churns registered views with bounded telemetry and heap", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(360_000);

      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      const adb = resolveAdb();
      const serial = device.serial();
      const views = await fetchViews();
      expect(
        views.length,
        "registered `/api/views` catalog",
      ).toBeGreaterThanOrEqual(10);
      await ensureHostFirstRunComplete();

      const packageInfo = execFileSync(
        adb,
        ["-s", serial, "shell", "dumpsys", "package", APP_ID],
        { encoding: "utf8" },
      );
      fs.writeFileSync(
        path.join(ARTIFACT_DIR, "android-fresh-package.txt"),
        packageInfo,
      );

      await page.addInitScript(() => {
        const telemetryWindow = window as TelemetryWindow;
        telemetryWindow.__ELIZA_RENDER_TELEMETRY__ = [];
        telemetryWindow.__ELIZA_MODULE_CACHE_TELEMETRY__ = [];
        telemetryWindow.__ELIZA_VIEW_RUNTIME_TELEMETRY__ = [];
      });
      await page.goto(ORIGIN, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      if (await isFirstRunShowing(page)) {
        await connectHostRuntimeViaDeepLink({ adb, serial, page });
      }
      await ensureHomeShell(page);
      await page.evaluate(() => {
        const telemetryWindow = window as TelemetryWindow;
        telemetryWindow.__ELIZA_RENDER_TELEMETRY__ = [];
        telemetryWindow.__ELIZA_MODULE_CACHE_TELEMETRY__ = [];
        telemetryWindow.__ELIZA_VIEW_RUNTIME_TELEMETRY__ = [];
      });
      await waitForShellReady(page);

      const drain = async (): Promise<SoakTelemetry> =>
        page.evaluate(() => {
          const telemetryWindow = window as TelemetryWindow;
          const vr = telemetryWindow.__ELIZA_VIEW_RUNTIME_TELEMETRY__ ?? [];
          const mc = telemetryWindow.__ELIZA_MODULE_CACHE_TELEMETRY__ ?? [];
          const render = telemetryWindow.__ELIZA_RENDER_TELEMETRY__ ?? [];
          const maxRender = vr.reduce(
            (max, event) => Math.max(max, event.renderCount ?? 0),
            0,
          );
          return {
            viewRuntime: vr.length,
            shows: vr.filter((event) => event.reason === "show").length,
            hides: vr.filter((event) => event.reason === "hide").length,
            viewEvicts: vr.filter((event) => event.reason === "evict").length,
            maxRenderCount: maxRender,
            module: mc.length,
            moduleEvicts: mc.filter((event) => event.action === "evict").length,
            render: render.length,
          };
        });
      const heap = async (): Promise<number> =>
        page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
      const navigateView = async (view: ViewCatalogEntry) => {
        await page.evaluate(
          (detail) => {
            window.dispatchEvent(
              new CustomEvent("eliza:navigate:view", { detail }),
            );
          },
          { viewId: view.id, viewPath: view.path },
        );
        await page.waitForTimeout(700);
      };

      const recording = await startAndroidScreenRecord({
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "android-fresh-view-soak.mp4",
        remotePath: "/sdcard/eliza-10196-view-soak.mp4",
        timeLimitSeconds: 180,
      });

      const pageErrors: string[] = [];
      const screenshotErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      const before = await drain();
      const heapSamples = [await heap()];
      let screenshotCount = 0;

      try {
        for (let round = 0; round < ROUNDS; round += 1) {
          for (const view of views) {
            await navigateView(view);
            if (
              round === 0 &&
              screenshotCount < 4 &&
              (view.viewKind === "system" || view.viewKind === "developer")
            ) {
              screenshotCount += 1;
              captureSoakScreenshot({
                adb,
                serial,
                filename: `android-fresh-view-${String(screenshotCount).padStart(2, "0")}-${view.id}.png`,
                screenshotErrors,
              });
            }
          }
          await page.evaluate(() => window.gc?.()).catch(() => undefined);
          heapSamples.push(await heap());
        }

        const after = await drain();
        const heapWarm = heapSamples[1] ?? heapSamples[0] ?? 0;
        const heapEnd = heapSamples.at(-1) ?? 0;
        const heapRatio = heapEnd / Math.max(1, heapWarm);
        const report = {
          benchmark: "android view-runtime real WebView soak",
          api: API,
          serial,
          rounds: ROUNDS,
          views: views.length,
          activations: ROUNDS * views.length,
          viewKinds: views.reduce<Record<string, number>>((acc, view) => {
            const kind = view.viewKind ?? "unknown";
            acc[kind] = (acc[kind] ?? 0) + 1;
            return acc;
          }, {}),
          telemetry: { before, after },
          heap: {
            samples: heapSamples,
            warmBytes: heapWarm,
            endBytes: heapEnd,
            boundedRatio: heapRatio,
          },
          pageErrors,
          screenshotErrors,
        };
        const reportPath = path.join(
          ARTIFACT_DIR,
          "android-fresh-view-soak.json",
        );
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        await testInfo.attach("android view soak report", {
          path: reportPath,
          contentType: "application/json",
        });
        captureSoakScreenshot({
          adb,
          serial,
          filename: "android-fresh-view-soak-final.png",
          screenshotErrors,
        });
        captureSoakScreenshot({
          adb,
          serial,
          filename: "android-fresh-device-final.png",
          screenshotErrors,
        });
        captureAndroidLogcat({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "android-fresh-logcat.txt",
          lines: 800,
        });

        expect(after.shows, "view-runtime show telemetry").toBeGreaterThan(
          before.shows,
        );
        expect(after.render, "render telemetry ring grew").toBeGreaterThan(
          before.render,
        );
        expect(
          after.render - before.render,
          "no render telemetry storm",
        ).toBeLessThan(400);
        if (after.maxRenderCount > 0) {
          expect(after.maxRenderCount, "no per-view render storm").toBeLessThan(
            400,
          );
        }
        expect(
          after.viewEvicts > 0 || after.moduleEvicts > 0,
          "bounded view/module caches evicted under churn",
        ).toBe(true);
        expect(
          heapEnd === 0 || heapRatio < 2.2,
          "heap stayed bounded across Android view churn",
        ).toBe(true);
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
          await testInfo.attach("android view soak screenrecord", {
            path: videoPath,
            contentType: "video/mp4",
          });
        }
      }
    });
  });
