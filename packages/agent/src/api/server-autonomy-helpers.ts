import type { AgentEventPayloadLike } from "../runtime/agent-event-service.js";
import { routeAutonomyTextToUser } from "./server-helpers-swarm.js";
import type { ServerState } from "./server-types.js";

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

  if (source === "client_chat") return;
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
