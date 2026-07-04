/**
 * Server-side autonomy helpers for the agent HTTP surface. Recognizes the
 * LifeOps cloud plugin routes, and forwards autonomy assistant-stream agent
 * events into the user's conversation as proactive text — dropping empty
 * payloads, client-chat echoes, and events whose room is already tracked by an
 * open conversation, then handing the rest to routeAutonomyTextToUser.
 */
import { MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core";
import type { AgentEventPayloadLike } from "../runtime/agent-event-service.ts";
import { routeAutonomyTextToUser } from "./server-helpers-swarm.ts";
import type { ServerState } from "./server-types.ts";

export function isLifeOpsCloudPluginRoute(pathname: string): boolean {
  return (
    pathname === "/api/cloud/features" ||
    pathname === "/api/cloud/features/sync" ||
    pathname.startsWith("/api/cloud/travel-providers/")
  );
}

export async function maybeRouteAutonomyEventToConversation(
  state: ServerState,
  event: AgentEventPayloadLike,
): Promise<void> {
  if (event.stream !== "assistant") return;

  const payload =
    event.data && typeof event.data === "object"
      ? (event.data as Record<string, unknown>)
      : null;
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text) return;

  const explicitSource =
    typeof payload?.source === "string" ? payload.source : null;
  const hasExplicitSource =
    explicitSource !== null && explicitSource.trim().length > 0;
  const source = hasExplicitSource ? explicitSource.trim() : "autonomy";

  if (source === MESSAGE_SOURCE_CLIENT_CHAT) return;
  if (!hasExplicitSource && !event.roomId) return;

  if (
    event.roomId &&
    Array.from(state.conversations.values()).some(
      (conversation) => conversation.roomId === event.roomId,
    )
  ) {
    return;
  }

  await routeAutonomyTextToUser(state, text, source);
}
