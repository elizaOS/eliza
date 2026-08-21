import { describe, expect, it, vi } from "vitest";
import {
  DEVTOOLS_LAYOUT_REFRESH_DELAYS_MS,
  scheduleDevtoolsLayoutRefresh,
} from "./devtools-layout";

describe("scheduleDevtoolsLayoutRefresh", () => {
  it("refreshes the native content tree after every inspector frame pass", () => {
    const frame = { x: 10, y: 20, width: 1200, height: 800 };
    const setFrame = vi.fn();
    const refreshNativeLayout = vi.fn();
    const scheduled: Array<() => void> = [];

    scheduleDevtoolsLayoutRefresh(
      { getFrame: () => frame, setFrame },
      (callback) => scheduled.push(callback),
      refreshNativeLayout,
    );
    for (const callback of scheduled) callback();

    expect(scheduled).toHaveLength(DEVTOOLS_LAYOUT_REFRESH_DELAYS_MS.length);
    expect(refreshNativeLayout).toHaveBeenCalledTimes(scheduled.length);
    expect(setFrame).toHaveBeenCalledWith(10, 20, 1200, 799);
    expect(setFrame).toHaveBeenLastCalledWith(10, 20, 1200, 800);
  });
});
