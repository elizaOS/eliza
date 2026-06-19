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
 * It uses only the native bridge state (`harness.start()` waits for the main
 * window + tray via the bridge `/state` snapshot — no renderer eval) and a real
 * screenshot of the rendered window (`assertScreenshotNotBlank`), so it does not
 * depend on the eval-seeding path. The same React bundle (and thus the decomposed
 * lifeops views) renders here as in the web + mobile-viewport e2e lanes.
 *
 * Requires a prebuilt Electrobun binary (see playwright.electrobun.packaged.config.ts)
 * and, on a GPU-less host, the headless env from packaged-app-helpers (xvfb +
 * WEBKIT_DISABLE_SANDBOX + software GL) plus a screenshot tool on PATH.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { assertScreenshotNotBlank } from "../ui-smoke/helpers/screenshot-quality";
import { startLiveApiServer, type TestApiServer } from "./live-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

test("packaged desktop app launches and renders a non-blank UI headless", async ({}, testInfo) => {
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

  let api: TestApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  try {
    api = await startLiveApiServer({ firstRunComplete: true, port: 0 });
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

    // Real screenshot of the rendered window; assert it painted (not blank).
    const data = await harness.screenshot();
    const base64 = data.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64, "base64");
    await assertScreenshotNotBlank(buffer, "packaged desktop launch render");
    await fs.writeFile(
      testInfo.outputPath("desktop-launch-render.png"),
      buffer,
    );
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});
