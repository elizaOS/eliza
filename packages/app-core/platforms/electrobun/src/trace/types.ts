/** Implements Electrobun desktop types ts behavior for app-core shell integration. */
import type { JsonValue } from "@elizaos/plugin-remote-manifest";

export type TraceSessionId = string;
export type TraceEventId = string;

export type TraceSessionSource =
  | "agent"
  | "chat"
  | "tool"
  | "subagent"
  | "voice"
  | "model"
  | "capability"
  | "system"
  | "developer";

export const TRACE_SESSION_SOURCES: readonly TraceSessionSource[] = [
  "agent",
  "chat",
  "tool",
  "subagent",
  "voice",
  "model",
  "capability",
  "system",
  "developer",
] as const;

export type TraceSessionStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "error";

export const TRACE_SESSION_STATUSES: readonly TraceSessionStatus[] = [
  "running",
  "completed",
  "cancelled",
  "error",
] as const;

export type TraceEventKind =
  | "session.started"
  | "session.completed"
  | "session.cancelled"
  | "session.error"
  | "agent.message.received"
  | "agent.message.stream.started"
  | "agent.message.stream.delta"
  | "agent.message.stream.snapshot"
  | "agent.message.stream.action"
  | "agent.message.stream.done"
  | "agent.message.stream.cancelled"
  | "agent.message.stream.error"
  | "model.request.started"
  | "model.prepare.started"
  | "model.prepare.skipped"
  | "model.first_token"
  | "model.delta"
  | "model.completed"
  | "model.error"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "tool.error"
  | "capability.invoke.started"
  | "capability.invoke.completed"
  | "capability.invoke.error"
  | "subagent.started"
  | "subagent.event"
  | "subagent.completed"
  | "subagent.error"
  | "voice.vad"
  | "voice.turn.started"
  | "voice.asr.partial"
  | "voice.asr.final"
  | "voice.tts.started"
  | "voice.tts.first_audio"
  | "voice.playback.started"
  | "voice.latency.budget"
  | "voice.pipeline.error"
  | "dynamic_view.opened"
  | "dynamic_view.pushed"
  | "dynamic_view.closed"
  | "log"
  | "error";

export const TRACE_EVENT_KINDS: readonly TraceEventKind[] = [
  "session.started",
  "session.completed",
  "session.cancelled",
  "session.error",
  "agent.message.received",
  "agent.message.stream.started",
  "agent.message.stream.delta",
  "agent.message.stream.snapshot",
  "agent.message.stream.action",
  "agent.message.stream.done",
  "agent.message.stream.cancelled",
  "agent.message.stream.error",
  "model.request.started",
  "model.prepare.started",
  "model.prepare.skipped",
  "model.first_token",
  "model.delta",
  "model.completed",
  "model.error",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.error",
  "capability.invoke.started",
  "capability.invoke.completed",
  "capability.invoke.error",
  "subagent.started",
  "subagent.event",
  "subagent.completed",
  "subagent.error",
  "voice.vad",
  "voice.turn.started",
  "voice.asr.partial",
  "voice.asr.final",
  "voice.tts.started",
  "voice.tts.first_audio",
  "voice.playback.started",
  "voice.latency.budget",
  "voice.pipeline.error",
  "dynamic_view.opened",
  "dynamic_view.pushed",
  "dynamic_view.closed",
  "log",
  "error",
] as const;

export interface TraceTiming {
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export type TraceMetadata = Record<string, JsonValue>;

export interface TraceEvent {
  id: TraceEventId;
  sessionId: TraceSessionId;
  sequence: number;
  kind: TraceEventKind;
  title?: string;
  text?: string;
  source?: TraceSessionSource;
  parentEventId?: TraceEventId;
  runId?: string;
  agentId?: string;
  conversationId?: string;
  messageId?: string;
  streamId?: string;
  toolName?: string;
  capabilityId?: string;
  modelId?: string;
  dynamicViewSessionId?: string;
  timing?: TraceTiming;
  payload?: JsonValue;
  raw?: JsonValue;
  timestamp: string;
}

export interface TraceSession {
  id: TraceSessionId;
  title: string;
  source: TraceSessionSource;
  status: TraceSessionStatus;
  runId?: string;
  agentId?: string;
  conversationId?: string;
  messageId?: string;
  streamId?: string;
  dynamicViewSessionId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  metadata?: TraceMetadata;
}

export interface TraceStartSessionParams {
  title: string;
  source: TraceSessionSource;
  runId?: string;
  agentId?: string;
  conversationId?: string;
  messageId?: string;
  streamId?: string;
  metadata?: TraceMetadata;
  openView?: boolean;
}

export interface TraceRecordEventParams {
  sessionId: TraceSessionId;
  kind: TraceEventKind;
  title?: string;
  text?: string;
  source?: TraceSessionSource;
  parentEventId?: TraceEventId;
  runId?: string;
  agentId?: string;
  conversationId?: string;
  messageId?: string;
  streamId?: string;
  toolName?: string;
  capabilityId?: string;
  modelId?: string;
  dynamicViewSessionId?: string;
  timing?: TraceTiming;
  payload?: JsonValue;
  raw?: JsonValue;
}

export interface TraceTailParams {
  sessionId: TraceSessionId;
  afterSequence?: number;
  limit?: number;
}

export interface TraceTailResult {
  sessionId: TraceSessionId;
  events: TraceEvent[];
  nextSequence: number;
}

export interface TraceSearchParams {
  query?: string;
  kinds?: TraceEventKind[];
  source?: TraceSessionSource;
  runId?: string;
  agentId?: string;
  conversationId?: string;
  limit?: number;
}

export interface TraceSummary {
  session: TraceSession;
  eventCount: number;
  firstEventAt?: string;
  lastEventAt?: string;
  durationMs?: number;
  errorCount: number;
  toolCount: number;
  modelCallCount: number;
  capabilityCallCount: number;
}
