/**
 * OSWorld action conversion + adapter, with the screenshot platform mocked.
 * Deterministic unit test of the OSWorld to ComputerInterface translation.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fromOSWorldAction,
  type OSWorldPointerState,
} from "../osworld/action-converter.js";
import { OSWorldAdapter } from "../osworld/adapter.js";

vi.mock("../platform/screenshot.js", () => ({
  captureScreenshot: vi.fn(() => Buffer.from("screen")),
}));

vi.mock("../platform/a11y.js", () => ({
  extractA11yTree: vi.fn(() => "window tree"),
  isA11yAvailable: vi.fn(() => true),
}));

describe("OSWorld action conversion", () => {
  it("keeps stateless mouse up/down conversion compatible", () => {
    expect(
      fromOSWorldAction({ action_type: "MOUSE_DOWN", x: 10, y: 20 }),
    ).toEqual({
      action: "mouse_move",
      coordinate: [10, 20],
    });
    expect(
      fromOSWorldAction({ action_type: "MOUSE_UP", x: 30, y: 40 }),
    ).toEqual({
      action: "click",
      coordinate: [30, 40],
    });
  });

  it("combines stateful mouse down/up into a drag", () => {
    const pointerState: OSWorldPointerState = {};

    expect(
      fromOSWorldAction(
        { action_type: "MOUSE_DOWN", x: 10, y: 20 },
        pointerState,
      ),
    ).toEqual({
      action: "mouse_move",
      coordinate: [10, 20],
    });
    expect(pointerState.mouseDownAt).toEqual([10, 20]);

    expect(
      fromOSWorldAction(
        { action_type: "MOUSE_UP", x: 30, y: 40 },
        pointerState,
      ),
    ).toEqual({
      action: "drag",
      startCoordinate: [10, 20],
      coordinate: [30, 40],
    });
    expect(pointerState.mouseDownAt).toBeUndefined();
  });

  it("executes OSWorld mouse down/up through the adapter as a drag", async () => {
    const service = {
      executeDesktopAction: vi.fn(async () => ({
        success: true,
        message: "done",
      })),
    };
    const adapter = new OSWorldAdapter(service as never, {
      screenshotDelayMs: 0,
    });

    await adapter.executeAction({ action_type: "MOUSE_DOWN", x: 10, y: 20 });
    await adapter.executeAction({ action_type: "MOUSE_UP", x: 30, y: 40 });

    expect(service.executeDesktopAction).toHaveBeenNthCalledWith(1, {
      action: "mouse_move",
      coordinate: [10, 20],
    });
    expect(service.executeDesktopAction).toHaveBeenNthCalledWith(2, {
      action: "drag",
      startCoordinate: [10, 20],
      coordinate: [30, 40],
    });
  });

  it("clears pending mouse-down state on adapter reset", async () => {
    const service = {
      executeDesktopAction: vi.fn(async () => ({
        success: true,
        message: "done",
      })),
    };
    const adapter = new OSWorldAdapter(service as never, {
      screenshotDelayMs: 0,
    });

    await adapter.executeAction({ action_type: "MOUSE_DOWN", x: 10, y: 20 });
    adapter.reset();
    await adapter.executeAction({ action_type: "MOUSE_UP", x: 30, y: 40 });

    expect(service.executeDesktopAction).toHaveBeenLastCalledWith({
      action: "click",
      coordinate: [30, 40],
    });
  });
});
