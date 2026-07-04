/**
 * Covers chat panel layout decisions for responsive shell placement and
 * transcript sizing.
 */
import { describe, expect, it } from "vitest";
import {
  type ChatPanelLayoutInput,
  resolveChatPanelLayout,
  SHEET_TOP_MARGIN,
} from "./chat-panel-layout";

// The overlay is a bottom-anchored fixed element lifted by
// `effectiveKeyboardInset`; its panel grows UP and is capped at `panelMaxH`.
// This models where the panel's TOP edge lands in layout coordinates measured
// from the screen bottom — the geometry that decides whether the header buttons
// clear the notch.
function panelTopFromBottom(
  input: ChatPanelLayoutInput,
  panelMaxH: number,
): number {
  const overlayBottomPad = input.fullBleed ? 0 : input.bottomPad;
  return input.effectiveKeyboardInset + overlayBottomPad + panelMaxH;
}

const SCREEN_H = 852; // iPhone 15 logical height
const NOTCH = 59; // safe-area-inset-top on a Dynamic-Island device
const KEYBOARD = 336; // iOS soft-keyboard height incl. accessory bar
const BOTTOM_PAD = 34; // home-indicator safe area at rest

describe("resolveChatPanelLayout", () => {
  it("reserves the fixed top margin on web/desktop (no keyboard, no notch)", () => {
    const { topMargin, panelMaxH } = resolveChatPanelLayout({
      viewportH: 800,
      bottomPad: 0,
      keyboardInset: 0,
      effectiveKeyboardInset: 0,
      safeAreaTopPx: 0,
      fullBleed: false,
    });
    expect(topMargin).toBe(SHEET_TOP_MARGIN);
    expect(panelMaxH).toBe(800 - SHEET_TOP_MARGIN);
  });

  it("reserves the real notch inset when it exceeds the fixed margin", () => {
    // A taller-than-default safe area must win so the header still clears it.
    const tall = resolveChatPanelLayout({
      viewportH: 900,
      bottomPad: 0,
      keyboardInset: 0,
      effectiveKeyboardInset: 0,
      safeAreaTopPx: 90,
      fullBleed: false,
    });
    expect(tall.topMargin).toBe(90 + 8);

    // A standard notch (59px) stays under the 72px floor.
    const standard = resolveChatPanelLayout({
      viewportH: 900,
      bottomPad: 0,
      keyboardInset: 0,
      effectiveKeyboardInset: 0,
      safeAreaTopPx: NOTCH,
      fullBleed: false,
    });
    expect(standard.topMargin).toBe(SHEET_TOP_MARGIN);
  });

  it("keeps the panel top below the notch when iOS lifts via the native keyboard but the visual viewport does NOT shrink (the reported bug)", () => {
    // iOS Capacitor resize:"body": the native Keyboard plugin reports the lift
    // (effectiveKeyboardInset = K) but visualViewport.height stays at the full
    // height and keyboardInset reads 0.
    const input: ChatPanelLayoutInput = {
      viewportH: SCREEN_H, // stale — did NOT shrink for the keyboard
      bottomPad: 12, // composer-focused padding
      keyboardInset: 0, // visual viewport reported nothing
      effectiveKeyboardInset: KEYBOARD, // native plugin lifted the overlay
      safeAreaTopPx: NOTCH,
      fullBleed: false,
    };
    const { topMargin, panelMaxH } = resolveChatPanelLayout(input);
    const top = panelTopFromBottom(input, panelMaxH);

    // The header lands exactly `topMargin` below the screen top — never above
    // it — so the buttons stay reachable below the notch.
    expect(top).toBe(SCREEN_H - topMargin);
    expect(SCREEN_H - top).toBeGreaterThanOrEqual(NOTCH);
  });

  it("demonstrates the pre-fix geometry pushed the header off the top of the screen", () => {
    // Without subtracting the un-reported lift, panelMaxH would have been sized
    // against the full (stale) height while the overlay was ALSO lifted by the
    // keyboard, putting the panel top a full keyboard-height above the screen.
    const buggyPanelMaxH = SCREEN_H - 12 - SHEET_TOP_MARGIN; // old formula
    const buggyTop = KEYBOARD + 12 + buggyPanelMaxH;
    expect(buggyTop).toBeGreaterThan(SCREEN_H); // header was off-screen (above)

    const fixed = resolveChatPanelLayout({
      viewportH: SCREEN_H,
      bottomPad: 12,
      keyboardInset: 0,
      effectiveKeyboardInset: KEYBOARD,
      safeAreaTopPx: NOTCH,
      fullBleed: false,
    });
    const fixedTop = KEYBOARD + 12 + fixed.panelMaxH;
    expect(fixedTop).toBeLessThanOrEqual(SCREEN_H);
  });

  it("does not double-subtract on Android (adjustResize already shrank the layout)", () => {
    // Android: visualViewport shrinks (keyboardInset = K) and there is no extra
    // native lift beyond it, so nothing extra is subtracted.
    const { panelMaxH } = resolveChatPanelLayout({
      viewportH: SCREEN_H - KEYBOARD, // already shrank
      bottomPad: 12,
      keyboardInset: KEYBOARD,
      effectiveKeyboardInset: KEYBOARD,
      safeAreaTopPx: 0,
      fullBleed: false,
    });
    expect(panelMaxH).toBe(SCREEN_H - KEYBOARD - 12 - SHEET_TOP_MARGIN);
  });

  it("does not double-subtract on iOS once the visual viewport DOES update", () => {
    const { panelMaxH } = resolveChatPanelLayout({
      viewportH: SCREEN_H - KEYBOARD,
      bottomPad: 12,
      keyboardInset: KEYBOARD,
      effectiveKeyboardInset: KEYBOARD,
      safeAreaTopPx: NOTCH,
      fullBleed: false,
    });
    expect(panelMaxH).toBe(
      SCREEN_H - KEYBOARD - 12 - Math.max(SHEET_TOP_MARGIN, NOTCH + 8),
    );
  });

  it("full-bleed drops the top margin and bottom padding but still corrects the unreported keyboard lift", () => {
    const input: ChatPanelLayoutInput = {
      viewportH: SCREEN_H,
      bottomPad: BOTTOM_PAD,
      keyboardInset: 0,
      effectiveKeyboardInset: KEYBOARD,
      safeAreaTopPx: NOTCH,
      fullBleed: true,
    };
    const { topMargin, panelMaxH } = resolveChatPanelLayout(input);
    expect(topMargin).toBe(0);
    // Fills to the screen top (top === SCREEN_H), never above it.
    expect(panelMaxH).toBe(SCREEN_H - KEYBOARD);
    expect(panelTopFromBottom(input, panelMaxH)).toBe(SCREEN_H);
  });

  it("clamps to a minimum usable height on a tiny viewport", () => {
    const { panelMaxH } = resolveChatPanelLayout({
      viewportH: 120,
      bottomPad: 12,
      keyboardInset: 0,
      effectiveKeyboardInset: 0,
      safeAreaTopPx: 0,
      fullBleed: false,
    });
    expect(panelMaxH).toBe(200);
  });

  it("treats a non-finite safe-area measurement as zero", () => {
    const { topMargin } = resolveChatPanelLayout({
      viewportH: 800,
      bottomPad: 0,
      keyboardInset: 0,
      effectiveKeyboardInset: 0,
      safeAreaTopPx: Number.NaN,
      fullBleed: false,
    });
    expect(topMargin).toBe(SHEET_TOP_MARGIN);
  });
});
