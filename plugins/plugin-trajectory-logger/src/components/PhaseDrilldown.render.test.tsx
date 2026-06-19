// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  UIEvaluationEvent,
  UILlmCall,
  UIProviderAccess,
  UIToolEvent,
} from "../api-client";
import type { PhaseName, PhaseStatus, PhaseSummary } from "../phases";
import { PhaseDrilldown } from "./PhaseDrilldown.js";

function llmCall(overrides: Partial<UILlmCall>): UILlmCall {
  return {
    id: "c1",
    model: "m",
    response: "",
    purpose: "",
    actionType: "",
    stepType: "",
    ...overrides,
  };
}

function summary(
  phase: PhaseName,
  status: PhaseStatus,
  parts: Partial<PhaseSummary>,
): PhaseSummary {
  return {
    phase,
    status,
    summary: null,
    llmCalls: [],
    providerAccesses: [],
    toolEvents: [],
    evaluationEvents: [],
    ...parts,
  };
}

afterEach(() => cleanup());

describe("PhaseDrilldown HANDLE body", () => {
  it("renders the decision, reasoning, and deduped provider chips", () => {
    const providerAccesses: UIProviderAccess[] = [
      { id: "p1", providerName: "RECENT_MESSAGES", purpose: "" },
      { id: "p2", providerName: "CHARACTER", purpose: "" },
      // Duplicate provider name -> should be deduped to a single chip.
      { id: "p3", providerName: "RECENT_MESSAGES", purpose: "" },
    ];
    render(
      <PhaseDrilldown
        phase={summary("HANDLE", "done", {
          llmCalls: [
            llmCall({
              stepType: "should_respond",
              response:
                '{"action":"RESPOND","reasoning":"the user asked a direct question"}',
            }),
          ],
          providerAccesses,
        })}
      />,
    );

    expect(screen.getByText("RESPOND")).toBeTruthy();
    expect(screen.getByText("the user asked a direct question")).toBeTruthy();
    // Deduped: RECENT_MESSAGES appears exactly once.
    expect(screen.getAllByText("RECENT_MESSAGES")).toHaveLength(1);
    expect(screen.getByText("CHARACTER")).toBeTruthy();
  });
});

describe("PhaseDrilldown PLAN body", () => {
  it("renders the actionType and truncates a >600-char response to '… (+N)'", () => {
    const long = "x".repeat(700);
    render(
      <PhaseDrilldown
        phase={summary("PLAN", "done", {
          llmCalls: [
            llmCall({
              stepType: "response",
              actionType: "REPLY",
              response: long,
            }),
          ],
        })}
      />,
    );

    // actionType (mono).
    expect(screen.getByText("REPLY")).toBeTruthy();
    // previewText caps at 600 chars and appends "…  (+100)" (700 - 600 = 100).
    const pre = document.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toContain("(+100)");
    // The visible body is the 600-char slice plus the marker, not the full 700.
    expect((pre?.textContent ?? "").length).toBeLessThan(700);
    expect((pre?.textContent ?? "").startsWith("x".repeat(600))).toBe(true);
  });

  it("returns null body when there are no PLAN calls", () => {
    const { container } = render(
      <PhaseDrilldown phase={summary("PLAN", "idle", {})} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("PhaseDrilldown ACTION body", () => {
  it("renders tool name, duration, error, args + result and STATUS_BORDER tone per status", () => {
    const events: UIToolEvent[] = [
      {
        id: "ok",
        type: "tool_result",
        actionName: "REPLY",
        status: "completed",
        success: true,
        durationMs: 42,
        args: { text: "hello world" },
        result: { sent: true },
      },
      {
        id: "err",
        type: "tool_error",
        actionName: "POSTGRES_QUERY",
        error: "connection refused",
        durationMs: 17,
      },
    ];
    render(
      <PhaseDrilldown
        phase={summary("ACTION", "error", { toolEvents: events })}
      />,
    );

    // Names + duration.
    expect(screen.getByText("REPLY")).toBeTruthy();
    expect(screen.getByText("42ms")).toBeTruthy();
    expect(screen.getByText("POSTGRES_QUERY")).toBeTruthy();
    expect(screen.getByText("17ms")).toBeTruthy();

    // Error text.
    expect(screen.getByText("connection refused")).toBeTruthy();

    // args + result are serialized via jsonBlock.
    expect(screen.getByText(/"text": "hello world"/)).toBeTruthy();
    expect(screen.getByText(/"sent": true/)).toBeTruthy();

    // STATUS_BORDER tone: ok event = green border, error event = red border.
    const okCard = screen.getByText("REPLY").closest("div.rounded");
    expect(okCard?.className).toContain("border-green-500/40");
    const errCard = screen.getByText("POSTGRES_QUERY").closest("div.rounded");
    expect(errCard?.className).toContain("border-red-500/40");
  });

  it("maps a skipped tool status to the yellow border and a running one to blue", () => {
    const events: UIToolEvent[] = [
      { id: "sk", type: "tool_call", actionName: "MUTE", status: "skipped" },
      { id: "rn", type: "tool_call", actionName: "SEARCH", status: "running" },
    ];
    render(
      <PhaseDrilldown
        phase={summary("ACTION", "active", { toolEvents: events })}
      />,
    );
    const skipped = screen.getByText("MUTE").closest("div.rounded");
    expect(skipped?.className).toContain("border-yellow-500/40");
    const running = screen.getByText("SEARCH").closest("div.rounded");
    expect(running?.className).toContain("border-blue-500/40");
  });

  it("returns null when there are no tool events", () => {
    const { container } = render(
      <PhaseDrilldown phase={summary("ACTION", "idle", { toolEvents: [] })} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("PhaseDrilldown EVALUATE body", () => {
  it("renders evaluator name, decision, thought, error and status border", () => {
    const events: UIEvaluationEvent[] = [
      {
        id: "ev-ok",
        evaluatorName: "REFLECTION",
        decision: "continue",
        thought: "the conversation is on track",
        success: true,
        status: "completed",
      },
      {
        id: "ev-err",
        name: "FACT_CHECK",
        error: "evaluator timed out",
        success: false,
      },
    ];
    render(
      <PhaseDrilldown
        phase={summary("EVALUATE", "done", { evaluationEvents: events })}
      />,
    );

    expect(screen.getByText("REFLECTION")).toBeTruthy();
    expect(screen.getByText("continue")).toBeTruthy();
    expect(screen.getByText("the conversation is on track")).toBeTruthy();
    expect(screen.getByText("FACT_CHECK")).toBeTruthy();
    expect(screen.getByText("evaluator timed out")).toBeTruthy();

    // status border: ok = green, error = red.
    const okCard = screen.getByText("REFLECTION").closest("div.rounded");
    expect(okCard?.className).toContain("border-green-500/40");
    const errCard = screen.getByText("FACT_CHECK").closest("div.rounded");
    expect(errCard?.className).toContain("border-red-500/40");
  });

  it("renders nothing when both evaluation calls and events are empty", () => {
    const { container } = render(
      <PhaseDrilldown
        phase={summary("EVALUATE", "idle", {
          llmCalls: [],
          evaluationEvents: [],
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
