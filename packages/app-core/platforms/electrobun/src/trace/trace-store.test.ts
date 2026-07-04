/** Exercises trace store behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import { TraceError } from "./errors";
import { TraceStore } from "./trace-store";

function store(): TraceStore {
  let tick = 0;
  let sessionCount = 0;
  return new TraceStore({
    now: () => new Date(1_800_000_000_000 + tick++),
    sessionIdFactory: () => `session-${++sessionCount}`,
    eventIdFactory: () => `event-${tick}`,
    maxEventPayloadBytes: 64,
  });
}

describe("TraceStore", () => {
  it("creates sessions, records events, tails by sequence, and summarizes", () => {
    const traces = store();
    const session = traces.createSession({
      title: "Agent run",
      source: "agent",
      runId: "run-1",
    });

    const model = traces.recordEvent({
      sessionId: session.id,
      kind: "model.request.started",
      modelId: "eliza-1-2b",
    });
    traces.recordEvent({
      sessionId: session.id,
      kind: "tool.started",
      toolName: "GIT_STATUS",
    });
    traces.recordEvent({
      sessionId: session.id,
      kind: "capability.invoke.started",
      capabilityId: "eliza.git",
    });
    traces.completeSession({ sessionId: session.id });

    expect(model.sequence).toBe(1);
    expect(traces.tailEvents({ sessionId: session.id }).events).toHaveLength(3);
    expect(
      traces.tailEvents({ sessionId: session.id, afterSequence: 1 }).events,
    ).toMatchObject([
      { sequence: 2, kind: "tool.started" },
      { sequence: 3, kind: "capability.invoke.started" },
    ]);
    expect(traces.summarizeSession(session.id)).toMatchObject({
      eventCount: 3,
      toolCount: 1,
      modelCallCount: 1,
      capabilityCallCount: 1,
      session: { status: "completed" },
    });
  });

  it("searches by kind, source, and query", () => {
    const traces = store();
    const session = traces.createSession({
      title: "Agent run",
      source: "agent",
      conversationId: "conversation-1",
    });
    traces.recordEvent({
      sessionId: session.id,
      kind: "tool.completed",
      source: "tool",
      toolName: "GIT_DIFF",
      text: "diff ready",
    });
    traces.recordEvent({
      sessionId: session.id,
      kind: "model.completed",
      source: "model",
      text: "done",
    });

    expect(
      traces.searchEvents({ kinds: ["tool.completed"], query: "diff" }),
    ).toMatchObject([{ kind: "tool.completed", toolName: "GIT_DIFF" }]);
    expect(
      traces.searchEvents({
        source: "model",
        conversationId: "conversation-1",
      }),
    ).toMatchObject([{ kind: "model.completed" }]);
  });

  it("stores an explicit summary when payloads exceed the size limit", () => {
    const traces = store();
    const session = traces.createSession({
      title: "Agent run",
      source: "agent",
    });
    const event = traces.recordEvent({
      sessionId: session.id,
      kind: "log",
      payload: {
        text: "x".repeat(200),
      },
    });

    expect(event.payload).toMatchObject({
      tracePayloadTruncated: true,
      maxBytes: 64,
    });
  });

  it("handles cancellation and errors", () => {
    const traces = store();
    const cancelled = traces.createSession({
      title: "Cancelled",
      source: "agent",
    });
    const failed = traces.createSession({
      title: "Failed",
      source: "agent",
    });

    expect(
      traces.cancelSession({ sessionId: cancelled.id, reason: "user" }),
    ).toMatchObject({ status: "cancelled", error: "user" });
    expect(
      traces.errorSession({
        sessionId: failed.id,
        error: "boom",
        details: { code: "E_TRACE" },
      }),
    ).toMatchObject({ status: "error", error: "boom" });
  });

  it("rejects missing sessions", () => {
    const traces = store();

    expect(() =>
      traces.recordEvent({ sessionId: "missing", kind: "log" }),
    ).toThrow(TraceError);
  });
});
