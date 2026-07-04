/**
 * Packaged-desktop launcher smoke (#12179 WI-7).
 *
 * The web/mobile launcher gesture LOOP runs against the identical renderer
 * bundle in the Chromium ui-smoke lane — Electrobun ships that same bundle, and
 * its system WebView (WKWebView / WebKitGTK) exposes no CDP surface for trusted
 * touch synthesis (issue #12179 prior-art §5). So the packaged binary does not
 * get gesture synthesis; it gets this thin smoke instead: drive the single
 * source-of-truth shell-surface store (`goLauncher()` / `goHome()`) through the
 * bridge `eval` seam, assert the rail flips (`data-page` + the AX-probe static
 * text the native lanes read), and screenshot both states non-blank.
 *
 * Reuses the same packaged harness + non-blank screenshot assertion as
 * `desktop-launch-render.e2e.spec.ts`; requires a prebuilt Electrobun binary and
 * the headless env from `packaged-app-helpers` (see
 * playwright.electrobun.packaged.config.ts).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { assertScreenshotNotBlank } from "../ui-smoke/helpers/screenshot-quality";
import { type MockApiServer, startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

const SURFACE = '[data-testid="home-launcher-surface"]';
const PROBE = '[data-testid="home-launcher-page-probe"]';

type EvalOk<T> = T & { ok: true };
type EvalErr = { ok: false; error: string };
type EvalResult<T> = EvalOk<T> | EvalErr;

interface SurfaceRead {
  mounted: boolean;
  dataPage: string | null;
  axProbe: string | null;
}

/**
 * Route the shell to `/apps` so `HomeScreenMount` mounts the HomeLauncherSurface
 * (App.tsx maps the apps tab to the launcher half). Belt-and-suspenders: set the
 * hash AND push + fire popstate so whichever navigation mode the packaged shell
 * uses picks it up.
 */
async function mountLauncherSurface(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await harness.eval<EvalResult<Record<string, never>>>(`(() => {
    try {
      try { window.location.hash = "#/apps"; } catch (_) {}
      try {
        window.history.pushState(null, "", "/apps");
        window.dispatchEvent(new PopStateEvent("popstate"));
      } catch (_) {}
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })()`);
}

/** Read the observable surface state (mount + data-page + AX probe text). */
async function readSurface(
  harness: PackagedDesktopHarness,
): Promise<SurfaceRead> {
  const result = await harness.eval<EvalResult<SurfaceRead>>(`(() => {
    try {
      const surface = document.querySelector('${SURFACE}');
      const probe = document.querySelector('${PROBE}');
      return {
        ok: true,
        mounted: Boolean(surface),
        dataPage: surface ? surface.getAttribute("data-page") : null,
        axProbe: probe ? (probe.textContent || "").trim() : null,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })()`);
  if (!result.ok) throw new Error(`readSurface eval failed: ${result.error}`);
  return result;
}

/**
 * Flip the rail by driving the imperative store action — the SAME single source
 * of truth (`shell-surface-store`) the gesture handlers call. Reached through
 * the module-global the store publishes on `globalThis` (survives HMR, callable
 * from non-React code); the eval bundle has no ESM import seam.
 */
async function flip(
  harness: PackagedDesktopHarness,
  page: "home" | "launcher",
): Promise<void> {
  const result = await harness.eval<
    EvalResult<{ committed: boolean }>
  >(`(() => {
    try {
      const store = globalThis[Symbol.for("elizaos.ui.shell-surface-store")];
      if (!store) return { ok: false, error: "shell-surface-store not on globalThis" };
      store.state = { page: ${JSON.stringify(page)} };
      for (const l of store.listeners) l();
      return { ok: true, committed: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })()`);
  if (!result.ok) throw new Error(`flip(${page}) eval failed: ${result.error}`);
}

/** Poll the DOM until it reflects the requested page (React commit is async). */
async function expectPage(
  harness: PackagedDesktopHarness,
  page: "home" | "launcher",
): Promise<void> {
  await expect
    .poll(async () => (await readSurface(harness)).dataPage, {
      timeout: 15_000,
      message: `Expected the packaged rail to settle on data-page="${page}".`,
    })
    .toBe(page);
  const state = await readSurface(harness);
  expect(state.axProbe, "AX probe mirrors data-page for the native lanes").toBe(
    `home-launcher-page:${page}`,
  );
}

async function shotNotBlank(
  harness: PackagedDesktopHarness,
  outPath: string,
  label: string,
): Promise<void> {
  const data = await harness.screenshot();
  const buffer = Buffer.from(
    data.replace(/^data:image\/png;base64,/, ""),
    "base64",
  );
  await fs.writeFile(outPath, buffer);
  await assertScreenshotNotBlank(buffer, label);
}

test("packaged desktop launcher: store flips the rail (data-page + AX probe) non-blank", async ({
  browserName: _browserName,
}, testInfo) => {
  void _browserName;
  test.setTimeout(600_000);

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-desktop-launcher-smoke-"),
  );
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  );
  expect(
    launcherPath,
    "Packaged Electrobun launcher is required (run the desktop build first).",
  ).toBeTruthy();

  let api: MockApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  try {
    api = await startMockApiServer({ firstRunComplete: true, port: 0 });
    harness = new PackagedDesktopHarness({
      tempRoot,
      launcherPath: launcherPath as string,
      apiBase: api.baseUrl,
    });
    await harness.start({
      bridgeHealthTimeoutMs: 300_000,
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 90_000,
    });
    await harness.setMainWindowBounds({ x: 0, y: 0, width: 1240, height: 860 });
    await harness.showMainWindow();
    await harness.focusMainWindow();
    await harness.waitForState(
      (state) => state.shell.windowVisible,
      "Expected packaged desktop window to be visible before driving the rail.",
      30_000,
    );

    // Mount the HomeLauncherSurface (the resting desktop shell is the chromeless
    // bottom bar; the launcher half mounts on the /apps route).
    const activeHarness = harness;
    await mountLauncherSurface(activeHarness);
    await expect
      .poll(async () => (await readSurface(activeHarness)).mounted, {
        timeout: 30_000,
        message:
          "Expected HomeLauncherSurface to mount after routing to /apps.",
      })
      .toBe(true);

    // goLauncher(): rail on the launcher half.
    await flip(harness, "launcher");
    await expectPage(harness, "launcher");
    await shotNotBlank(
      harness,
      testInfo.outputPath("desktop-launcher-launcher.png"),
      "packaged desktop launcher (launcher half)",
    );

    // goHome(): rail back on the home half.
    await flip(harness, "home");
    await expectPage(harness, "home");
    await shotNotBlank(
      harness,
      testInfo.outputPath("desktop-launcher-home.png"),
      "packaged desktop launcher (home half)",
    );
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});
