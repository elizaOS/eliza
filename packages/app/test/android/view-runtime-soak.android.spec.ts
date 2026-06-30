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
  captureAndroidScreenshot,
  startAndroidScreenRecord,
} from "../../scripts/lib/android-capture.mjs";
import { resolveAdb } from "../../scripts/lib/android-device.mjs";
import { expect, test, waitForShellReady } from "./android-harness";

const API = process.env.API ?? "http://127.0.0.1:31337";
const ROUNDS = Number(process.env.ELIZA_ANDROID_VIEW_SOAK_ROUNDS ?? 4);
const APP_ID = "ai.elizaos.app";
const FIRST_RUN_REMOTE_DEEPLINK = `elizaos://first-run/runtime/remote?api=${encodeURIComponent(
  API,
)}`;
const ARTIFACT_DIR = path.resolve(
  process.cwd(),
  "..",
  "..",
  ".github",
  "issue-evidence",
  "10196-views-state",
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

async function ensureHomeShell(
  page: import("@playwright/test").Page,
): Promise<void> {
  const firstRunVisible = await page
    .getByTestId("first-run-runtime-chooser")
    .isVisible()
    .catch(() => false);
  if (!firstRunVisible) {
    await expect(page.getByTestId("home-launcher-surface")).toBeVisible({
      timeout: 60_000,
    });
    return;
  }
  await expect(page.getByTestId("home-launcher-surface")).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 60_000,
  });
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
        window.__ELIZA_RENDER_TELEMETRY__ = [];
        window.__ELIZA_MODULE_CACHE_TELEMETRY__ = [];
        window.__ELIZA_VIEW_RUNTIME_TELEMETRY__ = [];
      });
      if (
        await page
          .getByTestId("first-run-runtime-chooser")
          .isVisible()
          .catch(() => false)
      ) {
        startDeepLink(adb, serial, FIRST_RUN_REMOTE_DEEPLINK);
      }
      await ensureHomeShell(page);
      await page.evaluate(() => {
        window.__ELIZA_RENDER_TELEMETRY__ = [];
        window.__ELIZA_MODULE_CACHE_TELEMETRY__ = [];
        window.__ELIZA_VIEW_RUNTIME_TELEMETRY__ = [];
      });
      await waitForShellReady(page);

      const drain = async (): Promise<SoakTelemetry> =>
        page.evaluate(() => {
          const vr = window.__ELIZA_VIEW_RUNTIME_TELEMETRY__ ?? [];
          const mc = window.__ELIZA_MODULE_CACHE_TELEMETRY__ ?? [];
          const render = window.__ELIZA_RENDER_TELEMETRY__ ?? [];
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
              await page.screenshot({
                path: path.join(
                  ARTIFACT_DIR,
                  `android-fresh-view-${String(screenshotCount).padStart(2, "0")}-${view.id}.png`,
                ),
                fullPage: true,
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
        await page.screenshot({
          path: path.join(ARTIFACT_DIR, "android-fresh-view-soak-final.png"),
          fullPage: true,
        });
        captureAndroidScreenshot({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "android-fresh-device-final.png",
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
        expect(
          after.maxRenderCount,
          "view render count telemetry",
        ).toBeGreaterThan(0);
        expect(after.maxRenderCount, "no per-view render storm").toBeLessThan(
          400,
        );
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
