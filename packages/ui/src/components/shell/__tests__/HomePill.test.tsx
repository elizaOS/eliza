/** Verifies HomePill through the package's configured test harness. */
// @vitest-environment jsdom
//
// HomePill rendering, phase→visual wiring (waveform/glow/pulse), the click
// toggle, and the hold-to-talk quasimode gesture (#20483): 150ms click/hold
// disambiguation, release-to-send, slide-off cancel, Esc cancel. Deterministic
// jsdom render via testing-library with fake timers for the hold threshold —
// no runtime, no model, no real mic.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOLD_THRESHOLD_MS, HomePill, SLIDE_CANCEL_PX } from "../HomePill";
import type { ShellPhase } from "../shell-state";

afterEach(() => cleanup());

function holdHandlers() {
  return {
    onHoldStart: vi.fn(),
    onHoldEnd: vi.fn(),
    onHoldCancel: vi.fn(),
  };
}

describe("HomePill", () => {
  it("renders an accessible button with only a compact white visual handle", () => {
    render(<HomePill phase="idle" onOpen={() => {}} onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /open eliza/i });
    expect(btn).toBeTruthy();
    const mark = screen.getByTestId("shell-home-pill-mark");
    expect(mark.className).toContain("bg-white/95");
    expect(mark.className).toContain("w-12");
    expect(mark.className).toContain("shadow-[0_0_0_1px_rgba(0,0,0,0.12)]");
    expect(btn.textContent).toBe("");
    expect(btn.style.backgroundColor).toBe("");
    expect(btn.className).toContain("h-8");
  });

  it("calls onOpen when clicked from idle", () => {
    const onOpen = vi.fn();
    render(<HomePill phase="idle" onOpen={onOpen} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicked from summoned", () => {
    const onClose = vi.fn();
    render(<HomePill phase="summoned" onOpen={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button").textContent).toBe("");
  });

  it.each<ShellPhase>([
    "booting",
    "idle",
    "summoned",
    "listening",
    "responding",
  ])("renders a data-phase attribute for phase=%s", (phase) => {
    render(<HomePill phase={phase} onOpen={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button").getAttribute("data-phase")).toBe(phase);
  });

  it("is aria-pressed only for the overlay phases — listening stays unpressed (headless hold)", () => {
    const { rerender } = render(
      <HomePill phase="idle" onOpen={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "false",
    );
    rerender(
      <HomePill phase="listening" onOpen={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "false",
    );
    rerender(
      <HomePill phase="summoned" onOpen={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
    rerender(
      <HomePill phase="responding" onOpen={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("turns the capsule red with staggered waveform bars while listening", () => {
    render(<HomePill phase="listening" onOpen={() => {}} onClose={() => {}} />);
    const mark = screen.getByTestId("shell-home-pill-mark");
    expect(mark.className).toContain("bg-red-500/95");
    expect(mark.className).not.toContain("bg-white/95");
    const bars = screen.getAllByTestId("shell-home-pill-wave-bar");
    expect(bars).toHaveLength(5);
    const delays = bars.map((b) => b.style.animationDelay);
    expect(new Set(delays).size).toBe(bars.length);
    for (const bar of bars) {
      expect(bar.className).toContain("home-pill-wave-bar");
      expect(bar.className).toContain("motion-reduce:animate-none");
    }
  });

  it("keeps the capsule white with no waveform bars outside listening", () => {
    for (const phase of [
      "booting",
      "idle",
      "summoned",
      "responding",
    ] as const) {
      const { unmount } = render(
        <HomePill phase={phase} onOpen={() => {}} onClose={() => {}} />,
      );
      expect(screen.getByTestId("shell-home-pill-mark").className).toContain(
        "bg-white/95",
      );
      expect(screen.queryAllByTestId("shell-home-pill-wave-bar")).toHaveLength(
        0,
      );
      unmount();
    }
  });

  it("breathes a warm accent glow while responding", () => {
    render(
      <HomePill phase="responding" onOpen={() => {}} onClose={() => {}} />,
    );
    const mark = screen.getByTestId("shell-home-pill-mark");
    expect(mark.className).toContain("255,138,42");
    expect(mark.className).toContain("animate-pulse");
    expect(mark.className).toContain("motion-reduce:animate-none");
  });

  it("stays available while booting and opens on click", () => {
    const onOpen = vi.fn();
    render(<HomePill phase="booting" onOpen={onOpen} onClose={() => {}} />);
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("HomePill hold-to-talk quasimode (#20483)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a quick press (released before the threshold) is a click, never a hold", () => {
    const onOpen = vi.fn();
    const hold = holdHandlers();
    render(
      <HomePill phase="idle" onOpen={onOpen} onClose={() => {}} {...hold} />,
    );
    const btn = screen.getByRole("button");
    fireEvent.pointerDown(btn, { button: 0, clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS - 50);
    fireEvent.pointerUp(btn, { clientX: 10, clientY: 10 });
    fireEvent.click(btn);
    expect(hold.onHoldStart).not.toHaveBeenCalled();
    expect(hold.onHoldEnd).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("holding past the threshold starts capture; release sends and suppresses the click", () => {
    const onOpen = vi.fn();
    const hold = holdHandlers();
    render(
      <HomePill phase="idle" onOpen={onOpen} onClose={() => {}} {...hold} />,
    );
    const btn = screen.getByRole("button");
    fireEvent.pointerDown(btn, { button: 0, clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 10);
    expect(hold.onHoldStart).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(btn, { clientX: 12, clientY: 11 });
    // Browsers fire click after pointerup on the same target; the completed
    // hold must consume it so the overlay does not toggle.
    fireEvent.click(btn);
    expect(hold.onHoldEnd).toHaveBeenCalledTimes(1);
    expect(hold.onHoldCancel).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("releasing farther than the slide-off distance cancels instead of sending", () => {
    const hold = holdHandlers();
    render(
      <HomePill phase="idle" onOpen={() => {}} onClose={() => {}} {...hold} />,
    );
    const btn = screen.getByRole("button");
    fireEvent.pointerDown(btn, { button: 0, clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 10);
    fireEvent.pointerUp(btn, {
      clientX: 10 + SLIDE_CANCEL_PX + 20,
      clientY: 10,
    });
    expect(hold.onHoldCancel).toHaveBeenCalledTimes(1);
    expect(hold.onHoldEnd).not.toHaveBeenCalled();
  });

  it("Escape mid-hold cancels without sending", () => {
    const hold = holdHandlers();
    const { rerender } = render(
      <HomePill phase="idle" onOpen={() => {}} onClose={() => {}} {...hold} />,
    );
    const btn = screen.getByRole("button");
    fireEvent.pointerDown(btn, { button: 0, clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 10);
    expect(hold.onHoldStart).toHaveBeenCalledTimes(1);
    // The controller flips phase to listening once capture starts.
    rerender(
      <HomePill
        phase="listening"
        onOpen={() => {}}
        onClose={() => {}}
        {...hold}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(hold.onHoldCancel).toHaveBeenCalledTimes(1);
    // The (now cancelled) release must not also send.
    fireEvent.pointerUp(btn, { clientX: 10, clientY: 10 });
    expect(hold.onHoldEnd).not.toHaveBeenCalled();
  });

  it("pointercancel (e.g. window drag interruption) cancels the hold", () => {
    const hold = holdHandlers();
    render(
      <HomePill phase="idle" onOpen={() => {}} onClose={() => {}} {...hold} />,
    );
    const btn = screen.getByRole("button");
    fireEvent.pointerDown(btn, { button: 0, clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 10);
    fireEvent.pointerCancel(btn);
    expect(hold.onHoldCancel).toHaveBeenCalledTimes(1);
    expect(hold.onHoldEnd).not.toHaveBeenCalled();
  });

  it("a right-click press never arms the hold", () => {
    const hold = holdHandlers();
    render(
      <HomePill phase="idle" onOpen={() => {}} onClose={() => {}} {...hold} />,
    );
    const btn = screen.getByRole("button");
    fireEvent.pointerDown(btn, {
      button: 2,
      pointerType: "mouse",
      clientX: 10,
      clientY: 10,
    });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 100);
    expect(hold.onHoldStart).not.toHaveBeenCalled();
  });

  it("without hold handlers the pill is click-only (no timer armed)", () => {
    const onOpen = vi.fn();
    render(<HomePill phase="idle" onOpen={onOpen} onClose={() => {}} />);
    const btn = screen.getByRole("button");
    fireEvent.pointerDown(btn, { button: 0, clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 200);
    fireEvent.pointerUp(btn, { clientX: 10, clientY: 10 });
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("announces the live hold state through the accessible label", () => {
    render(<HomePill phase="listening" onOpen={() => {}} onClose={() => {}} />);
    expect(
      screen.getByRole("button", { name: /listening — release to send/i }),
    ).toBeTruthy();
  });
});
