/** Exercises trace service behavior with deterministic app-core test fixtures. */
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import { describe, expect, it } from "vitest";
import { DynamicViewRegistry } from "../dynamic-views/registry";
import { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import { TRACE_DYNAMIC_VIEW_ID } from "./trace-dynamic-view";
import { TraceService } from "./trace-service";
import { TraceStore } from "./trace-store";

class FakeCanvas {
  readonly windows: Array<{ id: string; url?: string; title?: string }> = [];
  readonly pushes: Array<{ id: string; payload: JsonValue }> = [];
  readonly destroyed: string[] = [];

  async createWindow(options: {
    url?: string;
    title?: string;
  }): Promise<{ id: string }> {
    const id = `canvas-${this.windows.length + 1}`;
    this.windows.push({ id, url: options.url, title: options.title });
    return { id };
  }

  async destroyWindow(options: { id: string }): Promise<void> {
    this.destroyed.push(options.id);
  }

  async a2uiPush(options: { id: string; payload: JsonValue }): Promise<void> {
    this.pushes.push(options);
  }
}

class FakeWorkerStatusProvider {
  getWorkerStatus(id: string): { state: string } | null {
    return id === "eliza.runtime" ? { state: "running" } : null;
  }
}

function service(env: Record<string, string | undefined> = {}): {
  service: TraceService;
  registry: DynamicViewRegistry;
  canvas: FakeCanvas;
} {
  let traceSessionCount = 0;
  const registry = new DynamicViewRegistry();
  const canvas = new FakeCanvas();
  const sessions = new DynamicViewSessionManager({
    registry,
    canvas,
    workerStatusProvider: new FakeWorkerStatusProvider(),
    now: () => new Date("2026-05-17T12:00:00.000Z"),
    sessionIdFactory: () => "view-session-1",
  });
  return {
    service: new TraceService({
      store: new TraceStore({
        now: () => new Date("2026-05-17T12:00:00.000Z"),
        sessionIdFactory: () => `trace-session-${++traceSessionCount}`,
        eventIdFactory: () => `event-${canvas.pushes.length + 1}`,
      }),
      dynamicViewRegistry: registry,
      dynamicViewSessions: sessions,
      env,
    }),
    registry,
    canvas,
  };
}

describe("TraceService", () => {
  it("starts sessions without auto-opening by default", async () => {
    const harness = service();
    const session = await harness.service.startSession({
      title: "Agent run",
      source: "agent",
    });

    expect(session.dynamicViewSessionId).toBeUndefined();
    expect(harness.canvas.windows).toHaveLength(0);
    expect(
      await harness.service.tailEvents({ sessionId: session.id }),
    ).toMatchObject({
      events: [{ kind: "session.started" }],
    });
  });

  it("opens the built-in trace view and pushes events", async () => {
    const harness = service();
    const session = await harness.service.startSession({
      title: "Agent run",
      source: "agent",
    });
    const opened = await harness.service.openTraceView({
      sessionId: session.id,
    });
    const event = await harness.service.recordEvent({
      sessionId: session.id,
      kind: "tool.completed",
      toolName: "GIT_STATUS",
      payload: { changed: 2 },
    });

    expect(harness.registry.get(TRACE_DYNAMIC_VIEW_ID)?.title).toBe(
      "Agent Run Trace",
    );
    expect(opened.dynamicViewSessionId).toBe("dynamic-view-view-session-1");
    expect(event.sequence).toBe(3);
    expect(harness.canvas.windows[0].title).toBe("Agent run");
    expect(harness.canvas.pushes[0].payload).toMatchObject({
      type: "dynamic-view.session.opened",
    });
    expect(harness.canvas.pushes[2].payload).toMatchObject({
      type: "dynamic-view.event",
      event: "trace.event",
      payload: {
        event: {
          kind: "tool.completed",
          toolName: "GIT_STATUS",
        },
      },
    });
  });

  it("auto-opens when requested by params or env", async () => {
    const explicit = service();
    const explicitSession = await explicit.service.startSession({
      title: "Explicit",
      source: "agent",
      openView: true,
    });
    const configured = service({ ELIZA_TRACE_AUTO_OPEN: "1" });
    const configuredSession = await configured.service.startSession({
      title: "Configured",
      source: "agent",
    });

    expect(explicitSession.dynamicViewSessionId).toBe(
      "dynamic-view-view-session-1",
    );
    expect(configuredSession.dynamicViewSessionId).toBe(
      "dynamic-view-view-session-1",
    );
  });

  it("summarizes, searches, completes, and cancels sessions", async () => {
    const harness = service();
    const session = await harness.service.startSession({
      title: "Agent run",
      source: "agent",
    });
    await harness.service.recordEvent({
      sessionId: session.id,
      kind: "model.request.started",
      modelId: "eliza-1-2b",
    });
    await harness.service.recordEvent({
      sessionId: session.id,
      kind: "capability.invoke.started",
      capabilityId: "eliza.git",
    });
    await harness.service.completeSession({ sessionId: session.id });

    expect(
      await harness.service.searchEvents({ query: "eliza.git" }),
    ).toMatchObject([{ kind: "capability.invoke.started" }]);
    expect(
      await harness.service.summarizeSession({ sessionId: session.id }),
    ).toMatchObject({
      eventCount: 4,
      modelCallCount: 1,
      capabilityCallCount: 1,
      session: { status: "completed" },
    });

    const cancelled = await harness.service.startSession({
      title: "Cancelled",
      source: "agent",
    });
    await harness.service.cancelSession({
      sessionId: cancelled.id,
      reason: "user",
    });
    expect(
      await harness.service.getSession({ sessionId: cancelled.id }),
    ).toMatchObject({ status: "cancelled" });
  });
});
