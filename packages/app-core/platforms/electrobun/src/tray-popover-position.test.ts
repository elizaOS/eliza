import { describe, expect, it } from "vitest";
import { computeTrayPopoverFrame } from "./tray-popover-position";

const SIZE = { w: 360, h: 480, margin: 8 } as const;

describe("computeTrayPopoverFrame", () => {
  // Primary 1440x900 display, 24px menu bar excluded from the work area.
  const primaryHeight = 900;
  const workArea = { x: 0, y: 24, width: 1440, height: 876 };

  it("centers the popover under a tray icon and hangs it below the menu bar", () => {
    // A tray icon 900px from the left, 22px tall menu-bar item. In bottom-left
    // screen coords its y is near the top of the display (900 - 22 = 878).
    const trayBounds = { x: 900, y: 878, width: 30, height: 22 };
    const frame = computeTrayPopoverFrame(
      trayBounds,
      workArea,
      SIZE,
      primaryHeight,
    );

    // x centered under the icon: 900 + 30/2 - 360/2 = 735.
    expect(frame.x).toBe(735);
    // y: iconBottomTopLeft = 900 - 878 = 22; + margin = 30; clamped to
    // workArea.y + margin = 32 (the menu bar is excluded from the work area).
    expect(frame.y).toBe(32);
    expect(frame.width).toBe(360);
    expect(frame.height).toBe(480);
  });

  it("clamps x so a right-edge icon never spills off-screen", () => {
    // Icon hard against the right edge of the menu bar.
    const trayBounds = { x: 1430, y: 878, width: 20, height: 22 };
    const frame = computeTrayPopoverFrame(
      trayBounds,
      workArea,
      SIZE,
      primaryHeight,
    );
    // Right-clamped: workArea.x + width - w - margin = 0 + 1440 - 360 - 8 = 1072.
    expect(frame.x).toBe(1072);
    expect(frame.x + frame.width + SIZE.margin).toBeLessThanOrEqual(
      workArea.x + workArea.width,
    );
  });

  it("clamps x so a left-edge icon never spills off-screen", () => {
    const trayBounds = { x: 2, y: 878, width: 20, height: 22 };
    const frame = computeTrayPopoverFrame(
      trayBounds,
      workArea,
      SIZE,
      primaryHeight,
    );
    // Left-clamped to workArea.x + margin = 8.
    expect(frame.x).toBe(8);
  });

  it("clamps y down to the work-area bottom when the converted anchor would spill below", () => {
    // A pathological tray whose bottom-left y is near the screen bottom (10)
    // converts to a top-left anchor near the bottom of the display; the frame
    // must clamp UP to maxY so the popover stays fully inside the work area.
    const trayBounds = { x: 700, y: 10, width: 30, height: 22 };
    const frame = computeTrayPopoverFrame(
      trayBounds,
      workArea,
      SIZE,
      primaryHeight,
    );
    const maxY = workArea.y + workArea.height - SIZE.h - SIZE.margin;
    expect(frame.y).toBe(maxY);
    expect(frame.y).toBeLessThanOrEqual(maxY);
    expect(frame.y).toBeGreaterThanOrEqual(workArea.y + SIZE.margin);
  });

  it("falls back to the top-right of the work area for a zero-rect (Windows/Linux stub)", () => {
    const frame = computeTrayPopoverFrame(
      { x: 0, y: 0, width: 0, height: 0 },
      workArea,
      SIZE,
      primaryHeight,
    );
    // Top-right corner: x = 0 + 1440 - 360 - 8 = 1072; y = workArea.y + margin.
    expect(frame.x).toBe(1072);
    expect(frame.y).toBe(32);
    expect(frame.width).toBe(360);
    expect(frame.height).toBe(480);
  });

  it("honors the work-area origin on a secondary display (multi-monitor)", () => {
    const secondary = { x: 1920, y: 24, width: 1920, height: 1056 };
    const trayBounds = { x: 3200, y: 1058, width: 30, height: 22 };
    const frame = computeTrayPopoverFrame(
      trayBounds,
      secondary,
      SIZE,
      1080,
    );
    // x centered: 3200 + 15 - 180 = 3035, inside [1928, 3552].
    expect(frame.x).toBe(3035);
    expect(frame.x).toBeGreaterThanOrEqual(secondary.x + SIZE.margin);
  });
});
