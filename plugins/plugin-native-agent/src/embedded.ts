/**
 * Contract of the `EmbeddedAgent` Capacitor plugin: the cloud-only embedded
 * agent a consumer hosts from data (EmbeddedAgentService on Android). The
 * native bridge admits only the consumer's configured routes; in a browser the
 * web fallback reaches the development agent through the Vite plugin in
 * `native-host/embedded-agent.mjs`.
 */
import { registerPlugin } from "@capacitor/core";

export type EmbeddedAgentFailure =
  | "payload"
  | "storage"
  | "config"
  | "credential"
  | "agent"
  | "crashed"
  | "runtime";

export interface EmbeddedAgentStatus {
  available: boolean;
  state: "unavailable" | "stopped" | "starting" | "running" | "failed";
  failure?: EmbeddedAgentFailure;
  error?: string;
  epoch?: number;
  onDevice?: boolean;
  requestBodyLimit?: number;
}

export interface EmbeddedAgentRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}

export interface EmbeddedAgentResponse {
  status: number;
  data: unknown;
}

export interface EmbeddedAgentStreamData {
  id: string;
  data: string;
}

export interface EmbeddedAgentStreamEnd {
  id: string;
  status?: number;
  data?: unknown;
  error?: string;
  code?: string;
  aborted?: boolean;
}

export interface EmbeddedAgentListener {
  remove: () => Promise<void>;
}

export interface EmbeddedAgentPlugin {
  getStatus(): Promise<EmbeddedAgentStatus>;
  start(): Promise<EmbeddedAgentStatus>;
  restart(): Promise<EmbeddedAgentStatus>;
  stop(): Promise<EmbeddedAgentStatus>;
  request(options: EmbeddedAgentRequest): Promise<EmbeddedAgentResponse>;
  /** Each server-sent event's data arrives as `streamData`, then one `streamEnd`. `id` is the caller's, 8-64 of `[A-Za-z0-9-]`.
   * A refused route rejects the call with `ROUTE_REFUSED`; an agent that is not ready ends the stream with `RUNTIME_NOT_READY`. */
  requestStream(
    options: EmbeddedAgentRequest & { id: string },
  ): Promise<{ id: string }>;
  abort(options: { id: string }): Promise<{ aborted: boolean }>;
  addListener(
    eventName: "status",
    listener: (status: EmbeddedAgentStatus) => void,
  ): Promise<EmbeddedAgentListener>;
  addListener(
    eventName: "streamData",
    listener: (event: EmbeddedAgentStreamData) => void,
  ): Promise<EmbeddedAgentListener>;
  addListener(
    eventName: "streamEnd",
    listener: (event: EmbeddedAgentStreamEnd) => void,
  ): Promise<EmbeddedAgentListener>;
}

export const EMBEDDED_AGENT_PREFIX = "/__eliza-embedded-agent";

export const EmbeddedAgent = registerPlugin<EmbeddedAgentPlugin>(
  "EmbeddedAgent",
  {
    web: () =>
      import("./embedded-web.js").then((m) => new m.EmbeddedAgentWeb()),
  },
);
