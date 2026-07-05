// @vitest-environment jsdom
//
// Cold-start boot feedback (#UX-e2e): a dedicated agent's container takes
// 30–120s+ to warm, and before this fix the composer showed only a static
// placeholder for that whole window — no visible progress, no timeout escape.
// BootStatusIndicator fills that silent pre-send window; these tests lock its
// two states, the escalation timing, and the honest "Open settings" escape
// (the callback opens settings; the label must say so, not imply a retry).

import { act, cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BOOT_SLOW_AFTER_MS,
  BootStatusIndicator,
} from "./ContinuousChatOverlay";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("BootStatusIndicator", () => {
  it("shows an accessible, indeterminate 'Waking …' state before the slow threshold", () => {
    vi.useFakeTimers();
    render(<BootStatusIndicator agentName="Eliza" onOpenSettings={vi.fn()} />);

    const status = screen.getByTestId("chat-boot-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("data-slow")).toBeNull();
    expect(status.textContent).toContain("Waking Eliza…");
    // No premature escape affordance while the boot is still nominal.
    expect(screen.queryByTestId("chat-boot-open-settings")).toBeNull();
  });

  it("escalates to a 'taking longer than usual' state with a settings escape after the slow threshold", () => {
    vi.useFakeTimers();
    render(<BootStatusIndicator agentName="Ada" onOpenSettings={vi.fn()} />);

    act(() => {
      vi.advanceTimersByTime(BOOT_SLOW_AFTER_MS);
    });

    const status = screen.getByTestId("chat-boot-status");
    expect(status.getAttribute("data-slow")).toBe("true");
    expect(status.textContent).toContain("Ada is taking longer than usual");
    expect(screen.getByTestId("chat-boot-open-settings").textContent).toBe(
      "Open settings",
    );
  });

  it("invokes the settings escape when the escalated action is clicked", () => {
    vi.useFakeTimers();
    const onOpenSettings = vi.fn();
    render(
      <BootStatusIndicator agentName="Eliza" onOpenSettings={onOpenSettings} />,
    );
    act(() => {
      vi.advanceTimersByTime(BOOT_SLOW_AFTER_MS);
    });

    screen.getByTestId("chat-boot-open-settings").click();

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("omits the escape button when no settings handler is supplied", () => {
    vi.useFakeTimers();
    render(<BootStatusIndicator agentName="Eliza" />);
    act(() => {
      vi.advanceTimersByTime(BOOT_SLOW_AFTER_MS);
    });

    expect(
      screen.getByTestId("chat-boot-status").getAttribute("data-slow"),
    ).toBe("true");
    expect(screen.queryByTestId("chat-boot-open-settings")).toBeNull();
  });

  it("drops the spinner animation under reduced motion", () => {
    vi.useFakeTimers();
    const { container } = render(
      <BootStatusIndicator agentName="Eliza" onOpenSettings={vi.fn()} reduce />,
    );

    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});

// #14040 sub-defect 3: the slow-boot escalation must key off ABSENCE of
// progress, not raw elapsed wall-clock. A boot that keeps reporting fresh
// progress (a changing `progressSignal`) never trips "taking longer than
// usual"; a genuinely stalled boot (stable token) still does.
describe("BootStatusIndicator progress-aware escalation (#14040 sub-defect 3)", () => {
  it("does NOT escalate while progress keeps arriving, even past BOOT_SLOW_AFTER_MS", () => {
    vi.useFakeTimers();
    // A thin harness so we can push a new progressSignal between timer advances.
    function Harness() {
      const [signal, setSignal] = React.useState("tick-0");
      return (
        <>
          <button
            type="button"
            data-testid="advance-progress"
            onClick={() => setSignal((s) => `tick-${Number(s.slice(5)) + 1}`)}
          />
          <BootStatusIndicator
            agentName="Eliza"
            onOpenSettings={vi.fn()}
            progressSignal={signal}
          />
        </>
      );
    }
    render(<Harness />);

    // Advance ALMOST to the threshold, then report progress (resets the window),
    // repeatedly — total elapsed far exceeds BOOT_SLOW_AFTER_MS but each window
    // is reset before it fires.
    for (let i = 0; i < 4; i += 1) {
      act(() => {
        vi.advanceTimersByTime(BOOT_SLOW_AFTER_MS - 1_000);
      });
      // Fresh progress observed — the escalation window restarts.
      act(() => {
        screen.getByTestId("advance-progress").click();
      });
    }

    // Cumulative elapsed ≈ 4 × (90s - 1s) = 356s ≫ 90s, yet still not slow.
    expect(
      screen.getByTestId("chat-boot-status").getAttribute("data-slow"),
    ).toBeNull();
    expect(screen.getByTestId("chat-boot-status").textContent).toContain(
      "Waking Eliza…",
    );
  });

  it("escalates when progress stalls (token stable for the full window)", () => {
    vi.useFakeTimers();
    render(
      <BootStatusIndicator
        agentName="Eliza"
        onOpenSettings={vi.fn()}
        progressSignal="stalled"
      />,
    );

    // No new progressSignal for the whole window — a genuine stall still trips.
    act(() => {
      vi.advanceTimersByTime(BOOT_SLOW_AFTER_MS);
    });

    expect(
      screen.getByTestId("chat-boot-status").getAttribute("data-slow"),
    ).toBe("true");
    expect(screen.getByTestId("chat-boot-status").textContent).toContain(
      "taking longer than usual",
    );
  });

  it("falls back to raw-elapsed escalation when no progressSignal is supplied", () => {
    vi.useFakeTimers();
    render(<BootStatusIndicator agentName="Eliza" onOpenSettings={vi.fn()} />);

    act(() => {
      vi.advanceTimersByTime(BOOT_SLOW_AFTER_MS);
    });

    expect(
      screen.getByTestId("chat-boot-status").getAttribute("data-slow"),
    ).toBe("true");
  });
});
