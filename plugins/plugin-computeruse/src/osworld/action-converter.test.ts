/**
 * Round-trips OSWorld / PyAutoGUI actions through the converter to and from
 * DesktopActionParams. Deterministic unit test.
 */
import { describe, expect, it } from "vitest";
import type { DesktopActionParams } from "../types.js";
import {
  fromOSWorldAction,
  fromPyAutoGUI,
  toOSWorldAction,
} from "./action-converter.js";

const p = (o: Record<string, unknown>) => o as DesktopActionParams;
const osw = (o: Record<string, unknown>) =>
  o as Parameters<typeof fromOSWorldAction>[0];

// #9170/#9105 cua parity — our DesktopActionParams must map to OSWorld actions
// and parse back from pyautogui code. Lock both directions.
describe("toOSWorldAction", () => {
  it("maps pointer actions with coordinates", () => {
    expect(
      toOSWorldAction(p({ action: "click", coordinate: [10, 20] })),
    ).toEqual({ action_type: "CLICK", x: 10, y: 20 });
    expect(
      toOSWorldAction(p({ action: "double_click", coordinate: [1, 2] })),
    ).toMatchObject({ action_type: "DOUBLE_CLICK", x: 1, y: 2 });
    expect(
      toOSWorldAction(p({ action: "right_click", coordinate: [3, 4] })),
    ).toMatchObject({ action_type: "RIGHT_CLICK" });
    expect(
      toOSWorldAction(p({ action: "mouse_move", coordinate: [5, 6] })),
    ).toMatchObject({ action_type: "MOVE_TO", x: 5, y: 6 });
  });

  it("maps text/key/hotkey actions", () => {
    expect(toOSWorldAction(p({ action: "type", text: "hi" }))).toEqual({
      action_type: "TYPING",
      text: "hi",
    });
    expect(toOSWorldAction(p({ action: "key", key: "Return" }))).toEqual({
      action_type: "PRESS",
      key: "Return",
    });
    expect(toOSWorldAction(p({ action: "key_combo", key: "ctrl+c" }))).toEqual({
      action_type: "HOTKEY",
      keys: ["ctrl", "c"],
    });
  });

  it("maps drag to a start point + delta, and screenshot to WAIT", () => {
    expect(
      toOSWorldAction(
        p({ action: "drag", startCoordinate: [0, 0], coordinate: [10, 5] }),
      ),
    ).toEqual({ action_type: "DRAG_TO", x: 0, y: 0, dx: 10, dy: 5 });
    expect(toOSWorldAction(p({ action: "screenshot" }))).toEqual({
      action_type: "WAIT",
    });
  });
});

describe("fromPyAutoGUI", () => {
  it("returns null for control-flow strings", () => {
    for (const s of ["WAIT", "DONE", "FAIL"]) {
      expect(fromPyAutoGUI(s)).toBeNull();
    }
  });

  it("parses pointer calls", () => {
    expect(fromPyAutoGUI("pyautogui.click(100, 200)")).toEqual({
      action: "click",
      coordinate: [100, 200],
    });
    expect(fromPyAutoGUI("pyautogui.doubleClick(1, 2)")).toMatchObject({
      action: "double_click",
    });
    expect(fromPyAutoGUI("pyautogui.rightClick(3, 4)")).toMatchObject({
      action: "right_click",
    });
    expect(fromPyAutoGUI("pyautogui.moveTo(5, 6)")).toMatchObject({
      action: "mouse_move",
      coordinate: [5, 6],
    });
  });

  it("parses text/key/hotkey calls", () => {
    expect(fromPyAutoGUI("pyautogui.typewrite('hello')")).toEqual({
      action: "type",
      text: "hello",
    });
    expect(fromPyAutoGUI("pyautogui.write('hi')")).toMatchObject({
      action: "type",
      text: "hi",
    });
    expect(fromPyAutoGUI("pyautogui.press('return')")).toEqual({
      action: "key",
      key: "return",
    });
    expect(fromPyAutoGUI("pyautogui.hotkey('ctrl', 'c')")).toEqual({
      action: "key_combo",
      key: "ctrl+c",
    });
  });
});

describe("fromOSWorldAction + round-trip", () => {
  it("maps OSWorld pointer/text actions back to DesktopActionParams", () => {
    expect(
      fromOSWorldAction(osw({ action_type: "CLICK", x: 10, y: 20 })),
    ).toEqual({ action: "click", coordinate: [10, 20] });
    expect(
      fromOSWorldAction(osw({ action_type: "MOVE_TO", x: 5, y: 6 })),
    ).toMatchObject({ action: "mouse_move", coordinate: [5, 6] });
    expect(
      fromOSWorldAction(osw({ action_type: "TYPING", text: "hi" })),
    ).toEqual({ action: "type", text: "hi" });
    expect(
      fromOSWorldAction(osw({ action_type: "PRESS", key: "Return" })),
    ).toEqual({ action: "key", key: "Return" });
  });

  it("reconstructs the drag end point from start + delta", () => {
    expect(
      fromOSWorldAction(
        osw({ action_type: "DRAG_TO", x: 0, y: 0, dx: 10, dy: 5 }),
      ),
    ).toEqual({ action: "drag", startCoordinate: [0, 0], coordinate: [10, 5] });
  });

  it("round-trips our actions through OSWorld and back (parity)", () => {
    const cases: DesktopActionParams[] = [
      p({ action: "click", coordinate: [10, 20] }),
      p({ action: "double_click", coordinate: [1, 2] }),
      p({ action: "right_click", coordinate: [3, 4] }),
      p({ action: "mouse_move", coordinate: [5, 6] }),
      p({ action: "type", text: "hello" }),
    ];
    for (const c of cases) {
      expect(fromOSWorldAction(toOSWorldAction(c))).toEqual(c);
    }
  });
});
