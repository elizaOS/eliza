import type { JsonValue } from "@elizaos/electrobun-carrots";
import type { DynamicViewRegistry } from "../dynamic-views/registry";
import type { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import { TraceError } from "./errors";
import {
  TRACE_DYNAMIC_VIEW_ID,
  createTraceDynamicViewManifest,
} from "./trace-dynamic-view";
import { TraceStore } from "./trace-store";
import type {
  TraceEvent,
  TraceMetadata,
  TraceRecordEventParams,
  TraceSearchParams,
  TraceSession,
  TraceSessionStatus,
  TraceStartSessionParams,
  TraceSummary,
  TraceTailParams,
  TraceTailResult,
} from "./types";

export interface TraceServiceOptions {
  store?: TraceStore;
  dynamicViewRegistry: DynamicViewRegistry;
  dynamicViewSessions: DynamicViewSessionManager;
  env?: Record<string, string | undefined>;
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function nullable<T extends JsonValue>(value: T | undefined): T | null {
  return value ?? null;
}

function traceTimingToJson(event: TraceEvent): JsonValue {
  if (!event.timing) return null;
  return {
    startedAt: nullable(event.timing.startedAt),
    completedAt: nullable(event.timing.completedAt),
    durationMs: nullable(event.timing.durationMs),
  };
}

export function traceEventToJson(event: TraceEvent): JsonValue {
  return {
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    kind: event.kind,
    title: nullable(event.title),
    text: nullable(event.text),
    source: nullable(event.source),
    parentEventId: nullable(event.parentEventId),
    runId: nullable(event.runId),
    agentId: nullable(event.agentId),
    conversationId: nullable(event.conversationId),
    messageId: nullable(event.messageId),
    streamId: nullable(event.streamId),
    toolName: nullable(event.toolName),
    capabilityId: nullable(event.capabilityId),
    modelId: nullable(event.modelId),
    dynamicViewSessionId: nullable(event.dynamicViewSessionId),
    timing: traceTimingToJson(event),
    payload: nullable(event.payload),
    raw: nullable(event.raw),
    timestamp: event.timestamp,
  };
}

export function traceSessionToJson(session: TraceSession): JsonValue {
  return {
    id: session.id,
    title: session.title,
    source: session.source,
    status: session.status,
    runId: session.runId ?? null,
    agentId: session.agentId ?? null,
    conversationId: session.conversationId ?? null,
    messageId: session.messageId ?? null,
    streamId: session.streamId ?? null,
    dynamicViewSessionId: session.dynamicViewSessionId ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt ?? null,
    error: session.error ?? null,
    metadata: session.metadata ?? null,
  };
}

export function traceSummaryToJson(summary: TraceSummary): JsonValue {
  return {
    session: traceSessionToJson(summary.session),
    eventCount: summary.eventCount,
    firstEventAt: summary.firstEventAt ?? null,
    lastEventAt: summary.lastEventAt ?? null,
    durationMs: summary.durationMs ?? null,
    errorCount: summary.errorCount,
    toolCount: summary.toolCount,
    modelCallCount: summary.modelCallCount,
    capabilityCallCount: summary.capabilityCallCount,
  };
}

export class TraceService {
  private readonly store: TraceStore;
  private readonly dynamicViewRegistry: DynamicViewRegistry;
  private readonly dynamicViewSessions: DynamicViewSessionManager;
  private readonly env: Record<string, string | undefined>;

  constructor(options: TraceServiceOptions) {
    this.store = options.store ?? new TraceStore();
    this.dynamicViewRegistry = options.dynamicViewRegistry;
    this.dynamicViewSessions = options.dynamicViewSessions;
    this.env = options.env ?? process.env;
  }

  async startSession(params: TraceStartSessionParams): Promise<TraceSession> {
    const session = this.store.createSession(params);
    await this.recordEvent({
      sessionId: session.id,
      kind: "session.started",
      title: session.title,
      source: session.source,
      runId: session.runId,
      agentId: session.agentId,
      conversationId: session.conversationId,
      messageId: session.messageId,
      streamId: session.streamId,
      payload: {
        metadata: session.metadata ?? null,
      },
    });
    if (params.openView === true || isTruthy(this.env.ELIZA_TRACE_AUTO_OPEN)) {
      return (await this.openTraceView({ sessionId: session.id })).session;
    }
    return this.store.getSession(session.id);
  }

  async completeSession(params: {
    sessionId: string;
    metadata?: TraceMetadata;
  }): Promise<TraceSession> {
    const session = this.store.completeSession(params);
    await this.recordEvent({
      sessionId: params.sessionId,
      kind: "session.completed",
      title: session.title,
      source: session.source,
      payload: { metadata: params.metadata ?? null },
    });
    return this.store.getSession(params.sessionId);
  }

  async cancelSession(params: {
    sessionId: string;
    reason?: string;
  }): Promise<TraceSession> {
    const session = this.store.cancelSession(params);
    await this.recordEvent({
      sessionId: params.sessionId,
      kind: "session.cancelled",
      title: session.title,
      text: params.reason,
      source: session.source,
    });
    return this.store.getSession(params.sessionId);
  }

  async errorSession(params: {
    sessionId: string;
    error: string;
    details?: JsonValue;
  }): Promise<TraceSession> {
    const session = this.store.errorSession(params);
    await this.recordEvent({
      sessionId: params.sessionId,
      kind: "session.error",
      title: session.title,
      text: params.error,
      source: session.source,
      payload: params.details,
    });
    return this.store.getSession(params.sessionId);
  }

  async recordEvent(params: TraceRecordEventParams): Promise<TraceEvent> {
    const event = this.store.recordEvent(params);
    await this.pushTraceViewEvent(event);
    return event;
  }

  async listSessions(params?: {
    limit?: number;
    status?: TraceSessionStatus;
  }): Promise<TraceSession[]> {
    return this.store.listSessions(params);
  }

  async getSession(params: { sessionId: string }): Promise<TraceSession> {
    return this.store.getSession(params.sessionId);
  }

  async summarizeSession(params: { sessionId: string }): Promise<TraceSummary> {
    return this.store.summarizeSession(params.sessionId);
  }

  async tailEvents(params: TraceTailParams): Promise<TraceTailResult> {
    return this.store.tailEvents(params);
  }

  async searchEvents(params: TraceSearchParams): Promise<TraceEvent[]> {
    return this.store.searchEvents(params);
  }

  async openTraceView(params: {
    sessionId: string;
  }): Promise<{ session: TraceSession; dynamicViewSessionId: string }> {
    this.ensureTraceViewRegistered();
    const session = this.store.getSession(params.sessionId);
    if (session.dynamicViewSessionId) {
      return {
        session,
        dynamicViewSessionId: session.dynamicViewSessionId,
      };
    }
    const summary = this.store.summarizeSession(params.sessionId);
    const tail = this.store.tailEvents({ sessionId: params.sessionId });
    try {
      const dynamicSession = await this.dynamicViewSessions.open({
        viewId: TRACE_DYNAMIC_VIEW_ID,
        title: session.title,
        initialState: {
          session: traceSessionToJson(session),
          summary: traceSummaryToJson(summary),
          events: tail.events.map(traceEventToJson),
        },
        metadata: {
          traceSessionId: session.id,
        },
      });
      const updated = this.store.updateDynamicViewSession(
        session.id,
        dynamicSession.sessionId,
      );
      const opened = this.store.recordEvent({
        sessionId: session.id,
        kind: "dynamic_view.opened",
        title: "Trace view opened",
        source: "system",
        dynamicViewSessionId: dynamicSession.sessionId,
      });
      await this.pushTraceView({
        sessionId: session.id,
        event: opened,
      });
      return {
        session: updated,
        dynamicViewSessionId: dynamicSession.sessionId,
      };
    } catch (error) {
      throw new TraceError(
        "TRACE_VIEW_OPEN_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async pushTraceView(params: {
    sessionId: string;
    event: TraceEvent;
  }): Promise<{ ok: true }> {
    const session = this.store.getSession(params.sessionId);
    if (!session.dynamicViewSessionId) {
      throw new TraceError(
        "TRACE_VIEW_UNAVAILABLE",
        `Trace session has no dynamic view: ${params.sessionId}`,
      );
    }
    try {
      await this.dynamicViewSessions.push({
        sessionId: session.dynamicViewSessionId,
        event: "trace.event",
        payload: {
          session: traceSessionToJson(session),
          event: traceEventToJson(params.event),
        },
      });
      return { ok: true };
    } catch (error) {
      throw new TraceError(
        "TRACE_VIEW_PUSH_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private ensureTraceViewRegistered(): void {
    this.dynamicViewRegistry.register(createTraceDynamicViewManifest(), {
      update: true,
    });
  }

  private async pushTraceViewEvent(event: TraceEvent): Promise<void> {
    const session = this.store.getSession(event.sessionId);
    if (!session.dynamicViewSessionId) return;
    try {
      await this.pushTraceView({ sessionId: session.id, event });
    } catch (error) {
      this.store.mergeSessionMetadata(session.id, {
        traceViewPushError:
          error instanceof Error ? error.message : String(error),
      });
    }
  }
}
