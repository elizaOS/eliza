/**
 * Registers a send handler for the "client_chat" source so the agent can
 * proactively push messages to connected Eliza app clients.
 *
 * The handler persists the message to the DB and broadcasts it over
 * WebSocket so the UI updates in real time. If no WS clients are
 * connected, the message is still persisted and will appear when the
 * app reconnects.
 */

import crypto from "node:crypto";
import {
  type Content,
  createMessageMemory,
  type IAgentRuntime,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import {
  beginDelivery,
  deliveryIdentityFromContent,
} from "../api/delivery-dedupe.ts";
import type { ConversationMeta, ServerState } from "../api/server-types.ts";

/**
 * Dashboard/REST chat sources that flow through `generateChatResponse` and can
 * originate a coding sub-agent spawn. When the orchestrator relays the spawned
 * agent's result back to the user it calls `runtime.sendMessageToTarget` with
 * `target.source` set to the ORIGINATING message's `content.source` (see
 * `SubAgentRouter.buildReplyCallback` → `origin.source`, stamped onto the
 * session metadata by `TASKS op=spawn_agent` as `resolvedSpawnSource`). None of
 * these sources is owned by a real connector, so without an explicit send
 * handler the relay throws "No send handler registered for source: …" and the
 * sub-agent's result silently never reaches the user — the chat just shows a
 * "something glitched" failure even though the work completed.
 *
 *   - `client_chat`        — primary web/app dashboard chat (buildUserMessages
 *                            default; also the proactive-autonomy surface).
 *   - `agent_message_api`  — REST `POST /agents/:id/message`
 *                            (chat-routes.ts; `platformName || agent_message_api`).
 *   - `compat_openai`      — `/v1/chat/completions` OpenAI-compat endpoint.
 *   - `compat_anthropic`   — `/v1/messages` Anthropic-compat endpoint.
 *
 * NOT included (they are not real inbound `origin.source` values that reach the
 * relay): `sub_agent` (the router's internal marker — unwrapped to the real
 * `originSource` in tasks.ts before it ever becomes a spawn source), and
 * `orchestrator` (only a notifier/trajectory label, never a `content.source`).
 *
 * Arbitrary/unknown dashboard-origin sources (a client-supplied `body.source`
 * on the dashboard chat, or a custom `platformName` on `agent_message_api`)
 * are handled by the default-fallback wrapper below — see
 * {@link installDashboardFallbackSend}.
 */
const RELAY_SOURCES = [
  MESSAGE_SOURCE_CLIENT_CHAT,
  "agent_message_api",
  "compat_openai",
  "compat_anthropic",
] as const;

/**
 * Sources for which delivery may fall back to the active / most-recently-updated
 * dashboard conversation when no conversation matches the target room. Only the
 * live dashboard UI (`client_chat`, which sets `activeConversationId` over WS and
 * drives proactive autonomy) qualifies. Programmatic API sources
 * (`agent_message_api`, `compat_*`) and arbitrary unknown sources must NOT use
 * this ambient fallback — an async sub-agent result for an API caller would
 * otherwise land in an unrelated recent conversation. See {@link resolveConversation}.
 */
const AMBIENT_FALLBACK_SOURCES = new Set<string>([MESSAGE_SOURCE_CLIENT_CHAT]);

/**
 * Resolve the best conversation for a given roomId by scanning the
 * server-side conversation map. Returns undefined when no match exists.
 */
function findConversationByRoomId(
  state: ServerState,
  roomId: UUID,
): ConversationMeta | undefined {
  for (const conv of state.conversations.values()) {
    if (conv.roomId === roomId) return conv;
  }
  return undefined;
}

/**
 * Resolve the target conversation.
 *
 * The originating room id is always preferred: an explicit `roomId` that maps to
 * a registered conversation is used as-is, so an async sub-agent result is
 * delivered into the exact conversation it was spawned from.
 *
 * Only when `allowAmbientFallback` is set (genuine dashboard-UI sessions —
 * `client_chat`) does delivery fall back to the active conversation and then the
 * most-recently-updated conversation, matching the proactive-autonomy routing in
 * {@link routeAutonomyTextToUser}. For programmatic API / unknown sources the
 * ambient fallback is intentionally disabled to prevent cross-conversation
 * mis-delivery.
 */
function resolveConversation(
  state: ServerState,
  roomId: UUID | undefined,
  allowAmbientFallback: boolean,
): ConversationMeta | undefined {
  // 1. Explicit room — always preferred when it maps to a known conversation.
  if (roomId) {
    const conv = findConversationByRoomId(state, roomId);
    if (conv) return conv;
  }

  // Programmatic API / unknown sources: never fall through to an unrelated
  // active / recent conversation. The originating room is the only correct
  // delivery target; absent a match the caller records an honest delivery
  // failure instead of mis-delivering into a stranger's chat.
  if (!allowAmbientFallback) return undefined;

  // 2. Active conversation (set by the UI via WS "active-conversation" msg)
  if (state.activeConversationId) {
    const conv = state.conversations.get(state.activeConversationId);
    if (conv) return conv;
  }

  // 3. Most recently updated conversation
  const sorted = Array.from(state.conversations.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return sorted[0];
}

/**
 * Build the delivery handler for a given inbound `source`. Persists the agent's
 * message into the resolved conversation's room and broadcasts it to connected
 * dashboard clients.
 */
function makeDeliver(runtime: IAgentRuntime, state: ServerState) {
  return (source: string) =>
    async (
      _rt: IAgentRuntime,
      target: TargetInfo,
      content: Content,
    ): Promise<undefined> => {
      const conv = resolveConversation(
        state,
        target.roomId as UUID | undefined,
        AMBIENT_FALLBACK_SOURCES.has(source),
      );
      if (!conv) {
        // No conversation exists to deliver into. Throw so the caller records a
        // delivery failure (e.g. escalation falls through to the next channel)
        // instead of treating a silently dropped message as a successful send.
        throw new Error(
          `${source} send failed: no conversation available to deliver message`,
        );
      }

      // Cross-path delivery dedupe (Bug A): a single reply can also arrive via
      // the autonomy/coordinator relay (routeAutonomyTextToUser), which writes
      // its own memory + WS broadcast. If this exact (roomId + text) was just
      // delivered, suppress this duplicate instead of double-persisting +
      // double-broadcasting. Treat the suppressed delivery as a successful
      // no-op (do NOT throw) — the message already reached the user. The
      // reservation is only committed AFTER a successful createMemory +
      // broadcast, and released on failure, so a failed delivery never
      // suppresses a legitimate fallback/retry of the same reply.
      const delivery = beginDelivery(
        state.deliveryDedupe,
        conv.roomId,
        content.text,
        // Include attachment/action identity so two distinct sends that share
        // the same caption/status text but carry different payloads are NOT
        // collapsed (codex review P2).
        { identity: deliveryIdentityFromContent(content) },
      );
      if (delivery.kind === "duplicate") {
        return;
      }

      const messageId = crypto.randomUUID() as UUID;

      const agentMessage = createMessageMemory({
        id: messageId,
        entityId: runtime.agentId,
        roomId: conv.roomId,
        content: {
          ...content,
          text: content.text ?? "",
          source: MESSAGE_SOURCE_CLIENT_CHAT,
        },
      });
      try {
        await runtime.createMemory(agentMessage, "messages");
      } catch (err) {
        delivery.reservation.release();
        throw err;
      }

      conv.updatedAt = new Date().toISOString();

      state.broadcastWs?.({
        type: "proactive-message",
        conversationId: conv.id,
        message: {
          id: messageId,
          role: "assistant",
          text: content.text ?? "",
          timestamp: Date.now(),
          source: MESSAGE_SOURCE_CLIENT_CHAT,
        },
      });
      delivery.reservation.commit();
      return undefined;
    };
}

type RuntimeWithFallbackMarker = IAgentRuntime & {
  __dashboardFallbackSendWrapped?: boolean;
};

/**
 * Install a default-fallback over `runtime.sendMessageToTarget` so a sub-agent
 * relay for an UNKNOWN / unregistered dashboard-origin source is delivered into
 * the dashboard surface instead of throwing "No send handler registered" and
 * being silently dropped.
 *
 * Registered connector handlers (discord/telegram/…) and the explicit
 * {@link RELAY_SOURCES} above always win: if a send handler is registered for
 * the target source (reflected by `getMessageConnectors()`, which
 * `registerSendHandler` populates), the original send path runs unchanged. Only
 * an otherwise-unhandled source falls through to the dashboard deliver — so we
 * never hijack a real connector's delivery, yet an arbitrary dashboard-supplied
 * source (a custom `body.source`, or `agent_message_api`'s `platformName`) is
 * never dropped.
 */
function installDashboardFallbackSend(
  runtime: IAgentRuntime,
  deliver: (
    source: string,
  ) => (
    rt: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ) => Promise<undefined>,
): void {
  if (typeof runtime.sendMessageToTarget !== "function") return;
  const tagged = runtime as RuntimeWithFallbackMarker;
  if (tagged.__dashboardFallbackSendWrapped) return;

  const originalSend = runtime.sendMessageToTarget.bind(runtime);
  const hasRegisteredHandler = (source: string): boolean => {
    if (typeof runtime.getMessageConnectors !== "function") return false;
    try {
      return runtime
        .getMessageConnectors()
        .some((connector) => connector.source === source);
    } catch {
      return false;
    }
  };

  runtime.sendMessageToTarget = async (target, content) => {
    const source =
      typeof target.source === "string" ? target.source.trim() : "";
    // A registered connector / explicit relay source owns its own delivery.
    if (!source || hasRegisteredHandler(source)) {
      return originalSend(target, content);
    }
    // Unknown / unregistered dashboard-origin source: deliver into the
    // dashboard surface so the relayed sub-agent result is never silently
    // dropped. resolveConversation still keys off the origin room id (no
    // ambient fallback for these), so it cannot mis-deliver.
    return deliver(source)(runtime, target, content);
  };
  tagged.__dashboardFallbackSendWrapped = true;
}

/**
 * Register the `client_chat` send handler on the given runtime.
 *
 * Must be called after the WebSocket server is set up (so that
 * `state.broadcastWs` is available).
 */
export function registerClientChatSendHandler(
  runtime: IAgentRuntime,
  state: ServerState,
): void {
  if (typeof runtime.registerSendHandler !== "function") {
    return;
  }
  const deliver = makeDeliver(runtime, state);

  // Explicit handlers for the dashboard/REST sources that go through
  // generateChatResponse and can originate a sub-agent spawn (see RELAY_SOURCES).
  for (const source of RELAY_SOURCES) {
    runtime.registerSendHandler(source, deliver(source));
  }

  // Safety net for arbitrary/unknown dashboard-origin sources.
  installDashboardFallbackSend(runtime, deliver);
}
