// spec/os/agentService/channel.md, "Story: Ask the agent only on the routes my app allows"; spec/os/agentService/channel.md, "Story: Stream a reply and stop it"; spec/os/agentService/channel.md, "Story: Receive the agent's live events for my screen"
import type { PluginListenerHandle } from "@capacitor/core";
import type { FailCode } from "../../../gen/os__agentService__channel.ts";

export type AgentFailCode = FailCode;

export type AgentFailure = "payload" | "storage" | "config" | "credential" | "agent" | "crashed" | "runtime";

export type AgentStatus = { available: boolean; epoch: number; requestBodyLimit: number } & (
  | { state: "unavailable" | "stopped" | "starting" | "running" }
  | { state: "failed"; failure: AgentFailure; error?: string }
);

export type AgentMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AgentRoute {
  method: AgentMethod;
  path: string;
  body?: Record<string, unknown>;
}

export interface AgentRequest extends AgentRoute {
  id?: string;
}

export interface AgentStreamRequest extends AgentRoute {
  id: string;
}

export interface AgentResponse {
  status: number;
  data: unknown;
}

export type AgentTopic = "voice" | "view";

export interface AgentSubscription {
  id: string;
  topic: AgentTopic;
  clientId?: string;
}

export interface AgentCallId {
  id: string;
}

export interface AgentAbort {
  aborted: boolean;
}

export type AgentStreamData = { id: string; index: number } & (
  | { kind: "head"; status: number; headers: Record<string, string> }
  | { kind: "chunk"; dataBase64: string }
);

export type AgentStreamEnd = { id: string } & (
  | { kind: "end" | "error" | "aborted" }
  | { kind: "failed"; code: AgentFailCode }
);

export type AgentEvent = { id: string } & (
  | { kind: "event"; index: number; event: Record<string, unknown> }
  | { kind: "end" }
  | { kind: "failed"; code: AgentFailCode }
);

export type AgentRecoveryReview =
  | { kind: "reviewable"; reviewToken: string; retainedCount: number }
  | { kind: "unavailable" };

export type AgentRecoveryArchive =
  | { kind: "archived"; archivedCount: number }
  | { kind: "unavailable" };

export interface AgentEvents {
  status: AgentStatus;
  streamData: AgentStreamData;
  streamEnd: AgentStreamEnd;
  agentEvent: AgentEvent;
}

export interface ElizaAgentPlugin {
  getStatus(): Promise<AgentStatus>;
  start(): Promise<AgentStatus>;
  stop(): Promise<AgentStatus>;
  restart(): Promise<AgentStatus>;
  request(options: AgentRequest): Promise<AgentResponse>;
  requestStream(options: AgentStreamRequest): Promise<AgentCallId>;
  abort(options: AgentCallId): Promise<AgentAbort>;
  subscribeEvents(options: AgentSubscription): Promise<AgentCallId>;
  unsubscribeEvents(options: AgentCallId): Promise<AgentAbort>;
  reviewRecovery(): Promise<AgentRecoveryReview>;
  archiveRecovery(options: { reviewToken: string }): Promise<AgentRecoveryArchive>;
  addListener<Name extends keyof AgentEvents>(
    eventName: Name,
    listener: (event: AgentEvents[Name]) => void,
  ): Promise<PluginListenerHandle>;
}
