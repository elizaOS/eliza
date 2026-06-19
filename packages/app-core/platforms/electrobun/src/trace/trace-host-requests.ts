import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import { TraceError } from "./errors";
import {
  type TraceService,
  traceEventToJson,
  traceSessionToJson,
  traceSummaryToJson,
} from "./trace-service";
import {
  TRACE_EVENT_KINDS,
  TRACE_SESSION_SOURCES,
  TRACE_SESSION_STATUSES,
  type TraceEventKind,
  type TraceMetadata,
  type TraceSearchParams,
  type TraceSessionSource,
  type TraceSessionStatus,
  type TraceTiming,
} from "./types";

type JsonRecord = { readonly [key: string]: JsonValue };

export interface TraceHost {
  startSession(params: JsonValue | undefined): Promise<JsonValue>;
  completeSession(params: JsonValue | undefined): Promise<JsonValue>;
  cancelSession(params: JsonValue | undefined): Promise<JsonValue>;
  errorSession(params: JsonValue | undefined): Promise<JsonValue>;
  recordEvent(params: JsonValue | undefined): Promise<JsonValue>;
  listSessions(params: JsonValue | undefined): Promise<JsonValue>;
  getSession(params: JsonValue | undefined): Promise<JsonValue>;
  summarizeSession(params: JsonValue | undefined): Promise<JsonValue>;
  tailEvents(params: JsonValue | undefined): Promise<JsonValue>;
  searchEvents(params: JsonValue | undefined): Promise<JsonValue>;
  openTraceView(params: JsonValue | undefined): Promise<JsonValue>;
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function requireRecord(
  value: JsonValue | undefined,
  method: string,
): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new TraceError(
      "TRACE_INVALID_REQUEST",
      `${method}: expected params object.`,
    );
  }
  return value;
}

function readString(record: JsonRecord, key: string, method: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TraceError(
      "TRACE_INVALID_REQUEST",
      `${method}: ${key} must be a non-empty string.`,
    );
  }
  return value;
}

function readOptionalString(
  record: JsonRecord,
  key: string,
  method: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TraceError(
      "TRACE_INVALID_REQUEST",
      `${method}: ${key} must be a non-empty string.`,
    );
  }
  return value;
}

function readOptionalNumber(
  record: JsonRecord,
  key: string,
  method: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TraceError(
      "TRACE_INVALID_REQUEST",
      `${method}: ${key} must be a finite number.`,
    );
  }
  return value;
}

function readOptionalBoolean(
  record: JsonRecord,
  key: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return value === true;
}

function isTraceSessionSource(value: string): value is TraceSessionSource {
  return TRACE_SESSION_SOURCES.some((source) => source === value);
}

function isTraceSessionStatus(value: string): value is TraceSessionStatus {
  return TRACE_SESSION_STATUSES.some((status) => status === value);
}

function isTraceEventKind(value: string): value is TraceEventKind {
  return TRACE_EVENT_KINDS.some((kind) => kind === value);
}

function readSource(
  record: JsonRecord,
  key: string,
  method: string,
): TraceSessionSource {
  const value = readString(record, key, method);
  if (!isTraceSessionSource(value)) {
    throw new TraceError(
      "TRACE_INVALID_REQUEST",
      `${method}: unsupported source ${value}.`,
    );
  }
  return value;
}

function readOptionalSource(
  record: JsonRecord,
  key: string,
  method: string,
): TraceSessionSource | undefined {
  const value = readOptionalString(record, key, method);
  if (value === undefined) return undefined;
  if (!isTraceSessionSource(value)) {
    throw new TraceError(
      "TRACE_INVALID_REQUEST",
      `${method}: unsupported source ${value}.`,
    );
  }
  return value;
}

function readOptionalStatus(
  record: JsonRecord,
  key: string,
  method: string,
): TraceSessionStatus | undefined {
  const value = readOptionalString(record, key, method);
  if (value === undefined) return undefined;
  if (!isTraceSessionStatus(value)) {
    throw new TraceError(
      "TRACE_INVALID_REQUEST",
      `${method}: unsupported status ${value}.`,
    );
  }
  return value;
}

function readKind(
  record: JsonRecord,
  key: string,
  method: string,
): TraceEventKind {
  const value = readString(record, key, method);
  if (!isTraceEventKind(value)) {
    throw new TraceError(
      "TRACE_INVALID_REQUEST",
      `${method}: unsupported kind ${value}.`,
    );
  }
  return value;
}

function readKindList(
  record: JsonRecord,
  key: string,
  method: string,
): TraceEventKind[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TraceError(
      "TRACE_INVALID_REQUEST",
      `${method}: ${key} must be an array.`,
    );
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !isTraceEventKind(entry)) {
      throw new TraceError(
        "TRACE_INVALID_REQUEST",
        `${method}: ${key} contains an unsupported kind.`,
      );
    }
    return entry;
  });
}

function readMetadata(
  record: JsonRecord,
  key: string,
  method: string,
): TraceMetadata | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isJsonRecord(value)) {
    throw new TraceError(
      "TRACE_INVALID_REQUEST",
      `${method}: ${key} must be an object.`,
    );
  }
  const metadata: TraceMetadata = {};
  for (const [metadataKey, metadataValue] of Object.entries(value)) {
    metadata[metadataKey] = metadataValue;
  }
  return metadata;
}

function readTiming(
  record: JsonRecord,
  method: string,
): TraceTiming | undefined {
  const value = record.timing;
  if (value === undefined) return undefined;
  const timingRecord = requireRecord(value, method);
  const timing: TraceTiming = {};
  const startedAt = readOptionalString(timingRecord, "startedAt", method);
  const completedAt = readOptionalString(timingRecord, "completedAt", method);
  const durationMs = readOptionalNumber(timingRecord, "durationMs", method);
  if (startedAt !== undefined) timing.startedAt = startedAt;
  if (completedAt !== undefined) timing.completedAt = completedAt;
  if (durationMs !== undefined) timing.durationMs = durationMs;
  return timing;
}

export function createTraceHost(service: TraceService): TraceHost {
  return {
    startSession: async (params) => {
      const record = requireRecord(params, "trace-session-start");
      return traceSessionToJson(
        await service.startSession({
          title: readString(record, "title", "trace-session-start"),
          source: readSource(record, "source", "trace-session-start"),
          runId: readOptionalString(record, "runId", "trace-session-start"),
          agentId: readOptionalString(record, "agentId", "trace-session-start"),
          conversationId: readOptionalString(
            record,
            "conversationId",
            "trace-session-start",
          ),
          messageId: readOptionalString(
            record,
            "messageId",
            "trace-session-start",
          ),
          streamId: readOptionalString(
            record,
            "streamId",
            "trace-session-start",
          ),
          metadata: readMetadata(record, "metadata", "trace-session-start"),
          openView: readOptionalBoolean(record, "openView"),
        }),
      );
    },
    completeSession: async (params) => {
      const record = requireRecord(params, "trace-session-complete");
      return traceSessionToJson(
        await service.completeSession({
          sessionId: readString(record, "sessionId", "trace-session-complete"),
          metadata: readMetadata(record, "metadata", "trace-session-complete"),
        }),
      );
    },
    cancelSession: async (params) => {
      const record = requireRecord(params, "trace-session-cancel");
      return traceSessionToJson(
        await service.cancelSession({
          sessionId: readString(record, "sessionId", "trace-session-cancel"),
          reason: readOptionalString(record, "reason", "trace-session-cancel"),
        }),
      );
    },
    errorSession: async (params) => {
      const record = requireRecord(params, "trace-session-error");
      return traceSessionToJson(
        await service.errorSession({
          sessionId: readString(record, "sessionId", "trace-session-error"),
          error: readString(record, "error", "trace-session-error"),
          details: record.details,
        }),
      );
    },
    recordEvent: async (params) => {
      const record = requireRecord(params, "trace-event-record");
      return traceEventToJson(
        await service.recordEvent({
          sessionId: readString(record, "sessionId", "trace-event-record"),
          kind: readKind(record, "kind", "trace-event-record"),
          title: readOptionalString(record, "title", "trace-event-record"),
          text: readOptionalString(record, "text", "trace-event-record"),
          source: readOptionalSource(record, "source", "trace-event-record"),
          parentEventId: readOptionalString(
            record,
            "parentEventId",
            "trace-event-record",
          ),
          runId: readOptionalString(record, "runId", "trace-event-record"),
          agentId: readOptionalString(record, "agentId", "trace-event-record"),
          conversationId: readOptionalString(
            record,
            "conversationId",
            "trace-event-record",
          ),
          messageId: readOptionalString(
            record,
            "messageId",
            "trace-event-record",
          ),
          streamId: readOptionalString(
            record,
            "streamId",
            "trace-event-record",
          ),
          toolName: readOptionalString(
            record,
            "toolName",
            "trace-event-record",
          ),
          capabilityId: readOptionalString(
            record,
            "capabilityId",
            "trace-event-record",
          ),
          modelId: readOptionalString(record, "modelId", "trace-event-record"),
          dynamicViewSessionId: readOptionalString(
            record,
            "dynamicViewSessionId",
            "trace-event-record",
          ),
          timing: readTiming(record, "trace-event-record"),
          payload: record.payload,
          raw: record.raw,
        }),
      );
    },
    listSessions: async (params) => {
      const record =
        params === undefined
          ? undefined
          : requireRecord(params, "trace-session-list");
      return {
        sessions: (
          await service.listSessions({
            limit: record
              ? readOptionalNumber(record, "limit", "trace-session-list")
              : undefined,
            status: record
              ? readOptionalStatus(record, "status", "trace-session-list")
              : undefined,
          })
        ).map(traceSessionToJson),
      };
    },
    getSession: async (params) => {
      const record = requireRecord(params, "trace-session-get");
      return traceSessionToJson(
        await service.getSession({
          sessionId: readString(record, "sessionId", "trace-session-get"),
        }),
      );
    },
    summarizeSession: async (params) => {
      const record = requireRecord(params, "trace-session-summary");
      return traceSummaryToJson(
        await service.summarizeSession({
          sessionId: readString(record, "sessionId", "trace-session-summary"),
        }),
      );
    },
    tailEvents: async (params) => {
      const record = requireRecord(params, "trace-events-tail");
      const result = await service.tailEvents({
        sessionId: readString(record, "sessionId", "trace-events-tail"),
        afterSequence: readOptionalNumber(
          record,
          "afterSequence",
          "trace-events-tail",
        ),
        limit: readOptionalNumber(record, "limit", "trace-events-tail"),
      });
      return {
        sessionId: result.sessionId,
        events: result.events.map(traceEventToJson),
        nextSequence: result.nextSequence,
      };
    },
    searchEvents: async (params) => {
      const record =
        params === undefined
          ? undefined
          : requireRecord(params, "trace-events-search");
      const searchParams: TraceSearchParams = {};
      if (record) {
        const query = readOptionalString(
          record,
          "query",
          "trace-events-search",
        );
        const kinds = readKindList(record, "kinds", "trace-events-search");
        const source = readOptionalSource(
          record,
          "source",
          "trace-events-search",
        );
        const runId = readOptionalString(
          record,
          "runId",
          "trace-events-search",
        );
        const agentId = readOptionalString(
          record,
          "agentId",
          "trace-events-search",
        );
        const conversationId = readOptionalString(
          record,
          "conversationId",
          "trace-events-search",
        );
        const limit = readOptionalNumber(
          record,
          "limit",
          "trace-events-search",
        );
        if (query !== undefined) searchParams.query = query;
        if (kinds !== undefined) searchParams.kinds = kinds;
        if (source !== undefined) searchParams.source = source;
        if (runId !== undefined) searchParams.runId = runId;
        if (agentId !== undefined) searchParams.agentId = agentId;
        if (conversationId !== undefined) {
          searchParams.conversationId = conversationId;
        }
        if (limit !== undefined) searchParams.limit = limit;
      }
      return {
        events: (await service.searchEvents(searchParams)).map(
          traceEventToJson,
        ),
      };
    },
    openTraceView: async (params) => {
      const record = requireRecord(params, "trace-view-open");
      const result = await service.openTraceView({
        sessionId: readString(record, "sessionId", "trace-view-open"),
      });
      return {
        session: traceSessionToJson(result.session),
        dynamicViewSessionId: result.dynamicViewSessionId,
      };
    },
  };
}
