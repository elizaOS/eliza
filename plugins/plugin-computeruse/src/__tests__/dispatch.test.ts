/**
 * WS7 — Dispatch tests.
 *
 * Validates the `dispatch()` function — the single entry point that takes a
 * resolved `ProposedAction` and routes it to a `ComputerInterface`.
 *
 *   - unknown displayId → `unknown_display`
 *   - out-of-bounds coords → `out_of_bounds`
 *   - kind-specific arg validation → `invalid_args`
 *   - driver throw → `driver_error`
 *   - wait/finish short-circuit cleanly with `success: true`
 *   - happy path calls the right ComputerInterface method
 */

import { describe, expect, it } from "vitest";
import { dispatch } from "../actor/dispatch.js";
import type {
  ComputerInterface,
  CursorPosition,
  DisplayPoint,
  DragPath,
  ScrollDelta,
} from "../actor/computer-interface.js";
import type { DisplayDescriptor } from "../types.js";
import type { ProposedAction } from "../actor/types.js";

function fakeDisplays(): DisplayDescriptor[] {
  return [
    {
      id: 0,
      bounds: [0, 0, 1920, 1080],
      scaleFactor: 1,
      primary: true,
      name: "primary",
    },
  ];
}

interface DriverCalls {
  leftClick: DisplayPoint[];
  rightClick: DisplayPoint[];
  doubleClick: DisplayPoint[];
  typed: string[];
  pressed: string[];
  hotkeys: string[][];
  scrolls: ScrollDelta[];
  drags: DragPath[];
}

function makeIface(throwOn?: keyof DriverCalls): {
  iface: ComputerInterface;
  calls: DriverCalls;
} {
  const calls: DriverCalls = {
    leftClick: [],
    rightClick: [],
    doubleClick: [],
    typed: [],
    pressed: [],
    hotkeys: [],
    scrolls: [],
    drags: [],
  };
  const fail = async (label: keyof DriverCalls): Promise<void> => {
    if (throwOn === label) {
      throw new Error(`driver-failure:${label}`);
    }
  };
  const iface: ComputerInterface = {
    screenshot: async () => {
      throw new Error("not used");
    },
    mouseDown: async () => {},
    mouseUp: async () => {},
    leftClick: async (p) => {
      calls.leftClick.push(p);
      await fail("leftClick");
    },
    rightClick: async (p) => {
      calls.rightClick.push(p);
      await fail("rightClick");
    },
    doubleClick: async (p) => {
      calls.doubleClick.push(p);
      await fail("doubleClick");
    },
    moveCursor: async () => {},
    dragTo: async () => {},
    drag: async (path) => {
      calls.drags.push(path);
      await fail("drags");
    },
    keyDown: async () => {},
    keyUp: async () => {},
    typeText: async ({ text }) => {
      calls.typed.push(text);
      await fail("typed");
    },
    pressKey: async ({ key }) => {
      calls.pressed.push(key);
      await fail("pressed");
    },
    hotkey: async ({ keys }) => {
      calls.hotkeys.push([...keys]);
      await fail("hotkeys");
    },
    scroll: async (delta) => {
      calls.scrolls.push(delta);
      await fail("scrolls");
    },
    scrollUp: async () => {},
    scrollDown: async () => {},
    getScreenSize: () => ({ w: 1920, h: 1080 }),
    getCursorPosition: (): CursorPosition => ({ displayId: 0, x: 0, y: 0 }),
    toScreenCoordinates: () => ({ x: 0, y: 0 }),
    toScreenshotCoordinates: () => ({ imgX: 0, imgY: 0 }),
    getAccessibilityTree: () => [],
  };
  return { iface, calls };
}

describe("dispatch — display + bounds validation", () => {
  it("rejects unknown displayId for coord-bearing actions", async () => {
    const { iface } = makeIface();
    const action: ProposedAction = {
      kind: "click",
      displayId: 99,
      x: 10,
      y: 20,
      rationale: "",
    };
    const res = await dispatch(action, {
      interface: iface,
      listDisplays: () => fakeDisplays(),
    });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("unknown_display");
  });

  it("permits unknown displayId for wait / finish", async () => {
    const { iface } = makeIface();
    const res = await dispatch(
      { kind: "wait", displayId: 99, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(res.success).toBe(true);
  });

  it("rejects out-of-bounds click coords", async () => {
    const { iface } = makeIface();
    const res = await dispatch(
      { kind: "click", displayId: 0, x: 5000, y: 10, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("out_of_bounds");
  });

  it("rejects negative click coords", async () => {
    const { iface } = makeIface();
    const res = await dispatch(
      { kind: "click", displayId: 0, x: -1, y: 10, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("out_of_bounds");
  });
});

describe("dispatch — happy paths", () => {
  it("click routes to leftClick", async () => {
    const { iface, calls } = makeIface();
    const res = await dispatch(
      { kind: "click", displayId: 0, x: 100, y: 200, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(res.success).toBe(true);
    expect(calls.leftClick).toHaveLength(1);
    expect(calls.leftClick[0]).toMatchObject({ displayId: 0, x: 100, y: 200 });
  });

  it("double_click routes to doubleClick", async () => {
    const { iface, calls } = makeIface();
    await dispatch(
      { kind: "double_click", displayId: 0, x: 50, y: 50, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(calls.doubleClick).toHaveLength(1);
  });

  it("right_click routes to rightClick", async () => {
    const { iface, calls } = makeIface();
    await dispatch(
      { kind: "right_click", displayId: 0, x: 50, y: 50, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(calls.rightClick).toHaveLength(1);
  });

  it("type routes to typeText", async () => {
    const { iface, calls } = makeIface();
    await dispatch(
      { kind: "type", displayId: 0, text: "hi", rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(calls.typed).toEqual(["hi"]);
  });

  it("key routes to pressKey", async () => {
    const { iface, calls } = makeIface();
    await dispatch(
      { kind: "key", displayId: 0, key: "Enter", rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(calls.pressed).toEqual(["Enter"]);
  });

  it("hotkey routes to hotkey", async () => {
    const { iface, calls } = makeIface();
    await dispatch(
      { kind: "hotkey", displayId: 0, keys: ["ctrl", "s"], rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(calls.hotkeys).toEqual([["ctrl", "s"]]);
  });

  it("scroll routes to scroll with delta", async () => {
    const { iface, calls } = makeIface();
    await dispatch(
      { kind: "scroll", displayId: 0, x: 50, y: 50, dx: 0, dy: 3, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(calls.scrolls).toHaveLength(1);
    expect(calls.scrolls[0]).toMatchObject({ displayId: 0, dx: 0, dy: 3 });
  });

  it("drag routes to drag with start + end", async () => {
    const { iface, calls } = makeIface();
    await dispatch(
      {
        kind: "drag",
        displayId: 0,
        startX: 10,
        startY: 20,
        x: 100,
        y: 200,
        rationale: "",
      },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(calls.drags).toHaveLength(1);
    expect(calls.drags[0]?.path).toEqual([
      { x: 10, y: 20 },
      { x: 100, y: 200 },
    ]);
  });
});

describe("dispatch — invalid_args", () => {
  it("type without text", async () => {
    const { iface } = makeIface();
    const res = await dispatch(
      { kind: "type", displayId: 0, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
  });

  it("key without key", async () => {
    const { iface } = makeIface();
    const res = await dispatch(
      { kind: "key", displayId: 0, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(res.error?.code).toBe("invalid_args");
  });

  it("hotkey with empty keys", async () => {
    const { iface } = makeIface();
    const res = await dispatch(
      { kind: "hotkey", displayId: 0, keys: [], rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(res.error?.code).toBe("invalid_args");
  });

  it("click without coords", async () => {
    const { iface } = makeIface();
    const res = await dispatch(
      { kind: "click", displayId: 0, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(res.error?.code).toBe("invalid_args");
  });

  it("scroll without dx/dy", async () => {
    const { iface } = makeIface();
    const res = await dispatch(
      { kind: "scroll", displayId: 0, x: 10, y: 10, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(res.error?.code).toBe("invalid_args");
  });
});

describe("dispatch — driver_error wrap", () => {
  it("wraps an interface throw in driver_error", async () => {
    const { iface } = makeIface("leftClick");
    const res = await dispatch(
      { kind: "click", displayId: 0, x: 10, y: 10, rationale: "" },
      { interface: iface, listDisplays: () => fakeDisplays() },
    );
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("driver_error");
    expect(res.error?.message).toContain("leftClick");
  });
});
