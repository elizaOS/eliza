/**
 * Window-scoped capture asks the display for the window's *entire* size even
 * when the window runs past the display's right/bottom edge (a window dragged
 * partly offscreen, or one spanning two displays). The captured region then
 * extends outside the display, so the frame the model grounds on carries a
 * band of pixels that is not part of the display.
 */

import { describe, expect, it, vi } from "vitest";
import type { DisplayInfo } from "../platform/displays.js";
import type { NativeAppSnapshot } from "./types.js";

const listDisplays = vi.fn();
const captureDisplayRegion = vi.fn();

vi.mock("../platform/displays.js", () => ({
  listDisplays: (...args: unknown[]) => listDisplays(...args),
}));
vi.mock("../platform/capture.js", () => ({
  captureDisplayRegion: (...args: unknown[]) => captureDisplayRegion(...args),
}));

const { WindowRegionCapture } = await import("./defaults.js");

const secondDisplay: DisplayInfo = {
  id: 7,
  bounds: [1920, 0, 1920, 1080],
  scaleFactor: 1,
  primary: false,
  name: "DELL U2720Q",
};

function snapshotWith(
  focusedWindowBounds: NativeAppSnapshot["focusedWindowBounds"],
): NativeAppSnapshot {
  return { elements: [], axText: "", focusedWindowBounds } as NativeAppSnapshot;
}

describe("WindowRegionCapture.capture", () => {
  it("clamps the region to the pixels the display actually has", async () => {
    listDisplays.mockReturnValue([secondDisplay]);
    captureDisplayRegion.mockResolvedValue({
      display: secondDisplay,
      frame: Buffer.from([1, 2, 3]),
    });

    const captured = await new WindowRegionCapture().capture(
      snapshotWith({ x: 2900, y: 100, width: 1500, height: 900 }),
    );

    expect(captured).not.toBeNull();
    expect(captureDisplayRegion).toHaveBeenCalledWith(7, {
      x: 980,
      y: 100,
      width: 940,
      height: 900,
    });
    // The state's screenshot origin stays the window's global origin so OCR
    // boxes keep mapping back to global AX bounds.
    expect(captured?.bounds).toEqual({
      x: 2900,
      y: 100,
      width: 1500,
      height: 900,
    });
  });

  it("still asks for the full window when it fits on the display", async () => {
    listDisplays.mockReturnValue([secondDisplay]);
    captureDisplayRegion.mockResolvedValue({
      display: secondDisplay,
      frame: Buffer.from([1, 2, 3]),
    });

    await new WindowRegionCapture().capture(
      snapshotWith({ x: 2000, y: 50, width: 800, height: 600 }),
    );

    expect(captureDisplayRegion).toHaveBeenCalledWith(7, {
      x: 80,
      y: 50,
      width: 800,
      height: 600,
    });
  });
});
