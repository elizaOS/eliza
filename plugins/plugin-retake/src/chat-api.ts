import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";

import { LOCAL_API_PORT, TAG } from "./constants.ts";
import { pluginRuntime } from "./state.ts";
import type { RetakeChatComment } from "./types.ts";

// ---------------------------------------------------------------------------
// Chat API helpers
// ---------------------------------------------------------------------------

export async function fetchChatComments(
  apiUrl: string,
  token: string,
  userDbId: string,
  limit = 50,
): Promise<RetakeChatComment[]> {
  const params = new URLSearchParams({
    userDbId,
    limit: String(limit),
  });

  const res = await fetch(`${apiUrl}/agent/stream/comments?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    pluginRuntime?.logger.warn(`${TAG} Chat API returned ${res.status}`);
    return [];
  }
  const data = (await res.json()) as Record<string, unknown>;
  // The API may return an array directly, or { comments: [...] }
  const comments = Array.isArray(data)
    ? (data as RetakeChatComment[])
    : Array.isArray(data.comments)
      ? (data.comments as RetakeChatComment[])
      : [];
  return comments;
}

export async function sendChatMessage(
  apiUrl: string,
  token: string,
  message: string,
  destinationUserDbId: string,
): Promise<void> {
  await fetch(`${apiUrl}/agent/stream/chat/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message,
      destination_user_id: destinationUserDbId,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

// ---------------------------------------------------------------------------
// Message routing helpers (same pattern as WhatsApp service)
// ---------------------------------------------------------------------------

export function getMessagingAPI(runtime: IAgentRuntime): {
  sendMessage: (
    agentId: UUID,
    message: Memory,
    opts: { onResponse: (content: Content) => Promise<Memory[]> },
  ) => Promise<void>;
} | null {
  const rt = runtime as unknown as Record<string, unknown>;
  if (
    "elizaOS" in rt &&
    typeof rt.elizaOS === "object" &&
    rt.elizaOS !== null &&
    typeof (rt.elizaOS as Record<string, unknown>).sendMessage === "function"
  ) {
    return rt.elizaOS as ReturnType<typeof getMessagingAPI> & object;
  }
  return null;
}

export function getMessageService(runtime: IAgentRuntime): {
  handleMessage: (
    runtime: IAgentRuntime,
    message: Memory,
    callback: (content: Content) => Promise<Memory[]>,
  ) => Promise<unknown>;
} | null {
  const rt = runtime as unknown as Record<string, unknown>;
  const svc = rt.messageService as Record<string, unknown> | null | undefined;
  if (svc && typeof svc.handleMessage === "function") {
    return svc as ReturnType<typeof getMessageService> & object;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event emission — POST to local API to push events into the WebSocket stream.
// ---------------------------------------------------------------------------

export function emitRetakeEvent(
  _runtime: IAgentRuntime,
  stream: string,
  data: Record<string, unknown>,
  roomId?: string,
): void {
  try {
    void fetch(`http://127.0.0.1:${LOCAL_API_PORT}/api/agent/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream,
        data: { ...data, source: "retake" },
        roomId: roomId ?? undefined,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      // Non-fatal — event emission should never break chat flow
    });
  } catch {
    // Non-fatal
  }
}
