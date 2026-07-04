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

  it("prefers a usable height on a tight viewport by eating the top margin", () => {
    // 260px of space: the 200px preference wins over (260-12-72)=176, and the
    // whole 200 still fits on screen — the floor may consume the top margin.
    const input: ChatPanelLayoutInput = {
      viewportH: 260,
      bottomPad: 12,
      keyboardInset: 0,
      effectiveKeyboardInset: 0,
      safeAreaTopPx: 0,
      fullBleed: false,
    };
    const { panelMaxH } = resolveChatPanelLayout(input);
    expect(panelMaxH).toBe(200);
    expect(panelTopFromBottom(input, panelMaxH)).toBeLessThanOrEqual(260);
  });

  it("never sizes the panel beyond the viewport on a tiny viewport", () => {
    // A 120px viewport cannot hold a 200px panel: a bottom-anchored panel
    // taller than the screen puts its top (grabber/header/thread) off-screen
    // above, which is strictly worse than a short panel.
    const input: ChatPanelLayoutInput = {
      viewportH: 120,
      bottomPad: 12,
      keyboardInset: 0,
      effectiveKeyboardInset: 0,
      safeAreaTopPx: 0,
      fullBleed: false,
    };
    const { panelMaxH } = resolveChatPanelLayout(input);
    expect(panelMaxH).toBe(120 - 12);
    expect(panelTopFromBottom(input, panelMaxH)).toBeLessThanOrEqual(120);
  });

  it("keeps the whole panel on-screen on a landscape phone with the keyboard up (device failure geometry)", () => {
    // Real numbers from the iPhone 15 Pro failure (GestureSemanticsUITests/
    // testMessageEditAffordanceRevealsViaTouch): 852x393 landscape window,
    // 276pt keyboard intrusion reported by the visual viewport (117pt left),
    // 12px composer-focused bottom padding, no top safe-area in landscape.
    // The old MIN floor produced a 200px panel whose top landed 95px above the
    // window — the AX tree showed every message bubble (and the grabber and
    // header) at negative y, unhittable.
    const input: ChatPanelLayoutInput = {
      viewportH: 117,
      bottomPad: 12,
      keyboardInset: 276,
      effectiveKeyboardInset: 276,
      safeAreaTopPx: 0,
      fullBleed: false,
    };
    const { panelMaxH } = resolveChatPanelLayout(input);
    expect(panelMaxH).toBe(117 - 12);
    // Screen height = visual viewport (117) + keyboard (276) = 393. The panel
    // top must land at or below the screen top.
    expect(panelTopFromBottom(input, panelMaxH)).toBeLessThanOrEqual(393);
  });

  it("demonstrates the pre-fix landscape-keyboard geometry pushed the panel top off-screen", () => {
    // Old formula: max(MIN, viewportH - bottomPad - topMargin - unreportedLift)
    // = max(200, 117-12-72-0) = 200 → top at 276+12+200 = 488 on a 393pt-tall
    // screen: 95px of panel (grabber, header, the entire thread window) above
    // the top edge — matching the -96px panel top in the device AX dump.
    const buggyPanelMaxH = Math.max(200, 117 - 12 - SHEET_TOP_MARGIN);
    expect(276 + 12 + buggyPanelMaxH).toBeGreaterThan(393);
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
