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

  const api = await startMockApiServer({
    firstRunComplete: true,
    port: 0,
    assistantReplyText: [
      "Time to stretch.",
      "",
      "[CHOICE:lifeops-reminder id=packaged-reminder]",
      "done=Done",
      "10 minutes=Snooze 10m",
      "skip=Skip",
      "[/CHOICE]",
    ].join("\n"),
  });
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

    // The native shell and tray exist before the renderer/preload RPC is ready.
    // Shortcut registration is the first renderer-owned shell signal, so wait
    // for it before issuing DOM eval requests that would otherwise be lost.
    const interactiveState = await harness.waitForState(
      (next) =>
        next.shell.shortcuts.some((shortcut) => shortcut.id === "chat-overlay"),
      "Expected the popup hotkey to register after the renderer mounted.",
      30_000,
    );
    expect(interactiveState.shell.shortcuts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "chat-overlay" })]),
    );

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
            providerTruthVisible: boolean;
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
              providerTruthVisible: Boolean(document.querySelector('[data-testid="serving-provider-chip"]')),
            };
          })()`),
        { timeout: process.env.CI ? 120_000 : 60_000 },
      )
      .toEqual({
        shellPresent: true,
        pillLabel: "Open Eliza",
        pillText: "",
        pillHeight: 44,
        pillBackground: expect.stringMatching(/^(?!rgba\(0, 0, 0, 0\)$).+/),
        markWidth: 48,
        markHeight: 6,
        markPainted: true,
        pillVisible: true,
        providerTruthVisible: false,
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
        (await harness.screenshot(30_000)).replace(
          /^data:image\/png;base64,/,
          "",
        ),
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
    await expect
      .poll(() =>
        harness.eval(`(() => ({
          homePillPresent: Boolean(document.querySelector('[data-testid="shell-home-pill"]')),
          chatOverlayPresent: Boolean(document.querySelector('[data-testid="chat-overlay"]')),
          chatSheetPresent: Boolean(document.querySelector('[data-testid="chat-sheet"]')),
          composerPresent: Boolean(document.querySelector('[data-testid="chat-composer-textarea"]')),
          composerFocused: document.activeElement?.getAttribute('data-testid') === 'chat-composer-textarea',
          providerTruthVisible: Boolean(document.querySelector('[data-testid="serving-provider-chip"]')),
        }))()`),
      )
      .toEqual({
        homePillPresent: false,
        chatOverlayPresent: true,
        chatSheetPresent: true,
        composerPresent: true,
        composerFocused: true,
        providerTruthVisible: false,
      });
    const expandedState = await harness.waitForState(
      (next) => (next.mainWindow.bounds?.height ?? 0) > 400,
      "Expected opening the pill to focus the composer and expand the bottom-anchored native chat window.",
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
          const panel = document.querySelector('[data-testid="chat-sheet"]');
          const surface = document.querySelector('[data-testid="chat-sheet-surface"]');
          const overlay = document.querySelector('[data-testid="chat-overlay"]');
          return {
            present: Boolean(panel && document.querySelector('[data-testid="chat-composer-textarea"]')),
            placeholder: document.querySelector('[data-testid="chat-composer-textarea"]')?.getAttribute('placeholder') ?? null,
            variant: panel?.getAttribute('data-variant') ?? null,
            chatState: panel?.getAttribute('data-chat-state') ?? null,
            glassTier: surface?.getAttribute('data-glass-tier') ?? null,
            detached: overlay?.getAttribute('data-desktop-overlay') ?? null,
            providerLabel: document.querySelector('[data-testid="serving-provider-chip"]')?.textContent?.trim() ?? null,
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
        placeholder: "Message Eliza",
        variant: "open",
        chatState: "OPEN_HALF_OR_OVER",
        glassTier: expect.stringMatching(/^(css|native)-/),
        detached: "true",
        // End-user chat intentionally omits provider diagnostics. Settings is
        // the supported surface for inspecting serving truth.
        providerLabel: null,
        width: expandedBounds.width,
        height: expandedBounds.height,
      });

    const readExpandedGeometry = () =>
      harness.eval<{
        panelLeft: number;
        panelRight: number;
        panelTop: number;
        panelBottom: number;
        viewportHeight: number;
        viewportWidth: number;
      }>(`(() => {
        const panel = document.querySelector('[data-testid="chat-sheet"]');
        if (!(panel instanceof HTMLElement)) {
          throw new Error('expanded chat geometry unavailable');
        }
        return {
          panelLeft: Math.round(panel.getBoundingClientRect().left),
          panelRight: Math.round(panel.getBoundingClientRect().right),
          panelTop: Math.round(panel.getBoundingClientRect().top),
          panelBottom: Math.round(panel.getBoundingClientRect().bottom),
          viewportHeight: Math.round(window.innerHeight),
          viewportWidth: Math.round(window.innerWidth),
        };
      })()`);
    await expect
      .poll(async () => {
        const geometry = await readExpandedGeometry();
        return {
          top: geometry.panelTop,
          bottomGap: geometry.viewportHeight - geometry.panelBottom,
        };
      })
      .toEqual({ top: 0, bottomGap: 0 });
    const expandedGeometry = await readExpandedGeometry();
    expect(expandedGeometry.panelLeft).toBe(0);
    expect(expandedGeometry.panelRight).toBe(expandedGeometry.viewportWidth);

    const inputResult = await harness.eval<{
      updated: boolean;
      error?: string;
    }>(`(() => {
      const input = document.querySelector('[data-testid="chat-composer-textarea"]');
      if (!(input instanceof HTMLTextAreaElement)) {
        return { updated: false, error: 'chat composer input not found' };
      }
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (!setter) return { updated: false, error: 'native value setter missing' };
      setter.call(input, 'show the packaged reminder');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { updated: true };
    })()`);
    expect(inputResult).toEqual({ updated: true });
    await expect
      .poll(() =>
        harness.eval(`(() => {
          const send = document.querySelector('[data-testid="chat-composer-action"]');
          return send instanceof HTMLButtonElement && !send.disabled;
        })()`),
      )
      .toBe(true);
    await harness.eval(
      `document.querySelector('[data-testid="chat-composer-action"]')?.click()`,
    );

    await expect
      .poll(() =>
        harness.eval(`(() => {
          const surface = document.querySelector('[data-testid="chat-thread"]');
          return {
            transcript: surface?.textContent ?? '',
            doneVisible: Boolean(surface?.querySelector('[data-testid="choice-done"]')),
            snoozeVisible: Boolean(surface?.querySelector('[data-testid="choice-10 minutes"]')),
            skipVisible: Boolean(surface?.querySelector('[data-testid="choice-skip"]')),
          };
        })()`),
      )
      .toMatchObject({
        transcript: expect.stringContaining("Time to stretch."),
        doneVisible: true,
        snoozeVisible: true,
        skipVisible: true,
      });
    await harness.eval(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );
    const collapsedComposerState = await harness.waitForState(
      (next) =>
        next.mainWindow.bounds?.width === 600 &&
        next.mainWindow.bounds?.height === 64,
      "Expected closing chat to restore the exact compact composer frame.",
      30_000,
    );
    expect(collapsedComposerState.mainWindow.bounds).toMatchObject({
      width: 600,
      height: 64,
    });
    await harness.eval(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );
    const restoredPillState = await harness.waitForState(
      (next) =>
        next.mainWindow.bounds?.width === 64 &&
        next.mainWindow.bounds?.height === 44,
      "Expected a second Escape to restore the exact resting pill frame.",
      30_000,
    );
    expect(restoredPillState.mainWindow.bounds).toMatchObject({
      width: 64,
      height: 44,
    });

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
