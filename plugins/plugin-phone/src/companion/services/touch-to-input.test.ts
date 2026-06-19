import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type InputEvent,
  type TouchSample,
  touchToInput,
} from "./session-client";

function sample(x: number, y: number, t: number, pointerId = 0): TouchSample {
  return { x, y, t, pointerId };
}

describe("touchToInput", () => {
  it("translates a single-finger tap into a left click at the release point", () => {
    const events = touchToInput({
      pointers: [[sample(10, 20, 0), sample(11, 21, 50)]],
      ended: true,
    });
    expect(events).toEqual<InputEvent[]>([
      { type: "mouse-click", x: 11, y: 21, button: "left" },
    ]);
  });

  it("translates a single-finger long-press (>=500ms, within slop) into a right click", () => {
    const events = touchToInput({
      pointers: [[sample(40, 40, 0), sample(42, 41, 600)]],
      ended: true,
    });
    expect(events).toEqual<InputEvent[]>([
      { type: "mouse-click", x: 42, y: 41, button: "right" },
    ]);
  });

  it("translates a two-finger simultaneous tap into a middle click", () => {
    const events = touchToInput({
      pointers: [
        [sample(100, 100, 0, 0), sample(101, 100, 30, 0)],
        [sample(140, 100, 0, 1), sample(141, 101, 30, 1)],
      ],
      ended: true,
    });
    expect(events).toEqual<InputEvent[]>([
      { type: "mouse-click", x: 101, y: 100, button: "middle" },
    ]);
  });

  it("translates a single-finger pan (> slop) into a mouse drag with from/to coords", () => {
    const events = touchToInput({
      pointers: [[sample(10, 10, 0), sample(120, 80, 200)]],
      ended: true,
    });
    expect(events).toEqual<InputEvent[]>([
      { type: "mouse-drag", fromX: 10, fromY: 10, toX: 120, toY: 80 },
    ]);
  });

  it("returns no events for a gesture that has not ended", () => {
    expect(
      touchToInput({ pointers: [[sample(0, 0, 0)]], ended: false }),
    ).toEqual([]);
  });

  it("returns no events for empty pointer data", () => {
    expect(touchToInput({ pointers: [], ended: true })).toEqual([]);
    expect(touchToInput({ pointers: [[]], ended: true })).toEqual([]);
  });

  it("returns no events for a two-finger gesture where one finger pans", () => {
    const events = touchToInput({
      pointers: [
        [sample(0, 0, 0, 0), sample(2, 2, 20, 0)], // tap
        [sample(50, 50, 0, 1), sample(150, 150, 20, 1)], // pan
      ],
      ended: true,
    });
    expect(events).toEqual([]);
  });

  it("respects a custom tap slop boundary", () => {
    // Displacement of 5px is a pan at slop=4 but a tap at the default slop (6).
    const gesture = {
      pointers: [[sample(0, 0, 0), sample(5, 0, 10)]],
      ended: true as const,
    };
    expect(touchToInput(gesture, { tapSlopPx: 4 })[0].type).toBe("mouse-drag");
    expect(touchToInput(gesture)[0].type).toBe("mouse-click");
  });

  it("property: an ended single/double-finger gesture yields 0 or 1 events", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(
            fc.record({
              x: fc.integer({ min: 0, max: 1000 }),
              y: fc.integer({ min: 0, max: 1000 }),
              t: fc.integer({ min: 0, max: 2000 }),
            }),
            { minLength: 0, maxLength: 6 },
          ),
          { minLength: 0, maxLength: 3 },
        ),
        (raw) => {
          const pointers = raw.map((samples, pid) =>
            samples.map((s) => ({ ...s, pointerId: pid })),
          );
          const events = touchToInput({ pointers, ended: true });
          expect(events.length).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
