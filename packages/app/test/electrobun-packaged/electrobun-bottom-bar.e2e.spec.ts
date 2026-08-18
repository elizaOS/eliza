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
        pillHeight: 32,
        pillBackground: "rgba(0, 0, 0, 0)",
        markWidth: 48,
        markHeight: 10,
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
            backdropFilter: panel instanceof HTMLElement ? getComputedStyle(panel).backdropFilter : null,
            webkitBackdropFilter: panel instanceof HTMLElement ? getComputedStyle(panel).webkitBackdropFilter : null,
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
        placeholder: "Message Eliza…",
        glassTier: expect.stringMatching(/^css-/),
        material: "dark-frosted",
        radius: "24px",
        background: expect.stringMatching(/12|0\.047/),
        textColor: expect.stringMatching(/rgb\(2\d{2}, 2\d{2}, 2\d{2}\)/),
        backdropFilter: expect.stringContaining("blur(30px)"),
        webkitBackdropFilter: expect.stringContaining("blur(30px)"),
        // The mock advertises an Eliza Cloud route while deliberately staying
        // disconnected, so the truthful serving result is its on-device fallback.
        providerLabel: "On device",
        width: 560,
        height: 600,
      });

    const readExpandedGeometry = () =>
      harness.eval<{
        panelLeft: number;
        panelRight: number;
        panelTop: number;
        panelBottom: number;
        pillTop: number;
        viewportHeight: number;
        viewportWidth: number;
      }>(`(() => {
        const panel = document.querySelector('[data-testid="shell-assistant-overlay"]');
        const pill = document.querySelector('[data-testid="shell-home-pill"]');
        if (!(panel instanceof HTMLElement) || !(pill instanceof HTMLElement)) {
          throw new Error('expanded chat geometry unavailable');
        }
        return {
          panelLeft: Math.round(panel.getBoundingClientRect().left),
          panelRight: Math.round(panel.getBoundingClientRect().right),
          panelTop: Math.round(panel.getBoundingClientRect().top),
          panelBottom: Math.round(panel.getBoundingClientRect().bottom),
          pillTop: Math.round(pill.getBoundingClientRect().top),
          viewportHeight: Math.round(window.innerHeight),
          viewportWidth: Math.round(window.innerWidth),
        };
      })()`);
    await expect
      .poll(async () => {
        const geometry = await readExpandedGeometry();
        const expectedTop =
          geometry.viewportHeight -
          56 -
          Math.min(600, geometry.viewportHeight - 80);
        return geometry.panelTop - expectedTop;
      })
      .toBe(0);
    const expandedGeometry = await readExpandedGeometry();
    expect(expandedGeometry.panelTop).toBeGreaterThanOrEqual(16);
    expect(expandedGeometry.panelTop).toBe(
      expandedGeometry.viewportHeight -
        56 -
        Math.min(600, expandedGeometry.viewportHeight - 80),
    );
    expect(expandedGeometry.panelLeft).toBeGreaterThanOrEqual(0);
    expect(expandedGeometry.panelRight).toBeLessThanOrEqual(
      expandedGeometry.viewportWidth,
    );
    expect(
      Math.abs(
        (expandedGeometry.panelLeft + expandedGeometry.panelRight) / 2 -
          expandedGeometry.viewportWidth / 2,
      ),
    ).toBeLessThanOrEqual(1);
    expect(expandedGeometry.panelBottom).toBeLessThan(expandedGeometry.pillTop);
    expect(
      expandedGeometry.pillTop - expandedGeometry.panelBottom,
    ).toBeGreaterThanOrEqual(8);

    const inputResult = await harness.eval<{
      updated: boolean;
      error?: string;
    }>(`(() => {
      const input = document.querySelector('[data-testid="shell-chat-surface"] input');
      if (!(input instanceof HTMLInputElement)) {
        return { updated: false, error: 'chat composer input not found' };
      }
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
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
          const send = document.querySelector('button[aria-label="Send message"]');
          return send instanceof HTMLButtonElement && !send.disabled;
        })()`),
      )
      .toBe(true);
    await harness.eval(
      `document.querySelector('button[aria-label="Send message"]')?.click()`,
    );

    await expect
      .poll(() =>
        harness.eval(`(() => {
          const surface = document.querySelector('[data-testid="shell-chat-surface"]');
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

    // Resting-state transform lock: the settled panel's computed transform
    // must be EXACTLY the shell's centering transform — asserting the
    // anchored keyframes end state and that the Tailwind utility `translate`
    // path stays cancelled.
    const readRestingTransform = () =>
      harness.eval<{
        matrix: string;
        width: number;
      }>(`(() => {
        const panel = document.querySelector('[data-testid="shell-assistant-overlay"]');
        if (!(panel instanceof HTMLElement)) throw new Error('panel missing');
        return {
          matrix: getComputedStyle(panel).transform,
          width: panel.getBoundingClientRect().width,
        };
      })()`);
    // Poll until the entry animation has fully settled: its translateY term
    // must reach exactly 0 before the one-shot snapshot is asserted.
    await expect
      .poll(async () => {
        const current = await readRestingTransform();
        const match = /^matrix\(([^)]+)\)$/.exec(current.matrix.trim());
        return match
          ? Number.parseFloat(match[1].split(",")[5]?.trim() ?? "NaN")
          : Number.NaN;
      })
      .toBe(0);
    const resting = await readRestingTransform();
    const matrixMatch = /^matrix\(([^)]+)\)$/.exec(resting.matrix.trim());
    expect(matrixMatch).toBeTruthy();
    const matrixTerms = (matrixMatch?.[1] ?? "")
      .split(",")
      .map((term) => Number.parseFloat(term.trim()));
    // identity scale terms and a pure X translation of exactly -width/2
    expect(matrixTerms[0]).toBe(1);
    expect(matrixTerms[1]).toBe(0);
    expect(matrixTerms[2]).toBe(0);
    expect(matrixTerms[3]).toBe(1);
    expect(matrixTerms[5]).toBe(0);
    expect(Math.abs(matrixTerms[4] + resting.width / 2)).toBeLessThanOrEqual(1);

    // Mid-entry centering probe (#20063, follow-up to #20496): the resting
    // assertions above wait out the 220ms entry animation, so they pass even
    // if the animation replaces the centering transform (the residual finding
    // from the #20496 review: the base `shell-overlay-in` keyframes animate
    // `translateY(...)` alone, dropping the shell's `translateX(-50%)` for
    // the entry). Deterministically RESTART the entry animation, flush
    // styles, pause at the 110ms midpoint, and assert the panel is
    // horizontally centered THERE, where un-anchored keyframes would place it
    // ~half its width off-center. A computed animationName alone is NOT
    // evidence the animation is still running (it stays declared after
    // finish), and a finished animation ignores animationDelay/playState
    // changes — hence the explicit restart.
    {
      const midEntry = await harness.eval<{
        skipped: boolean;
        reason?: string;
        animationName: string;
        left: number;
        width: number;
        viewportWidth: number;
      }>(`(() => {
        const panel = document.querySelector('[data-testid="shell-assistant-overlay"]');
        if (!(panel instanceof HTMLElement)) throw new Error('panel missing');
        // The ONLY legitimate skip: the runner itself suppresses animations.
        // (animation-name is NOT a valid detector — the shell rule sets it
        // unconditionally, even when motion-safe utilities are withheld.)
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          return { skipped: true, reason: 'prefers-reduced-motion' };
        }
        const cs = getComputedStyle(panel);
        if (cs.animationName !== 'shell-overlay-in-anchored') {
          // The shell rule must select the anchored keyframes; anything else
          // is a regression, not a skip.
          throw new Error(
            'shell rule no longer selects shell-overlay-in-anchored (got ' +
              cs.animationName + ')',
          );
        }
        // Capture the utility-declared shorthand so restoration is exact.
        const declared = {
          name: cs.animationName,
          duration: cs.animationDuration,
          timing: cs.animationTimingFunction,
          delay: cs.animationDelay,
          iteration: cs.animationIterationCount,
          direction: cs.animationDirection,
          fill: cs.animationFillMode,
          play: cs.animationPlayState,
        };
        // Validate the duration BEFORE any inline mutation so the guard
        // throws leave the panel untouched (the restore finally sits outside
        // this eval round-trip; ordering makes the no-leak guarantee
        // unconditional).
        const durationMs =
          Number.parseFloat(declared.duration) *
          (declared.duration.endsWith("ms") ? 1 : 1000);
        if (!(durationMs > 0)) {
          throw new Error(
            'entry animation duration is not positive (got ' +
              declared.duration + '); motion-safe utility not applied',
          );
        }
        // Restart: cancel any in-flight/finished animation, cancel the
        // inline override, then re-declare the shorthand so a NEW
        // CSSAnimation starts from time zero.
        for (const anim of panel.getAnimations()) anim.cancel();
        panel.style.animation = 'none';
        void panel.offsetWidth; // force style flush
        panel.style.animation = [
          declared.duration, declared.timing, '0ms', declared.iteration,
          declared.direction, declared.fill, 'paused', declared.name,
        ].join(' ');
        void panel.offsetWidth; // flush so the paused animation exists
        // Seek to the midpoint of the duration via currentTime. A
        // zero/negative duration means the motion-safe utility was withheld
        // and seeking would sample time zero — a silent false pass.
        const anim = panel.getAnimations()[0];
        if (!(anim instanceof CSSAnimation)) {
          throw new Error('no CSSAnimation running after restart');
        }
        anim.currentTime = durationMs / 2;
        void panel.offsetWidth; // flush the seeked frame
        const rect = panel.getBoundingClientRect();
        return {
          skipped: false,
          animationName: cs.animationName,
          left: rect.left,
          width: rect.width,
          viewportWidth: window.innerWidth,
        };
      })()`);
      try {
        if (!midEntry.skipped) {
          expect(midEntry.animationName).toBe("shell-overlay-in-anchored");
          const midOffset = Math.abs(
            midEntry.left + midEntry.width / 2 - midEntry.viewportWidth / 2,
          );
          expect(midOffset).toBeLessThanOrEqual(4);
        } else {
          // Surface the skip for traceability, matching the file's
          // established annotation pattern for unavailable-evidence paths.
          testInfo.annotations.push({
            type: "entry-probe-unavailable",
            description: `mid-entry centering probe skipped: ${midEntry.reason ?? "unspecified"}`,
          });
        }
      } finally {
        // Restoration must run even when an assertion throws (so the inline
        // animation override never leaks into later probes).
        await harness.eval(
          `(() => {
            const panel = document.querySelector('[data-testid="shell-assistant-overlay"]');
            if (panel instanceof HTMLElement) panel.style.animation = '';
          })()`,
        );
      }
    }
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
