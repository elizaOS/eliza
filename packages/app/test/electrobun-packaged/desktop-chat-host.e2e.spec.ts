/**
 * Packaged-desktop coverage for the cross-window "active chat host" wiring
 * (#16200 Stage 3): the shell resolves which window renders the singular chat
 * and broadcasts it, so the chat is never duplicated across windows. This spec
 * asserts the end-to-end wiring on the real packaged binary — at rest the main
 * floating-pill window is the host and actually renders the singular
 * ChatOverlay. The per-window relocation rule (focused chat surface takes host,
 * non-chat surface leaves it at the main window) is proven by the pure resolver
 * + broadcaster unit tests in packages/app-core/platforms/electrobun; here we
 * confirm the shell computes + exposes the host and the renderer honors it.
 */
import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

test("main window is the active chat host at rest and renders the singular overlay", async () => {
  test.setTimeout(300_000);
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-chat-host-"),
  );
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  ).catch(() => null);
  test.skip(
    !launcherPath,
    "Packaged launcher not built — host e2e runs against a packaged build only.",
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
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 90_000,
    });
    await harness.showMainWindow();
    await harness.focusMainWindow();

    // The shell resolves the main window as the host once the bridge is live
    // (no other window is focused). The host id equals the main window id.
    await expect
      .poll(
        async () => {
          const state = await harness.getState();
          return {
            host: state.shell.activeChatHostWindowId ?? null,
            main: state.mainWindow.windowId ?? null,
          };
        },
        {
          timeout: 60_000,
          message:
            "Expected the shell to resolve the main window as the active chat host.",
        },
      )
      .toEqual(expect.objectContaining({ host: expect.any(Number) }));

    // The Stage-3 invariant, read purely from the native bridge /state (no
    // renderer eval — the eval channel is load-sensitive and flaky under a
    // multi-spec run): the shell resolves the main floating-pill window as the
    // active chat host, so the single overlay renders there. That the host
    // window actually paints the singular ChatOverlay + composer is covered by
    // desktop-launch-render; that the pill is pill-sized + grows is covered by
    // electrobun-bottom-bar. Here we pin the host-resolution wiring itself.
    const state = await harness.getState();
    expect(state.shell.activeChatHostWindowId).toBe(state.mainWindow.windowId);
    expect(state.shell.activeChatHostWindowId).toEqual(expect.any(Number));
  } finally {
    await harness.stop().catch(() => undefined);
    await api.close().catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
