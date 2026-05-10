/**
 * STREAM — single polymorphic action consolidating live-stream lifecycle.
 *
 * Ops:
 *   go_live     — start the live stream to the active destination
 *   go_offline  — stop the active stream and release capture/RTMP resources
 *
 * Dispatch is HTTP-only (POST /api/stream/{live,offline}). The local API route
 * owns full orchestration — capture mode detection, destination credential
 * resolution, Xvfb/avfoundation/pipe/file dispatch, browser capture lifecycle,
 * screen-capture wiring, and destination notifications. The exported
 * `streamManager` singleton is only one piece of that pipeline; calling it
 * from this action would require replicating every orchestration step, so we
 * keep HTTP as the canonical entry point.
 *
 * @module actions/stream-control
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { hasContextSignalSyncForKey } from "./context-signal.ts";

const STREAM_ACTION = "STREAM";

const STREAM_OPS = ["go_live", "go_offline"] as const;
type StreamOp = (typeof STREAM_OPS)[number];

const API_PORT = process.env.API_PORT || process.env.SERVER_PORT || "2138";
const BASE = `http://127.0.0.1:${API_PORT}`;

interface StreamActionParameters {
  op?: unknown;
}

interface ApiResponse {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

function readOp(value: unknown): StreamOp | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim().toLowerCase();
  return (STREAM_OPS as readonly string[]).includes(s)
    ? (s as StreamOp)
    : undefined;
}

async function apiPost(path: string): Promise<ApiResponse> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Empty or non-JSON body — leave data null.
  }
  return { ok: res.ok, status: res.status, data };
}

function failure(op: StreamOp, message: string): ActionResult {
  return {
    success: false,
    text: message,
    error: `STREAM_${op.toUpperCase()}_FAILED`,
  };
}

async function runGoLive(): Promise<ActionResult> {
  try {
    const result = await apiPost("/api/stream/live");
    if (!result.ok) {
      const detail = result.data?.error ?? `HTTP ${result.status}`;
      return failure("go_live", `Failed to start stream: ${String(detail)}`);
    }
    const live = result.data?.live === true;
    return {
      success: true,
      text: live
        ? "Stream is now live."
        : "Stream start requested but may not be live yet — check status.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure("go_live", `Failed to start stream: ${message}`);
  }
}

async function runGoOffline(): Promise<ActionResult> {
  try {
    const result = await apiPost("/api/stream/offline");
    if (!result.ok) {
      const detail = result.data?.error ?? `HTTP ${result.status}`;
      return failure("go_offline", `Failed to stop stream: ${String(detail)}`);
    }
    return {
      success: true,
      text: "Stream stopped. Now offline.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure("go_offline", `Failed to stop stream: ${message}`);
  }
}

export const streamAction: Action = {
  name: STREAM_ACTION,
  contexts: ["general", "media", "automation", "settings"],
  roleGate: { minRole: "OWNER" },
  description:
    "Control the live stream lifecycle. Use op='go_live' to start broadcasting " +
    "to the active destination (Twitch, YouTube, custom RTMP). Use " +
    "op='go_offline' to stop any active stream and release capture/RTMP " +
    "resources.",
  descriptionCompressed:
    "control live stream: op=go_live start broadcast active destination; op=go_offline stop release capture RTMP",
  parameters: [
    {
      name: "subaction",
      description: `Operation: ${STREAM_OPS.join(", ")}.`,
      required: true,
      schema: { type: "string" as const, enum: [...STREAM_OPS] },
    },
  ],
  validate: async (_runtime, message, state) => {
    return hasContextSignalSyncForKey(message, state, "stream_control");
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options ?? {}) as StreamActionParameters;
    const op = readOp(params.op);
    if (!op) {
      return {
        success: false,
        text: `Invalid stream op. Expected one of: ${STREAM_OPS.join(", ")}`,
        error: "STREAM_INVALID",
      };
    }
    switch (op) {
      case "go_live":
        return runGoLive();
      case "go_offline":
        return runGoOffline();
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Let's start the stream now." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Stream is now live.",
          actions: [STREAM_ACTION],
          actionParameters: { op: "go_live" },
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Take us offline, please." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Stream stopped. Now offline.",
          actions: [STREAM_ACTION],
          actionParameters: { op: "go_offline" },
        },
      },
    ],
  ] as ActionExample[][],
};
