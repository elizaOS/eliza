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

  it("expands the resting handle into a compact composer preview on hover", () => {
    const onPreviewHoverChange = vi.fn();
    render(
      <HomePill
        phase="idle"
        onOpen={() => {}}
        onClose={() => {}}
        onPreviewHoverChange={onPreviewHoverChange}
      />,
    );
    const btn = screen.getByRole("button");
    fireEvent.mouseEnter(btn);

    expect(btn.className).toContain("w-[36rem]");
    expect(screen.getByTestId("shell-home-pill-mark").className).toContain(
      "h-14",
    );
    expect(
      screen.getByTestId("shell-home-pill-preview-label").textContent,
    ).toBe("Message Eliza");
    expect(screen.getByTestId("shell-home-pill-preview-plus")).toBeTruthy();
    expect(screen.getByTestId("shell-home-pill-preview-waveform")).toBeTruthy();
    expect(onPreviewHoverChange).toHaveBeenLastCalledWith(true);

    fireEvent.mouseLeave(btn);
    expect(btn.className).toContain("w-16");
    expect(screen.queryByTestId("shell-home-pill-preview-label")).toBeNull();
    expect(onPreviewHoverChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the real resting pill when its host uses ChatOverlay for the composer", () => {
    render(
      <HomePill
        phase="idle"
        onOpen={() => {}}
        onClose={() => {}}
        showComposerPreview={false}
      />,
    );
    const button = screen.getByRole("button");
    fireEvent.mouseEnter(button);

    expect(button.className).toContain("w-16");
    expect(screen.queryByTestId("shell-home-pill-preview-label")).toBeNull();
  });

  it("waits for the native hover frame before painting the wide preview", () => {
    const onPreviewHoverChange = vi.fn();
    const { rerender } = render(
      <HomePill
        phase="idle"
        onOpen={() => {}}
        onClose={() => {}}
        onPreviewHoverChange={onPreviewHoverChange}
        previewHostReady={false}
      />,
    );
    const button = screen.getByRole("button");
    fireEvent.mouseEnter(button);

    expect(onPreviewHoverChange).toHaveBeenLastCalledWith(true);
    expect(button.className).toContain("w-16");
    expect(screen.queryByTestId("shell-home-pill-preview-label")).toBeNull();

    rerender(
      <HomePill
        phase="idle"
        onOpen={() => {}}
        onClose={() => {}}
        onPreviewHoverChange={onPreviewHoverChange}
        previewHostReady
      />,
    );
    expect(button.className).toContain("w-[36rem]");
    expect(screen.getByTestId("shell-home-pill-preview-label")).toBeTruthy();
  });

  it("dismisses the wide preview on wheel so scrolling continues behind it", () => {
    const onPreviewHoverChange = vi.fn();
    render(
      <HomePill
        phase="idle"
        onOpen={() => {}}
        onClose={() => {}}
        onPreviewHoverChange={onPreviewHoverChange}
      />,
    );
    const button = screen.getByRole("button");
    fireEvent.mouseEnter(button);
    expect(screen.getByTestId("shell-home-pill-preview-label")).toBeTruthy();

    fireEvent.wheel(button, { deltaY: 120 });

    expect(screen.queryByTestId("shell-home-pill-preview-label")).toBeNull();
    expect(onPreviewHoverChange).toHaveBeenLastCalledWith(false);
  });

  it("uses the same hover composer while Cloud auth is required", () => {
    render(
      <HomePill phase="needs-auth" onOpen={() => {}} onClose={() => {}} />,
    );
    fireEvent.mouseEnter(screen.getByRole("button"));
    expect(
      screen.getByTestId("shell-home-pill-preview-label").textContent,
    ).toBe("Message Eliza");
    expect(screen.queryByTestId("shell-home-pill-sign-in")).toBeNull();
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
    "needs-auth",
    "idle",
    "summoned",
    "listening",
    "processing",
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

  it("uses the composer-sized microphone activity lane while listening", () => {
    render(<HomePill phase="listening" onOpen={() => {}} onClose={() => {}} />);
    const mark = screen.getByTestId("shell-home-pill-mark");
    // Fn/hold-to-talk uses the same footprint and bar count as the open
    // composer's microphone activity lane instead of a separate tiny chip.
    expect(mark.className).toContain("bg-neutral-900/95");
    expect(mark.className).toContain("h-14");
    expect(mark.className).toContain("w-full");
    expect(screen.getByRole("button").className).toContain("w-[36rem]");
    expect(mark.className).not.toContain("239,68,68");
    expect(mark.className).not.toContain("bg-white/95");
    const bars = screen.getAllByTestId("shell-home-pill-wave-bar");
    expect(bars).toHaveLength(15);
    // Center-weighted silhouette: heights symmetric around the middle bar.
    const heights = bars.map((b) => Number.parseInt(b.style.height, 10));
    expect(heights).toEqual([...heights].reverse());
    expect(Math.max(...heights)).toBe(heights[Math.floor(heights.length / 2)]);
  });

  it("keeps listening compact until the native shallow host is ready", () => {
    render(
      <HomePill
        phase="listening"
        onOpen={() => {}}
        onClose={() => {}}
        previewHostReady={false}
      />,
    );

    const button = screen.getByRole("button");
    const mark = screen.getByTestId("shell-home-pill-mark");
    expect(button.className).toContain("w-16");
    expect(button.className).not.toContain("w-[36rem]");
    expect(mark.className).toContain("w-20");
    expect(mark.className).not.toContain("w-full");
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

  it("keeps the dark chip with pulsing dots while processing", () => {
    render(
      <HomePill phase="processing" onOpen={() => {}} onClose={() => {}} />,
    );
    const mark = screen.getByTestId("shell-home-pill-mark");
    expect(mark.className).toContain("bg-neutral-900/95");
    expect(mark.className).not.toContain("239,68,68");
    const dots = screen.getAllByTestId("shell-home-pill-process-dot");
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(dot.className).toContain("home-pill-process-dot");
      expect(dot.className).toContain("motion-reduce:animate-none");
    }
    expect(screen.queryAllByTestId("shell-home-pill-wave-bar")).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: /transcribing your words/i }),
    ).toBeTruthy();
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

  it("sharpens the glow and drops the pulse while speaking aloud", () => {
    render(
      <HomePill
        phase="responding"
        speaking
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );
    const btn = screen.getByRole("button", { name: /is speaking/i });
    expect(btn.getAttribute("data-speaking")).toBe("true");
    const mark = screen.getByTestId("shell-home-pill-mark");
    expect(mark.className).toContain("0.85");
    expect(mark.className).not.toContain("animate-pulse");
  });

  it("keeps the neutral resting handle while needs-auth and does not arm hold", () => {
    const onOpen = vi.fn();
    const hold = holdHandlers();
    render(
      <HomePill
        phase="needs-auth"
        onOpen={onOpen}
        onClose={() => {}}
        {...hold}
      />,
    );
    const btn = screen.getByRole("button", {
      name: /sign in with eliza cloud/i,
    });
    expect(btn.getAttribute("data-phase")).toBe("needs-auth");
    expect(btn.hasAttribute("aria-pressed")).toBe(false);
    const mark = screen.getByTestId("shell-home-pill-mark");
    expect(btn.className).toContain("h-8");
    expect(btn.className).toContain("w-16");
    expect(mark.className).toContain("h-2.5");
    expect(mark.className).toContain("w-12");
    expect(mark.className).toContain("bg-white/95");
    expect(mark.className).not.toContain("bg-[#FF5800]");
    expect(screen.queryByTestId("shell-home-pill-sign-in-icon")).toBeNull();
    expect(screen.queryAllByTestId("shell-home-pill-wave-bar")).toHaveLength(0);
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps the neutral handle and accessible busy state during Cloud login", () => {
    render(
      <HomePill
        phase="needs-auth"
        signingIn
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );
    const mark = screen.getByTestId("shell-home-pill-mark");
    expect(mark.className).not.toContain("opacity-65");
    expect(mark.className).not.toContain("animate-pulse");
    expect(mark.className).toContain("bg-white/95");
    expect(mark.className).not.toContain("bg-[#FF5800]");
    expect(screen.queryByTestId("shell-home-pill-sign-in-spinner")).toBeNull();
    expect(screen.queryByTestId("shell-home-pill-sign-in-icon")).toBeNull();
    const btn = screen.getByRole("button", {
      name: /signing in to eliza cloud/i,
    });
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.hasAttribute("aria-pressed")).toBe(false);
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

  it("opens chat on the next click after a closed-pill voice response", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const hold = holdHandlers();
    const { rerender } = render(
      <HomePill
        phase="idle"
        open={false}
        onOpen={onOpen}
        onClose={onClose}
        {...hold}
      />,
    );
    const btn = screen.getByRole("button");

    fireEvent.pointerDown(btn, { button: 0, clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 10);
    rerender(
      <HomePill
        phase="responding"
        open={false}
        onOpen={onOpen}
        onClose={onClose}
        {...hold}
      />,
    );
    fireEvent.pointerUp(btn, { clientX: 10, clientY: 10 });
    fireEvent.click(btn);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.pointerDown(btn, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(btn, { clientX: 10, clientY: 10 });
    fireEvent.click(btn);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
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

  it("needs-auth never arms the hold, even when hold handlers are provided", () => {
    const onOpen = vi.fn();
    const hold = holdHandlers();
    render(
      <HomePill
        phase="needs-auth"
        onOpen={onOpen}
        onClose={() => {}}
        {...hold}
      />,
    );
    const btn = screen.getByRole("button");
    fireEvent.pointerDown(btn, { button: 0, clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 200);
    fireEvent.pointerUp(btn, { clientX: 10, clientY: 10 });
    fireEvent.click(btn);
    expect(hold.onHoldStart).not.toHaveBeenCalled();
    expect(hold.onHoldEnd).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
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

describe("HomePill live-metered listening bars (#20483)", () => {
  /** Fake AnalyserNode: hands the effect a controllable time-domain frame. */
  function fakeAnalyser(fill: number): AnalyserNode {
    return {
      fftSize: 64,
      getByteTimeDomainData(target: Uint8Array) {
        target.fill(fill);
      },
    } as unknown as AnalyserNode;
  }

  /** Captures rAF callbacks so frames are stepped manually and synchronously. */
  function stubRaf() {
    const queue: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        queue.push(cb);
        return queue.length;
      });
    const caf = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const step = () => {
      const frame = queue.shift();
      if (frame) frame(performance.now());
    };
    return {
      step,
      framesRequested: () => raf.mock.calls.length,
      restore: () => {
        raf.mockRestore();
        caf.mockRestore();
      },
    };
  }

  it("without an analyser the bars hold a static flatline (mic opening) — no decorative motion", () => {
    const { framesRequested, restore } = stubRaf();
    try {
      render(
        <HomePill phase="listening" onOpen={() => {}} onClose={() => {}} />,
      );
      for (const bar of screen.getAllByTestId("shell-home-pill-wave-bar")) {
        expect(bar.className).not.toContain("home-pill-wave-bar");
        expect(bar.dataset.live).toBeUndefined();
        expect(bar.style.animationDelay).toBe("");
        expect(bar.style.transform).toBe("scaleY(0.14)");
      }
      expect(framesRequested()).toBe(0);
    } finally {
      restore();
    }
  });

  it("with an analyser silence still flatlines every bar", () => {
    const { step, restore } = stubRaf();
    try {
      render(
        <HomePill
          phase="listening"
          analyser={fakeAnalyser(128)}
          onOpen={() => {}}
          onClose={() => {}}
        />,
      );
      step();
      const bars = screen.getAllByTestId("shell-home-pill-wave-bar");
      for (const bar of bars) {
        expect(bar.className).not.toContain("home-pill-wave-bar");
        expect(bar.dataset.live).toBe("true");
        expect(bar.style.animationDelay).toBe("");
        expect(bar.style.transform).toBe("scaleY(0.14)");
      }
    } finally {
      restore();
    }
  });

  it("live audio lifts the bars above the flatline each frame", () => {
    const { step, restore } = stubRaf();
    try {
      render(
        <HomePill
          phase="listening"
          analyser={fakeAnalyser(255)}
          onOpen={() => {}}
          onClose={() => {}}
        />,
      );
      step();
      for (const bar of screen.getAllByTestId("shell-home-pill-wave-bar")) {
        const scale = Number.parseFloat(
          bar.style.transform.replace(/scaleY\(|\)/g, ""),
        );
        expect(scale).toBeGreaterThan(0.14);
        expect(scale).toBeLessThanOrEqual(1);
      }
    } finally {
      restore();
    }
  });

  it("losing the analyser mid-listen returns the bars to the flatline (device loss)", () => {
    const { step, restore } = stubRaf();
    try {
      const { rerender } = render(
        <HomePill
          phase="listening"
          analyser={fakeAnalyser(255)}
          onOpen={() => {}}
          onClose={() => {}}
        />,
      );
      step();
      rerender(
        <HomePill
          phase="listening"
          analyser={null}
          onOpen={() => {}}
          onClose={() => {}}
        />,
      );
      for (const bar of screen.getAllByTestId("shell-home-pill-wave-bar")) {
        expect(bar.dataset.live).toBeUndefined();
        expect(bar.style.transform).toBe("scaleY(0.14)");
      }
    } finally {
      restore();
    }
  });

  it("outside listening the analyser drives nothing (no rAF loop)", () => {
    const { framesRequested, restore } = stubRaf();
    try {
      render(
        <HomePill
          phase="responding"
          analyser={fakeAnalyser(255)}
          onOpen={() => {}}
          onClose={() => {}}
        />,
      );
      expect(framesRequested()).toBe(0);
      expect(screen.queryAllByTestId("shell-home-pill-wave-bar")).toHaveLength(
        0,
      );
    } finally {
      restore();
    }
  });
});
