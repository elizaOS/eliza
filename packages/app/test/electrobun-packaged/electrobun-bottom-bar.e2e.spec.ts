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
  isMacConsoleSessionLocked,
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
    const macSessionLocked = isMacConsoleSessionLocked();
    if (macSessionLocked) {
      // error-policy:J4 macOS screen capture can stall WKWebView evaluation
      // while the console session is locked. Preserve DOM/native geometry
      // assertions without invoking the unavailable OS capture path.
      testInfo.annotations.push({
        type: "screen-capture-unavailable",
        description: "macOS console session is locked",
      });
    } else {
      const screenPng = Buffer.from(
        (await harness.screenshot()).replace(/^data:image\/png;base64,/, ""),
        "base64",
      );
      const nativeBounds = (await harness.getState()).mainWindow.bounds;
      expect(nativeBounds).toBeTruthy();
      if (!nativeBounds) {
        throw new Error("bottom-bar window bounds unavailable");
      }
      const screenMetadata = await sharp(screenPng).metadata();
      const screenStats = await sharp(screenPng).stats();
      const captureHasVisiblePixels = screenStats.channels
        .slice(0, 3)
        .some((channel) => channel.mean > 2 || channel.max > 12);
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
      if (captureHasVisiblePixels) {
        expect(whitePixels / sampledPixels).toBeGreaterThan(0.55);
      } else {
        // error-policy:J4 Preserve the all-black capture attachment and the
        // DOM/native geometry assertions without misreporting OS capture
        // denial as a missing launcher. Unlocked CUA remains the pixel proof.
        testInfo.annotations.push({
          type: "screen-capture-unavailable",
          description: "macOS returned an all-black desktop capture",
        });
      }
    }

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

    const readGeometry = (): Promise<{
      panelTop: number;
      panelBottom: number;
      panelLeft: number;
      panelRight: number;
      pillTop: number;
      viewportWidth: number;
      viewportHeight: number;
    }> =>
      harness.eval(`(() => {
      const panel = document.querySelector('[data-testid="shell-assistant-overlay"]');
      const pill = document.querySelector('[data-testid="shell-home-pill"]');
      if (!(panel instanceof HTMLElement) || !(pill instanceof HTMLElement)) {
        throw new Error('expanded chat geometry unavailable');
      }
      const rect = panel.getBoundingClientRect();
      return {
        panelTop: Math.round(rect.top),
        panelBottom: Math.round(rect.bottom),
        panelLeft: Math.round(rect.left),
        panelRight: Math.round(rect.right),
        pillTop: Math.round(pill.getBoundingClientRect().top),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    })()`);

    // The panel enters via a 220ms translate animation (motion-safe). Measuring
    // mid-slide reports the panel displaced up to 8% of its height below its
    // resting place, tripping the containment assertions below. Wait for the
    // geometry to settle (two identical consecutive reads) before asserting.
    let settled = await readGeometry();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const next = await readGeometry();
      if (
        next.panelTop === settled.panelTop &&
        next.panelBottom === settled.panelBottom
      ) {
        settled = next;
        break;
      }
      settled = next;
    }
    const expandedGeometry = settled;
    expect(expandedGeometry.panelBottom).toBeLessThan(expandedGeometry.pillTop);
    expect(
      expandedGeometry.pillTop - expandedGeometry.panelBottom,
    ).toBeGreaterThanOrEqual(8);
    // Two-sided containment (#20063): the expanded panel must sit FULLY inside
    // the native window — a panel translated ~50% of its own height upward
    // (the individual-CSS-`translate` leak this issue describes, measured
    // y ≈ -276px in a 680px window) still satisfies the one-sided
    // bottom-above-pill check above, while being visually outside the window.
    expect(expandedGeometry.panelTop).toBeGreaterThanOrEqual(0);
    expect(expandedGeometry.panelLeft).toBeGreaterThanOrEqual(0);
    expect(expandedGeometry.panelRight).toBeLessThanOrEqual(
      expandedGeometry.viewportWidth,
    );
    // Intended top breathing room: ≥ 24px of window above the panel.
    expect(expandedGeometry.panelTop).toBeGreaterThanOrEqual(24);
    // Bottom containment checked directly against the viewport, not inferred
    // through pillTop alone (#20063 review finding 2): the panel must stop
    // short of the resting bar zone.
    expect(expandedGeometry.viewportHeight - expandedGeometry.panelBottom)
      .toBeGreaterThanOrEqual(8);
    // Horizontal centering (#20063 review finding 1): the panel's midpoint
    // must match the viewport's midpoint — the entry animation previously
    // replaced the centering transform for its full 220ms duration, flying
    // the panel in off-center before snapping back.
    const panelMidpoint =
      (expandedGeometry.panelLeft + expandedGeometry.panelRight) / 2;
    expect(Math.abs(panelMidpoint - expandedGeometry.viewportWidth / 2)).toBeLessThanOrEqual(
      4,
    );

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
    if (macSessionLocked) {
      // error-policy:J4 A locked macOS console cannot grant key-window focus.
      // Registration remains asserted above; unlocked packaged and CUA runs
      // exercise the actual dismiss/summon sequence.
      const lockedState = await harness.getState();
      expect(lockedState.shell.windowVisible).toBe(true);
      testInfo.annotations.push({
        type: "window-focus-unavailable",
        description: "macOS console session is locked",
      });
    } else {
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
    }

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
