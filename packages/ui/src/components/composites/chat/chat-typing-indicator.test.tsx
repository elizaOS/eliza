/** Verifies turnStatusLabel through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Behaviour of the Codex-style working indicator (#13535): the labeled TurnStatus
 * renders a spinner glyph, a word for every phase (including `thinking`), and a
 * live elapsed-seconds clock that appears only after the sub-second grace window
 * and ticks each whole second. Uses fake timers so the wall clock is
 * deterministic — no live model, pure render behaviour.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TurnStatus, turnStatusLabel } from "./chat-typing-indicator";

afterEach(cleanup);

describe("turnStatusLabel", () => {
  it("names every phase, including thinking, and uses tool/action names", () => {
    expect(turnStatusLabel({ kind: "thinking" })).toBe("Thinking");
    expect(turnStatusLabel({ kind: "streaming" })).toBe("Replying");
    expect(turnStatusLabel({ kind: "evaluating" })).toBe("Reflecting");
    expect(
      turnStatusLabel({ kind: "running_action", actionName: "SEND_MESSAGE" }),
    ).toBe("Running Send message");
    expect(
      turnStatusLabel({ kind: "running_action", actionName: "REPLY" }),
    ).toBe("Replying");
    expect(
      turnStatusLabel({ kind: "running_tool", toolName: "WEB_SEARCH" }),
    ).toBe("Using Web search");
    expect(turnStatusLabel({ kind: "running_tool" })).toBe("Using a tool");
    expect(turnStatusLabel({ kind: "waking", label: "Waking up" })).toBe(
      "Waking up",
    );
  });
});

describe("TurnStatus working indicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a spinner and the 'Thinking' word (not bare dots) for the thinking phase", () => {
    render(<TurnStatus status={{ kind: "thinking" }} />);
    expect(screen.getByTestId("turn-status-spinner")).not.toBeNull();
    expect(screen.getByTestId("turn-status-label").textContent).toContain(
      "Thinking",
    );
  });

  it("keeps progress visible without a running timer", () => {
    render(
      <TurnStatus status={{ kind: "thinking", label: "Let me check." }} />,
    );
    act(() => {
      vi.advanceTimersByTime(65000);
    });
    expect(screen.getByTestId("turn-status-label").textContent).toBe(
      "Let me check.",
    );
    expect(screen.queryByTestId("turn-status-elapsed")).toBeNull();
  });

  it("renders a compact shimmering label without a second spinner", () => {
    render(<TurnStatus status={{ kind: "thinking" }} showLabel={false} />);
    const label = screen.getByTestId("turn-status-label");
    expect(label.textContent).toBe("Thinking");
    expect(label.getAttribute("data-current-label")).toBe("Thinking");
    expect(screen.getByTestId("turn-status-indicator").className).toContain(
      "min-h-[1.4375rem]",
    );
    expect(screen.queryByTestId("typing-dots")).toBeNull();
    expect(screen.queryByTestId("turn-status-spinner")).toBeNull();
  });

  it("suppresses transient planner phases and swaps stable ones on one baseline", () => {
    const { rerender } = render(
      <TurnStatus status={{ kind: "thinking" }} showLabel={false} />,
    );
    const label = screen.getByTestId("turn-status-label");

    rerender(
      <TurnStatus
        status={{ kind: "running_tool", toolName: "VIEWS" }}
        showLabel={false}
      />,
    );
    expect(label.getAttribute("data-current-label")).toBe("Thinking");

    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(label.getAttribute("data-current-label")).toBe("Using Views");
    expect(screen.getByTestId("turn-status-indicator").className).toContain(
      "min-h-[1.4375rem]",
    );
  });
});
