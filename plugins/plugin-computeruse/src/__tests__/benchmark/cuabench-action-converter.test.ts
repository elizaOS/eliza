import { describe, expect, it } from "vitest";
import {
  fromCuaBenchAction,
  parseCuaBenchActionString,
} from "../../benchmarks/cuabench-action-converter.js";

describe("CuaBench action converter", () => {
  it("maps CuaBench dict actions to desktop actions", () => {
    expect(
      fromCuaBenchAction({ type: "ClickAction", x: 100, y: 200 }),
    ).toEqual({
      kind: "desktop",
      params: { action: "click", coordinate: [100, 200] },
    });
    expect(
      fromCuaBenchAction({ type: "MiddleClickAction", x: 3, y: 4 }),
    ).toEqual({
      kind: "desktop",
      params: { action: "middle_click", coordinate: [3, 4] },
    });
    expect(
      fromCuaBenchAction({
        type: "DragAction",
        from_x: 10,
        from_y: 20,
        to_x: 30,
        to_y: 40,
      }),
    ).toEqual({
      kind: "desktop",
      params: {
        action: "drag",
        startCoordinate: [10, 20],
        coordinate: [30, 40],
      },
    });
  });

  it("maps keyboard and control actions", () => {
    expect(fromCuaBenchAction({ type: "TypeAction", text: "hello" })).toEqual({
      kind: "desktop",
      params: { action: "type", text: "hello" },
    });
    expect(
      fromCuaBenchAction({ type: "HotkeyAction", keys: ["ctrl", "c"] }),
    ).toEqual({
      kind: "desktop",
      params: { action: "key_combo", key: "ctrl+c" },
    });
    expect(fromCuaBenchAction({ type: "WaitAction", seconds: 2.5 })).toEqual({
      kind: "control",
      control: { kind: "wait", seconds: 2.5 },
    });
    expect(fromCuaBenchAction({ type: "DoneAction" })).toEqual({
      kind: "control",
      control: { kind: "done" },
    });
  });

  it("parses upstream repr strings", () => {
    expect(parseCuaBenchActionString("ClickAction(x=100, y=200)")).toEqual({
      type: "ClickAction",
      x: 100,
      y: 200,
    });
    expect(
      parseCuaBenchActionString(
        "DragAction(from_x=10, from_y=20, to_x=30, to_y=40, duration=2.5)",
      ),
    ).toMatchObject({
      type: "DragAction",
      from_x: 10,
      from_y: 20,
      to_x: 30,
      to_y: 40,
      duration: 2.5,
    });
    expect(parseCuaBenchActionString("DoneAction()")).toEqual({
      type: "DoneAction",
    });
  });

  it("parses upstream snake_case strings", () => {
    expect(fromCuaBenchAction("middle_click(5, 6)")).toEqual({
      kind: "desktop",
      params: { action: "middle_click", coordinate: [5, 6] },
    });
    expect(fromCuaBenchAction("hotkey(ctrl+shift+z)")).toEqual({
      kind: "desktop",
      params: { action: "key_combo", key: "ctrl+shift+z" },
    });
    expect(fromCuaBenchAction("wait()")).toEqual({
      kind: "control",
      control: { kind: "wait", seconds: 1 },
    });
  });
});
