/**
 * Minimal packaged-desktop launch + render e2e.
 *
 * The heavier `electrobun-packaged-regressions` suite exercises shell relaunch /
 * state-persistence choreography (renderer-eval seeding, multiple relaunches),
 * which is sensitive to the bridge eval RPC + a network-reachable registry. This
 * spec covers the platform-level invariant those tests presuppose and that
 * matters most for the decomposed app: the PACKAGED DESKTOP app (Electrobun +
 * WebKitGTK) actually launches and renders a non-blank UI headlessly on Linux.
 *
 * It uses the native bridge state (`harness.start()` waits for the main window +
 * tray via the bridge `/state` snapshot) plus a light renderer-DOM assertion.
 * The default surface is a transparent chromeless overlay (#16200), so instead
 * of an OS-pixel non-blank check (which a mostly-transparent window fails by
 * design) it summons the overlay and asserts the singular chat surface + live
 * composer actually mounted — the meaningful "the app painted a real UI" signal.
 * A screenshot is still captured as a review artifact. The same React bundle
 * (and thus the decomposed lifeops views) renders here as in the web + mobile
 * e2e lanes.
 *
 * Requires a prebuilt Electrobun binary (see playwright.electrobun.packaged.config.ts)
 * and, on a GPU-less host, the headless env from packaged-app-helpers (xvfb +
 * WEBKIT_DISABLE_SANDBOX + software GL) plus a screenshot tool on PATH.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { type MockApiServer, startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

type EvalOk<T> = T & { ok: true };
type EvalErr = { ok: false; error: string };
type EvalResult<T> = EvalOk<T> | EvalErr;

async function waitForRendererShellReady(
  harness: PackagedDesktopHarness,
): Promise<void> {
  let lastResult:
    | EvalResult<{
        ready: boolean;
        rootLength: number;
        bodySnippet: string;
        startupPhase: string | null;
      }>
    | undefined;
  let lastError: Error | null = null;

  try {
    await expect
      .poll(
        async () => {
          try {
            lastResult = await harness.eval<
              EvalResult<{
                ready: boolean;
                rootLength: number;
                bodySnippet: string;
                startupPhase: string | null;
              }>
            >(`(() => {
              try {
                const rootHtml = document.getElementById("root")?.innerHTML ?? "";
                const startupShell = document.querySelector('[data-testid="startup-shell-loading"]');
                const firstRunOverlay = document.querySelector('[data-testid="first-run-shell"]');
                const startupPhase = startupShell?.getAttribute("data-startup-phase") ?? null;
                const bodyText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
                return {
                  ok: true,
                  ready: rootHtml.length > 200 && !startupShell && !firstRunOverlay,
                  rootLength: rootHtml.length,
                  bodySnippet: bodyText.slice(0, 120),
                  startupPhase,
                };
              } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
              }
            })()`);
            lastError = null;
            return lastResult.ok && lastResult.ready;
          } catch (error) {
            lastError =
              error instanceof Error ? error : new Error(String(error));
            return false;
          }
        },
        {
          timeout: process.env.CI ? 120_000 : 60_000,
          message:
            "Expected packaged desktop renderer to finish startup before screenshot capture.",
        },
      )
      .toBe(true);
  } catch (error) {
    const suffix =
      typeof lastResult === "undefined"
        ? `No renderer result was captured.${
            lastError ? ` Last eval error: ${lastError.message}` : ""
          }`
        : `Last renderer result: ${JSON.stringify(lastResult)}`;
    throw new Error(
      `Expected packaged desktop renderer to finish startup before screenshot capture.\n${suffix}\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

test("packaged desktop app launches and renders a non-blank UI headless", async ({
  browserName: _browserName,
}, testInfo) => {
  void _browserName;
  test.setTimeout(600_000);

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-desktop-launch-render-"),
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

    // start() waits for the bridge /health + the native /state snapshot
    // (main window + tray present) — no renderer eval.
    await harness.start({
      bridgeHealthTimeoutMs: 300_000,
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 90_000,
    });

    const bounds = await harness.setMainWindowBounds({
      x: 0,
      y: 0,
      width: 1240,
      height: 860,
    });
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.width).toBeGreaterThanOrEqual(1100);
    expect(bounds.height).toBeGreaterThanOrEqual(760);
    await harness.showMainWindow();
    await harness.focusMainWindow();
    await harness.waitForState(
      (state) =>
        (state.mainWindow.bounds?.x ?? -1) >= 0 &&
        (state.mainWindow.bounds?.y ?? -1) >= 0 &&
        (state.mainWindow.bounds?.width ?? 0) >= 1100 &&
        (state.mainWindow.bounds?.height ?? 0) >= 760 &&
        state.shell.windowVisible,
      "Expected packaged desktop window to report screenshot-sized visible bounds.",
      30_000,
    );
    await waitForRendererShellReady(harness);

    // Summon the overlay so the window grows and paints the real chat surface.
    await harness.eval(`(() => {
      window.dispatchEvent(new CustomEvent("eliza:chat:open"));
      return { ok: true };
    })()`);
    await harness.waitForState(
      (state) => (state.mainWindow.bounds?.width ?? 0) > 720,
      "Expected the overlay window to grow past the pill footprint after open.",
      20_000,
    );

    // Capture the screenshot as a review artifact. NOTE (#16200): the default
    // desktop surface is a TRANSPARENT overlay (chromeless pill that grows to a
    // full-screen transparent sheet with the composer at the bottom), so an
    // OS-level capture is legitimately mostly-transparent — the non-blank OS
    // pixel check no longer fits this architecture. The meaningful "the app
    // painted a real UI" signal is the rendered DOM: waitForRendererShellReady
    // already confirmed the renderer is past the startup shell with real root
    // content, and here we assert the singular chat surface + its live composer
    // actually mounted (an all-white/blank boot would fail this).
    const data = await harness.screenshot();
    const base64 = data.replace(/^data:image\/png;base64,/, "");
    await fs.writeFile(
      testInfo.outputPath("desktop-launch-render.png"),
      Buffer.from(base64, "base64"),
    );
    const rendered = await harness.eval<{
      ok: boolean;
      hasOverlay: boolean;
      hasComposer: boolean;
      rootLength: number;
    }>(`(() => {
      const root = document.getElementById("root");
      return {
        ok: true,
        hasOverlay: Boolean(
          document.querySelector('[data-testid="chat-overlay-shell"]') ||
          document.querySelector('[data-testid="continuous-chat-overlay"]')
        ),
        hasComposer: Boolean(document.querySelector('[aria-label="message"]')),
        rootLength: (root?.innerHTML ?? "").length,
      };
    })()`);
    expect(rendered.hasOverlay, "singular chat overlay mounted").toBe(true);
    expect(rendered.hasComposer, "live composer painted").toBe(true);
    expect(rendered.rootLength).toBeGreaterThan(1000);
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});
