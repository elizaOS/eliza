// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => {
  const Icon = ({ className }: { className?: string }) => (
    <span className={className} data-testid="tool-call-icon" />
  );
  return {
    CheckCircle: Icon,
    ChevronDown: Icon,
    Clock3: Icon,
    XCircle: Icon,
  };
});

import type { NativeToolCallEvent } from "../../api/client-types-cloud";
import {
  getToolCallEventDisplayState,
  ToolCallEventLog,
} from "./ToolCallEventLog";

describe("ToolCallEventLog", () => {
  it("renders action, args preview, result preview, and success state", () => {
    const event: NativeToolCallEvent = {
      id: "evt-1",
      type: "tool_result",
      actionName: "CALENDAR_FIND_EVENTS",
      args: { query: "lunch" },
      result: { count: 2 },
      status: "completed",
      durationMs: 42,
    };

    render(<ToolCallEventLog event={event} />);

    const log = screen.getByTestId("tool-call-event-log");
    expect(log.textContent).toContain("CALENDAR_FIND_EVENTS");
    expect(log.textContent).toContain('"query":"lunch"');
    expect(log.textContent).toContain('"count":2');
    expect(log.textContent).toContain("Success");
    expect(log.textContent).toContain("42ms");
  });

  it("classifies tool errors as failures", () => {
    expect(
      getToolCallEventDisplayState({
        id: "evt-2",
        type: "tool_error",
        toolName: "SEND_EMAIL",
        error: "permission denied",
      }),
    ).toBe("failure");
  });
});
