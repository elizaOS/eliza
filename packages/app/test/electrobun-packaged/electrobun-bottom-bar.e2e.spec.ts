/**
 * Packaged Electrobun spec for the Electrobun Bottom Bar E2e desktop app
 * behavior.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
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

test("desktop popup shell exposes the accessible pill, hotkey toggle, and tray launcher", async ({
  browserName: _browserName,
}, testInfo) => {
  void _browserName;
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

    await expect
      .poll(
        () =>
          harness.eval<{
            shellPresent: boolean;
            pillLabel: string | null;
            pillText: string | null;
            pillHeight: number | null;
            pillBackground: string | null;
            markWidth: number | null;
            markHeight: number | null;
            markPainted: boolean;
            pillVisible: boolean;
          }>(`(() => {
            const shell = document.querySelector('[data-testid="chat-overlay-shell"]');
            const pill = document.querySelector('[data-testid="shell-home-pill"]');
            const mark = document.querySelector('[data-testid="shell-home-pill-mark"]');
            return {
              shellPresent: Boolean(shell),
              pillLabel: pill?.getAttribute('aria-label') ?? null,
              pillText: pill?.textContent?.trim() ?? null,
              pillHeight: pill instanceof HTMLElement ? pill.getBoundingClientRect().height : null,
              pillBackground: pill instanceof HTMLElement ? getComputedStyle(pill).backgroundColor : null,
              markWidth: mark instanceof HTMLElement ? mark.getBoundingClientRect().width : null,
              markHeight: mark instanceof HTMLElement ? mark.getBoundingClientRect().height : null,
              markPainted: mark instanceof HTMLElement &&
                !['transparent', 'rgba(0, 0, 0, 0)'].includes(getComputedStyle(mark).backgroundColor),
              pillVisible: pill instanceof HTMLElement &&
                getComputedStyle(pill).display !== 'none' &&
                getComputedStyle(pill).visibility !== 'hidden' &&
                Number(getComputedStyle(pill).opacity) > 0,
            };
          })()`),
        { timeout: process.env.CI ? 120_000 : 60_000 },
      )
      .toEqual({
        shellPresent: true,
        pillLabel: "Open Eliza",
        pillText: "",
        pillHeight: 32,
        pillBackground: "rgba(0, 0, 0, 0)",
        markWidth: 48,
        markHeight: 10,
        markPainted: true,
        pillVisible: true,
      });

    // DOM state alone cannot prove a transparent native window actually
    // composited the control. Sample the pill's physical screen pixels and
    // require the short white Flow-style handle to be physically present.
    const pillRect = await harness.eval<{
      x: number;
      y: number;
      width: number;
      height: number;
      dpr: number;
    }>(`(() => {
      const mark = document.querySelector('[data-testid="shell-home-pill-mark"]');
      if (!(mark instanceof HTMLElement)) throw new Error('pill mark missing');
      const rect = mark.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        dpr: window.devicePixelRatio || 1,
      };
    })()`);
    const screenPng = Buffer.from(
      (await harness.screenshot()).replace(/^data:image\/png;base64,/, ""),
      "base64",
    );
    const nativeBounds = (await harness.getState()).mainWindow.bounds;
    expect(nativeBounds).toBeTruthy();
    if (!nativeBounds) throw new Error("bottom-bar window bounds unavailable");
    const screenMetadata = await sharp(screenPng).metadata();
    const left = Math.max(
      0,
      Math.round((nativeBounds.x + pillRect.x) * pillRect.dpr),
    );
    const top = Math.max(
      0,
      Math.round((nativeBounds.y + pillRect.y) * pillRect.dpr),
    );
    const width = Math.min(
      Math.round(pillRect.width * pillRect.dpr),
      (screenMetadata.width ?? 0) - left,
    );
    const height = Math.min(
      Math.round(pillRect.height * pillRect.dpr),
      (screenMetadata.height ?? 0) - top,
    );
    expect(width).toBeGreaterThan(35);
    expect(height).toBeGreaterThan(6);
    const pillPixels = await sharp(screenPng)
      .extract({ left, top, width, height })
      .ensureAlpha()
      .raw()
      .toBuffer();
    let whitePixels = 0;
    for (let offset = 0; offset < pillPixels.length; offset += 4) {
      const red = pillPixels[offset];
      const green = pillPixels[offset + 1];
      const blue = pillPixels[offset + 2];
      if (red > 210 && green > 210 && blue > 210) whitePixels += 1;
    }
    const sampledPixels = width * height;
    const pillCapturePath = testInfo.outputPath("bottom-launcher-pill.png");
    await sharp(screenPng)
      .extract({ left, top, width, height })
      .png()
      .toFile(pillCapturePath);
    await testInfo.attach("bottom-launcher-pill.png", {
      path: pillCapturePath,
      contentType: "image/png",
    });
    expect(whitePixels / sampledPixels).toBeGreaterThan(0.55);

    await harness.eval(
      `document.querySelector('[data-testid="shell-home-pill"]')?.click()`,
    );
    const expandedState = await harness.waitForState(
      (next) => (next.mainWindow.bounds?.height ?? 0) > 400,
      "Expected opening the pill to expand the bottom-anchored native chat window.",
      30_000,
    );
    const expandedBounds = expandedState.mainWindow.bounds;
    expect(expandedBounds).toBeTruthy();
    if (!bounds || !expandedBounds) {
      throw new Error("bottom-bar expansion bounds unavailable");
    }
    expect(expandedBounds.y + expandedBounds.height).toBe(
      bounds.y + bounds.height,
    );
    await expect
      .poll(() =>
        harness.eval(`(() => {
          const panel = document.querySelector('[data-testid="shell-assistant-overlay"]');
          return {
            present: Boolean(panel && document.querySelector('input[aria-label="Message Eliza"]')),
            placeholder: document.querySelector('input[aria-label="Message Eliza"]')?.getAttribute('placeholder') ?? null,
            glassTier: panel?.getAttribute('data-glass-tier') ?? null,
            material: panel?.getAttribute('data-popup-material') ?? null,
            radius: panel instanceof HTMLElement ? getComputedStyle(panel).borderRadius : null,
            background: panel instanceof HTMLElement ? getComputedStyle(panel).backgroundColor : null,
            textColor: panel instanceof HTMLElement ? getComputedStyle(panel).color : null,
            width: panel instanceof HTMLElement ? Math.round(panel.getBoundingClientRect().width) : null,
            height: panel instanceof HTMLElement ? Math.round(panel.getBoundingClientRect().height) : null,
            panelBottom: panel instanceof HTMLElement ? Math.round(panel.getBoundingClientRect().bottom) : null,
            pillTop: document.querySelector('[data-testid="shell-home-pill"]') instanceof HTMLElement
              ? Math.round(document.querySelector('[data-testid="shell-home-pill"]').getBoundingClientRect().top)
              : null,
          };
        })()`),
      )
      .toMatchObject({
        present: true,
        placeholder: "Message Eliza…",
        glassTier: expect.stringMatching(/^css-/),
        material: "light-frosted",
        radius: "24px",
        background: expect.stringMatching(/244|0\.956/),
        textColor: expect.stringMatching(/23|0\.09/),
        width: 560,
        height: 600,
      });

    const expandedGeometry = await harness.eval<{
      panelBottom: number;
      pillTop: number;
    }>(`(() => {
      const panel = document.querySelector('[data-testid="shell-assistant-overlay"]');
      const pill = document.querySelector('[data-testid="shell-home-pill"]');
      if (!(panel instanceof HTMLElement) || !(pill instanceof HTMLElement)) {
        throw new Error('expanded chat geometry unavailable');
      }
      return {
        panelBottom: Math.round(panel.getBoundingClientRect().bottom),
        pillTop: Math.round(pill.getBoundingClientRect().top),
      };
    })()`);
    expect(expandedGeometry.panelBottom).toBeLessThan(expandedGeometry.pillTop);
    expect(
      expandedGeometry.pillTop - expandedGeometry.panelBottom,
    ).toBeGreaterThanOrEqual(8);

    await harness.eval(
      `document.querySelector('[aria-label="Close assistant"]')?.click()`,
    );
    await harness.waitForState(
      (next) =>
        (next.mainWindow.bounds?.height ?? Number.POSITIVE_INFINITY) <= 200,
      "Expected closing chat to restore the compact native launcher frame.",
      30_000,
    );

    const desktopBridge = await harness.eval(`({
      windowId: typeof window.__electrobunWindowId,
      webviewId: typeof window.__electrobunWebviewId,
      rpc: typeof window.__ELIZA_ELECTROBUN_RPC__,
      request: typeof window.__ELIZA_ELECTROBUN_RPC__?.request,
    })`);
    expect(desktopBridge).toEqual({
      windowId: "number",
      webviewId: "number",
      rpc: "object",
      request: "function",
    });

    const interactiveState = await harness.waitForState(
      (next) =>
        next.shell.shortcuts.some((shortcut) => shortcut.id === "chat-overlay"),
      "Expected the popup hotkey to register after the renderer mounted.",
      30_000,
    );
    expect(interactiveState.shell.shortcuts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "chat-overlay" })]),
    );
    await harness.showMainWindow();
    await harness.focusMainWindow();
    await harness.waitForState(
      (next) => next.shell.windowVisible && next.shell.windowFocused,
      "Expected the popup chat to be visible and focused before hotkey dismissal.",
      30_000,
    );
    await harness.pressShortcut("chat-overlay");
    await harness.waitForState(
      (next) => !next.shell.windowVisible,
      "Expected the popup hotkey to dismiss a visible focused chat.",
      30_000,
    );
    await harness.pressShortcut("chat-overlay");
    await harness.waitForState(
      (next) => next.shell.windowVisible && next.shell.windowFocused,
      "Expected the popup hotkey to summon and focus the hidden chat.",
      30_000,
    );

    if (process.platform === "darwin") {
      expect(interactiveState.shell.trayPopover).toMatchObject({
        configured: false,
        windowPresent: false,
        visible: false,
      });
    }
  } finally {
    await harness.stop().catch(() => undefined);
    await api.close().catch(() => undefined);
    await fs
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
});
