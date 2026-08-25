/**
 * Verifies desktop devtools frame-refresh scheduling with deterministic mocked
 * window geometry and timer callbacks.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEVTOOLS_LAYOUT_REFRESH_DELAYS_MS,
  scheduleDevtoolsLayoutRefresh,
} from "../devtools-layout.ts";

function collectWindow(initial: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const calls: number[][] = [];
  let frame = { ...initial };
  return {
    window: {
      getFrame: () => frame,
      setFrame: (x: number, y: number, width: number, height: number) => {
        frame = { x, y, width, height };
        calls.push([x, y, width, height]);
      },
    },
    calls,
  };
}

describe("scheduleDevtoolsLayoutRefresh", () => {
  it("schedules every refresh and nudges the height at 32 ms", () => {
    const { window, calls } = collectWindow({
      x: 1,
      y: 2,
      width: 300,
      height: 400,
    });
    const scheduled: (() => void)[] = [];
    scheduleDevtoolsLayoutRefresh(window, (cb) => {
      scheduled.push(cb);
      return 0;
    });
    expect(scheduled).toHaveLength(DEVTOOLS_LAYOUT_REFRESH_DELAYS_MS.length);
    scheduled.forEach((cb) => {
      cb();
    });
    expect(calls).toHaveLength(DEVTOOLS_LAYOUT_REFRESH_DELAYS_MS.length);
    const nudge = calls[DEVTOOLS_LAYOUT_REFRESH_DELAYS_MS.indexOf(32)];
    expect(nudge[3]).toBe(399);
    expect(calls[0][3]).toBe(400);
  });

  it("returns early when the window lacks setFrame", () => {
    const cb = vi.fn();
    scheduleDevtoolsLayoutRefresh(
      { getFrame: () => ({ x: 0, y: 0, width: 1, height: 1 }) },
      cb,
    );
    expect(cb).not.toHaveBeenCalled();
  });

  it("returns early for null windows", () => {
    const cb = vi.fn();
    scheduleDevtoolsLayoutRefresh(null, cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("tolerates getFrame throwing", () => {
    const cb = vi.fn();
    scheduleDevtoolsLayoutRefresh(
      {
        getFrame: () => {
          throw new Error("boom");
        },
        setFrame: () => {},
      },
      cb,
    );
    expect(cb).not.toHaveBeenCalled();
  });
});
