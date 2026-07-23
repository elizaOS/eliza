// @vitest-environment jsdom

/**
 * Behaviour coverage for ToolCallEventLog + its display-state helper: real render
 * in jsdom (lucide icons stubbed) asserting the tool name, arg/result previews,
 * and success/running/failure states.
 */

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
import { mergeChatToolEvent } from "./chat-tool-events";
import { ToolCallEventLog } from "./ToolCallEventLog";
import { getToolCallEventDisplayState } from "./ToolCallEventLog.helpers";

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

  it("renders an internal chat tool result without previewing its raw output", () => {
    const inventory =
      "available_views:\nviews[1]{id,label,type,path,available}:\n  notes,Notes,gui,/notes,yes";
    const [event] = mergeChatToolEvent([], {
      phase: "result",
      callId: "views-call",
      toolName: "VIEWS",
      transcriptVisibility: "internal",
      result: {
        success: true,
        text: inventory,
        transcriptVisibility: "internal",
      },
    });

    expect(event.result).toBeUndefined();
    const rendered = render(<ToolCallEventLog event={event} />);

    const log = rendered.container.querySelector(
      '[data-testid="tool-call-event-log"]',
    );
    if (!log) throw new Error("Expected the internal tool event log to render");
    expect(log.textContent).toContain("VIEWS");
    expect(log.textContent).toContain("Success");
    expect(log.textContent).not.toContain("available_views");
    expect(log.textContent).not.toContain("/notes");
  });
});
