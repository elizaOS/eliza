import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "@elizaos/electrobun-carrots";
import { TraceError } from "./errors";
import type {
  TraceEvent,
  TraceMetadata,
  TraceRecordEventParams,
  TraceSearchParams,
  TraceSession,
  TraceSessionId,
  TraceSessionStatus,
  TraceStartSessionParams,
  TraceSummary,
  TraceTailParams,
  TraceTailResult,
} from "./types";

type TraceEventStringField =
  | "title"
  | "text"
  | "parentEventId"
  | "runId"
  | "agentId"
  | "conversationId"
  | "messageId"
  | "streamId"
  | "toolName"
  | "capabilityId"
  | "modelId"
  | "dynamicViewSessionId";

type TraceEventStringAssignment = {
  field: TraceEventStringField;
  value: string | undefined;
  label: string;
};

export interface TraceStoreOptions {
  maxSessions?: number;
  maxEventsPerSession?: number;
  maxEventPayloadBytes?: number;
  defaultTailLimit?: number;
  maxTailLimit?: number;
  now?: () => Date;
  sessionIdFactory?: () => string;
  eventIdFactory?: () => string;
}

const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_EVENTS_PER_SESSION = 5_000;
const DEFAULT_MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_TAIL_LIMIT = 100;
const DEFAULT_MAX_TAIL_LIMIT = 500;

function readPositiveIntEnv(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function cloneMetadata(
  metadata: TraceMetadata | undefined,
): TraceMetadata | undefined {
  if (metadata === undefined) return undefined;
  return { ...metadata };
}

function cloneSession(session: TraceSession): TraceSession {
  return { ...session, metadata: cloneMetadata(session.metadata) };
}

function cloneEvent(event: TraceEvent): TraceEvent {
  return { ...event, timing: event.timing ? { ...event.timing } : undefined };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeJsonValue(
  value: JsonValue | undefined,
  maxBytes: number,
): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    const size = byteLength(serialized);
    if (size <= maxBytes) return value;
    return {
      tracePayloadTruncated: true,
      bytes: size,
      maxBytes,
      preview: serialized.slice(0, Math.min(2048, maxBytes)),
    };
  } catch (error) {
    return {
      tracePayloadUnserializable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function eventMatchesText(event: TraceEvent, query: string): boolean {
  const haystack = [
    event.kind,
    event.title,
    event.text,
    event.toolName,
    event.capabilityId,
    event.modelId,
    event.source,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function durationMs(
  start: string | undefined,
  end: string | undefined,
): number | undefined {
  if (!start || !end) return undefined;
  const startedAt = Date.parse(start);
  const completedAt = Date.parse(end);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) {
    return undefined;
  }
  return Math.max(0, completedAt - startedAt);
}

export class TraceStore {
  private readonly maxSessions: number;
  private readonly maxEventsPerSession: number;
  private readonly maxEventPayloadBytes: number;
  private readonly defaultTailLimit: number;
  private readonly maxTailLimit: number;
  private readonly now: () => Date;
  private readonly sessionIdFactory: () => string;
  private readonly eventIdFactory: () => string;
  private readonly sessions = new Map<TraceSessionId, TraceSession>();
  private readonly events = new Map<TraceSessionId, TraceEvent[]>();
  private readonly sequences = new Map<TraceSessionId, number>();

  constructor(options: TraceStoreOptions = {}) {
    this.maxSessions =
      options.maxSessions ??
      readPositiveIntEnv("ELIZA_TRACE_MAX_SESSIONS", DEFAULT_MAX_SESSIONS);
    this.maxEventsPerSession =
      options.maxEventsPerSession ??
      readPositiveIntEnv(
        "ELIZA_TRACE_MAX_EVENTS_PER_SESSION",
        DEFAULT_MAX_EVENTS_PER_SESSION,
      );
    this.maxEventPayloadBytes =
      options.maxEventPayloadBytes ??
      readPositiveIntEnv(
        "ELIZA_TRACE_MAX_EVENT_PAYLOAD_BYTES",
        DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
      );
    this.defaultTailLimit = options.defaultTailLimit ?? DEFAULT_TAIL_LIMIT;
    this.maxTailLimit = options.maxTailLimit ?? DEFAULT_MAX_TAIL_LIMIT;
    this.now = options.now ?? (() => new Date());
    this.sessionIdFactory = options.sessionIdFactory ?? (() => randomUUID());
    this.eventIdFactory = options.eventIdFactory ?? (() => randomUUID());
  }

  createSession(params: TraceStartSessionParams): TraceSession {
    this.assertNonEmptyString(params.title, "title");
    const timestamp = nowIso(this.now);
    const session: TraceSession = {
      id: `trace-${this.sessionIdFactory()}`,
      title: params.title.trim(),
      source: params.source,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const runId = this.optionalString(params.runId, "runId");
    const agentId = this.optionalString(params.agentId, "agentId");
    const conversationId = this.optionalString(
      params.conversationId,
      "conversationId",
    );
    const messageId = this.optionalString(params.messageId, "messageId");
    const streamId = this.optionalString(params.streamId, "streamId");
    if (runId !== undefined) session.runId = runId;
    if (agentId !== undefined) session.agentId = agentId;
    if (conversationId !== undefined) session.conversationId = conversationId;
    if (messageId !== undefined) session.messageId = messageId;
    if (streamId !== undefined) session.streamId = streamId;
    if (params.metadata !== undefined) {
      session.metadata = cloneMetadata(params.metadata);
    }
    this.sessions.set(session.id, session);
    this.events.set(session.id, []);
    this.sequences.set(session.id, 0);
    this.pruneSessions();
    return cloneSession(session);
  }

  updateDynamicViewSession(
    sessionId: TraceSessionId,
    dynamicViewSessionId: string,
  ): TraceSession {
    const session = this.requireSession(sessionId);
    this.assertNonEmptyString(dynamicViewSessionId, "dynamicViewSessionId");
    session.dynamicViewSessionId = dynamicViewSessionId;
    session.updatedAt = nowIso(this.now);
    return cloneSession(session);
  }

  mergeSessionMetadata(
    sessionId: TraceSessionId,
    metadata: TraceMetadata,
  ): TraceSession {
    const session = this.requireSession(sessionId);
    session.metadata = { ...(session.metadata ?? {}), ...metadata };
    session.updatedAt = nowIso(this.now);
    return cloneSession(session);
  }

  completeSession(params: {
    sessionId: TraceSessionId;
    metadata?: TraceMetadata;
  }): TraceSession {
    return this.closeSession(
      params.sessionId,
      "completed",
      undefined,
      params.metadata,
    );
  }

  cancelSession(params: {
    sessionId: TraceSessionId;
    reason?: string;
  }): TraceSession {
    return this.closeSession(params.sessionId, "cancelled", params.reason);
  }

  errorSession(params: {
    sessionId: TraceSessionId;
    error: string;
    details?: JsonValue;
  }): TraceSession {
    const session = this.closeSession(params.sessionId, "error", params.error);
    if (params.details !== undefined) {
      const current = this.requireSession(params.sessionId);
      current.metadata = {
        ...(current.metadata ?? {}),
        errorDetails:
          safeJsonValue(params.details, this.maxEventPayloadBytes) ?? null,
      };
      return cloneSession(current);
    }
    return session;
  }

  recordEvent(params: TraceRecordEventParams): TraceEvent {
    const session = this.requireSession(params.sessionId);
    const timestamp = nowIso(this.now);
    const sequence = (this.sequences.get(session.id) ?? 0) + 1;
    this.sequences.set(session.id, sequence);
    const event: TraceEvent = {
      id: `trace-event-${this.eventIdFactory()}`,
      sessionId: session.id,
      sequence,
      kind: params.kind,
      timestamp,
    };
    this.assignEventStrings(event, [
      { field: "title", value: params.title, label: "title" },
      { field: "text", value: params.text, label: "text" },
      {
        field: "parentEventId",
        value: params.parentEventId,
        label: "parentEventId",
      },
      { field: "runId", value: params.runId ?? session.runId, label: "runId" },
      {
        field: "agentId",
        value: params.agentId ?? session.agentId,
        label: "agentId",
      },
      {
        field: "conversationId",
        value: params.conversationId ?? session.conversationId,
        label: "conversationId",
      },
      {
        field: "messageId",
        value: params.messageId ?? session.messageId,
        label: "messageId",
      },
      {
        field: "streamId",
        value: params.streamId ?? session.streamId,
        label: "streamId",
      },
      { field: "toolName", value: params.toolName, label: "toolName" },
      {
        field: "capabilityId",
        value: params.capabilityId,
        label: "capabilityId",
      },
      { field: "modelId", value: params.modelId, label: "modelId" },
      {
        field: "dynamicViewSessionId",
        value: params.dynamicViewSessionId ?? session.dynamicViewSessionId,
        label: "dynamicViewSessionId",
      },
    ]);
    if (params.source !== undefined) event.source = params.source;
    if (params.timing !== undefined) event.timing = { ...params.timing };
    this.assignEventPayloads(event, params);
    this.pushEvent(session, event, timestamp);
    return cloneEvent(event);
  }

  listSessions(
    params: { limit?: number; status?: TraceSessionStatus } = {},
  ): TraceSession[] {
    const limit = this.normalizeLimit(params.limit, this.maxSessions);
    return [...this.sessions.values()]
      .filter((session) => !params.status || session.status === params.status)
      .slice(-limit)
      .map(cloneSession)
      .reverse();
  }

  getSession(sessionId: TraceSessionId): TraceSession {
    return cloneSession(this.requireSession(sessionId));
  }

  summarizeSession(sessionId: TraceSessionId): TraceSummary {
    const session = this.requireSession(sessionId);
    const sessionEvents = this.events.get(sessionId) ?? [];
    const firstEvent = sessionEvents[0];
    const lastEvent = sessionEvents[sessionEvents.length - 1];
    return {
      session: cloneSession(session),
      eventCount: sessionEvents.length,
      firstEventAt: firstEvent?.timestamp,
      lastEventAt: lastEvent?.timestamp,
      durationMs: durationMs(
        session.createdAt,
        session.completedAt ?? lastEvent?.timestamp,
      ),
      errorCount: sessionEvents.filter(
        (event) => event.kind.endsWith(".error") || event.kind === "error",
      ).length,
      toolCount: sessionEvents.filter((event) => event.kind === "tool.started")
        .length,
      modelCallCount: sessionEvents.filter(
        (event) => event.kind === "model.request.started",
      ).length,
      capabilityCallCount: sessionEvents.filter(
        (event) => event.kind === "capability.invoke.started",
      ).length,
    };
  }

  tailEvents(params: TraceTailParams): TraceTailResult {
    this.requireSession(params.sessionId);
    const limit = this.normalizeLimit(params.limit, this.maxTailLimit);
    const afterSequence = params.afterSequence ?? 0;
    const sessionEvents = this.events.get(params.sessionId) ?? [];
    const selected =
      params.afterSequence === undefined
        ? sessionEvents.slice(-limit)
        : sessionEvents
            .filter((event) => event.sequence > afterSequence)
            .slice(0, limit);
    return {
      sessionId: params.sessionId,
      events: selected.map(cloneEvent),
      nextSequence: selected[selected.length - 1]?.sequence ?? afterSequence,
    };
  }

  searchEvents(params: TraceSearchParams): TraceEvent[] {
    const limit = this.normalizeLimit(params.limit, this.maxTailLimit);
    const query = params.query?.trim();
    const events = [...this.events.values()].flat();
    return events
      .filter((event) => {
        const session = this.sessions.get(event.sessionId);
        if (!session) return false;
        if (params.kinds && !params.kinds.includes(event.kind)) return false;
        if (
          params.source &&
          event.source !== params.source &&
          session.source !== params.source
        ) {
          return false;
        }
        if (
          params.runId &&
          event.runId !== params.runId &&
          session.runId !== params.runId
        ) {
          return false;
        }
        if (
          params.agentId &&
          event.agentId !== params.agentId &&
          session.agentId !== params.agentId
        ) {
          return false;
        }
        if (
          params.conversationId &&
          event.conversationId !== params.conversationId &&
          session.conversationId !== params.conversationId
        ) {
          return false;
        }
        return !query || eventMatchesText(event, query);
      })
      .slice(-limit)
      .map(cloneEvent)
      .reverse();
  }

  private closeSession(
    sessionId: TraceSessionId,
    status: Exclude<TraceSessionStatus, "running">,
    error?: string,
    metadata?: TraceMetadata,
  ): TraceSession {
    const session = this.requireSession(sessionId);
    const timestamp = nowIso(this.now);
    session.status = status;
    session.updatedAt = timestamp;
    session.completedAt = timestamp;
    if (error !== undefined) session.error = error;
    if (metadata !== undefined) {
      session.metadata = { ...(session.metadata ?? {}), ...metadata };
    }
    return cloneSession(session);
  }

  private requireSession(sessionId: TraceSessionId): TraceSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new TraceError(
        "TRACE_SESSION_NOT_FOUND",
        `Trace session was not found: ${sessionId}`,
      );
    }
    return session;
  }

  private normalizeLimit(limit: number | undefined, max: number): number {
    if (limit === undefined) return Math.min(this.defaultTailLimit, max);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new TraceError(
        "TRACE_INVALID_REQUEST",
        `Trace limit must be a positive number: ${String(limit)}`,
      );
    }
    return Math.min(Math.floor(limit), max);
  }

  private assertNonEmptyString(value: string | undefined, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TraceError(
        "TRACE_INVALID_REQUEST",
        `${field} must be a non-empty string.`,
      );
    }
  }

  private optionalString(
    value: string | undefined,
    key: string,
  ): string | undefined {
    if (value === undefined) return undefined;
    if (value.trim().length === 0) {
      throw new TraceError(
        "TRACE_INVALID_REQUEST",
        `${key} must be a non-empty string.`,
      );
    }
    return value;
  }

  private assignEventStrings(
    event: TraceEvent,
    fields: TraceEventStringAssignment[],
  ): void {
    for (const field of fields) {
      const value = this.optionalString(field.value, field.label);
      if (value !== undefined) event[field.field] = value;
    }
  }

  private assignEventPayloads(
    event: TraceEvent,
    params: Pick<TraceRecordEventParams, "payload" | "raw">,
  ): void {
    const payload = safeJsonValue(params.payload, this.maxEventPayloadBytes);
    const raw = safeJsonValue(params.raw, this.maxEventPayloadBytes);
    if (payload !== undefined) event.payload = payload;
    if (raw !== undefined) event.raw = raw;
  }

  private pushEvent(
    session: TraceSession,
    event: TraceEvent,
    timestamp: string,
  ): void {
    const sessionEvents = this.events.get(session.id);
    if (!sessionEvents) {
      throw new TraceError(
        "TRACE_SESSION_NOT_FOUND",
        `Trace session events not found: ${session.id}`,
      );
    }
    sessionEvents.push(event);
    while (sessionEvents.length > this.maxEventsPerSession) {
      sessionEvents.shift();
    }
    session.updatedAt = timestamp;
  }

  private pruneSessions(): void {
    while (this.sessions.size > this.maxSessions) {
      const removable =
        [...this.sessions.values()].find(
          (session) => session.status !== "running",
        ) ?? this.sessions.values().next().value;
      if (!removable) return;
      this.sessions.delete(removable.id);
      this.events.delete(removable.id);
      this.sequences.delete(removable.id);
    }
  }
}
