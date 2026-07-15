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

import {
  formatElapsed,
  TurnStatus,
  turnStatusLabel,
} from "./chat-typing-indicator";

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

describe("formatElapsed", () => {
  it("shows seconds under a minute and m/ss beyond", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(8)).toBe("8s");
    expect(formatElapsed(59)).toBe("59s");
    expect(formatElapsed(60)).toBe("1m 00s");
    expect(formatElapsed(125)).toBe("2m 05s");
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

  it("reveals the elapsed clock only after the grace window, then ticks", () => {
    render(<TurnStatus status={{ kind: "thinking" }} />);
    // Before the grace window: no timer chip yet (avoids a "0s" flash).
    expect(screen.queryByTestId("turn-status-elapsed")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("turn-status-elapsed").textContent).toContain(
      "1s",
    );
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId("turn-status-elapsed").textContent).toContain(
      "4s",
    );
  });

  it("resets the clock when the status clears between turns", () => {
    const { rerender } = render(<TurnStatus status={{ kind: "thinking" }} />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId("turn-status-elapsed").textContent).toContain(
      "2s",
    );
    rerender(<TurnStatus status={null} />);
    expect(screen.queryByTestId("turn-status-elapsed")).toBeNull();
  });

  it("renders a compact shimmering label without a second spinner", () => {
    render(<TurnStatus status={{ kind: "thinking" }} showLabel={false} />);
    const label = screen.getByTestId("turn-status-label");
    expect(label.textContent).toBe("Thinking");
    expect(label.className).toContain("shimmer");
    expect(screen.queryByTestId("typing-dots")).toBeNull();
    expect(screen.queryByTestId("turn-status-spinner")).toBeNull();
  });

  it("keeps the speaking phase neutral and shimmering", () => {
    const { rerender } = render(
      <TurnStatus status={{ kind: "speaking" }} showLabel={false} />,
    );
    const compactLabel = screen.getByTestId("turn-status-label");
    expect(compactLabel.textContent).toBe("Speaking");
    expect(compactLabel.className).toContain("shimmer");
    expect(compactLabel.className).not.toContain("255,200,150");

    rerender(<TurnStatus status={{ kind: "speaking" }} />);
    const fullLabel = screen.getByTestId("turn-status-label");
    expect(fullLabel.className).toContain("shimmer");
    expect(
      screen.getByTestId("turn-status-spinner").getAttribute("class"),
    ).toContain("text-white/70");
  });
});
