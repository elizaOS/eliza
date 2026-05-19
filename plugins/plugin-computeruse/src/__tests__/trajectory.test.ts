import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform/screenshot.js", () => ({
  captureScreenshot: vi.fn(() => Buffer.from("screen")),
}));

vi.mock("../platform/a11y.js", () => ({
  extractA11yTree: vi.fn(() => "window tree"),
  isA11yAvailable: vi.fn(() => true),
}));

const { OSWorldAdapter } = await import("../osworld/adapter.js");

describe("OSWorld trajectory capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records each step with action, observation, and timestamp", async () => {
    const service = {
      executeDesktopAction: vi.fn(async () => ({
        success: true,
        message: "done",
      })),
    };
    const adapter = new OSWorldAdapter(service as never, {
      actionSpace: "computer_13",
      observationType: "screenshot_a11y_tree",
      includeA11yTree: true,
      screenshotDelayMs: 0,
      maxTrajectoryLength: 5,
    });

    await adapter.step({ action_type: "MOVE_TO", x: 12, y: 34 }, "move");
    await adapter.step("WAIT", "wait");

    expect(service.executeDesktopAction).toHaveBeenCalledWith({
      action: "mouse_move",
      coordinate: [12, 34],
    });

    const trajectory = adapter.getTrajectory();
    expect(trajectory).toHaveLength(2);
    expect(trajectory[0]).toMatchObject({
      action: { action_type: "MOVE_TO", x: 12, y: 34 },
      observation: {
        screenshot: Buffer.from("screen").toString("base64"),
        accessibility_tree: "window tree",
        instruction: "move",
      },
    });
    expect(typeof trajectory[0]?.timestamp).toBe("number");
    expect(trajectory[1]).toMatchObject({
      action: "WAIT",
      observation: { instruction: "wait" },
    });
  });
});
