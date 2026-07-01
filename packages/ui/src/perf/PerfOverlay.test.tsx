// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PerfOverlay } from "./PerfOverlay";

// #9141: the dev FPS/long-task HUD now gates on the SAME `__ELIZA_PERF_HUD__`
// opt-in that `useFrameBudgetMonitor` reads (previously it read a divergent
// `__ELIZA_PERF__`, so flipping the documented flag turned the monitor on but
// left the visible overlay dark). These pin both arms of that single gate.
type PerfHudWindow = Window & { __ELIZA_PERF_HUD__?: boolean };

afterEach(() => {
  cleanup();
  delete (window as PerfHudWindow).__ELIZA_PERF_HUD__;
});

describe("PerfOverlay gate (#9141)", () => {
  it("renders nothing (and starts no loop) when __ELIZA_PERF_HUD__ is off", () => {
    const { container } = render(<PerfOverlay />);
    expect(container.querySelector('[data-testid="perf-overlay"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders the readout when __ELIZA_PERF_HUD__ is set", () => {
    vi.useFakeTimers();
    try {
      (window as PerfHudWindow).__ELIZA_PERF_HUD__ = true;
      const { container } = render(<PerfOverlay />);
      // The overlay arms the sampler on mount but only paints after its first
      // 500ms read populates the summary — advance past one interval tick.
      act(() => {
        vi.advanceTimersByTime(600);
      });
      const overlay = container.querySelector('[data-testid="perf-overlay"]');
      expect(overlay).not.toBeNull();
      expect(overlay?.textContent).toMatch(/fps/);
    } finally {
      vi.useRealTimers();
    }
  });
});
