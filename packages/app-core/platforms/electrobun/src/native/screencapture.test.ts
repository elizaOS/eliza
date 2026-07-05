/** Deterministic state-machine tests for desktop frame capture admission. */

import { describe, expect, it, vi } from "vitest";
import { ScreenCaptureManager } from "./screencapture";

vi.mock("electrobun/bun", () => ({
  BrowserWindow: vi.fn(),
}));

describe("ScreenCaptureManager frame capture", () => {
  it("does not wedge active after a blocked game capture URL", async () => {
    const manager = new ScreenCaptureManager();

    const first = await manager.startFrameCapture({
      gameUrl: "https://evil.example/game",
    });
    const afterFirst = await manager.isFrameCaptureActive();
    const second = await manager.startFrameCapture({
      gameUrl: "https://evil.example/game",
    });
    const afterSecond = await manager.isFrameCaptureActive();

    expect(first).toMatchObject({ available: false });
    expect(afterFirst.active).toBe(false);
    expect(second).toMatchObject({ available: false });
    expect(afterSecond.active).toBe(false);
  });
});
