/**
 * Packaged Electrobun spec for the Electrobun Bottom Bar E2e desktop app
 * behavior.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

// #9953 Phase 5: the chromeless bottom-bar desktop shell. This asserts the
// MAIN-PROCESS window shape (reported by the desktop test bridge, independent of
// whether the renderer fully boots the chat UI): when ELIZA_DESKTOP_BOTTOM_BAR=1
// the resting surface is a frameless (no OS title bar), short, full-width window
// pinned to the screen bottom — not the 1440x900 dashboard. Runs only where a
// packaged launcher has been built (CI / local packaged builds); self-skips
// otherwise.

test.describe.configure({ mode: "serial" });

test("bottom-bar mode opens a chromeless, short, bottom-anchored main window", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-bottom-bar-"),
  );
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  ).catch(() => null);
  test.skip(
    !launcherPath,
    "Packaged launcher not built — bottom-bar e2e runs against a packaged build only.",
  );

  const api = await startMockApiServer({ firstRunComplete: true, port: 0 });
  const harness = new PackagedDesktopHarness({
    tempRoot,
    launcherPath: launcherPath as string,
    apiBase: api.baseUrl,
    extraEnv: { ELIZA_DESKTOP_BOTTOM_BAR: "1" },
  });

  try {
    await harness.start({
      bridgeHealthTimeoutMs: 300_000,
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 60_000,
    });

    const state = await harness.getState();
    expect(state.mainWindow.present).toBe(true);
    // Chromeless: the bar carries no OS title bar.
    expect(state.mainWindow.titleBarStyle).toBe("hidden");

    // A bar, not the dashboard: short, wider than tall, pinned low on screen.
    const bounds = state.mainWindow.bounds;
    expect(bounds).toBeTruthy();
    if (bounds) {
      expect(bounds.height).toBeLessThanOrEqual(200);
      expect(bounds.width).toBeGreaterThan(bounds.height);
      // Pinned to the bottom: the bar's bottom edge sits well below its top.
      expect(bounds.y).toBeGreaterThan(bounds.height);
    }
  } finally {
    await harness.stop().catch(() => undefined);
    await api.close().catch(() => undefined);
    await fs
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
});
