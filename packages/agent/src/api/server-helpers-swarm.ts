/**
 * Swarm/autonomy/coding-agent helpers extracted from server.ts.
 */

import crypto from "node:crypto";
import type {
  SwarmEvent,
  TaskCompletionSummary,
  TaskContext,
} from "@elizaos/app-task-coordinator/api/coordinator-types";
import { routeTaskAgentTextToConnector } from "@elizaos/app-task-coordinator/api/task-agent-message-routing";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  logger,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { generateChatResponse as generateChatResponseFromChatRoutes } from "./chat-routes.js";
import type {
  CoordinationLLMResponse,
  PTYService,
} from "./parse-action-block.js";
import {
  parseActionBlock,
  stripActionBlockFromDisplay,
} from "./parse-action-block.js";
import { resolveAppUserName } from "./server-helpers.js";
import type { ConversationMeta, ServerState } from "./server-types.js";

// ---------------------------------------------------------------------------
// Autonomy -> User message routing
// ---------------------------------------------------------------------------

const CHAT_SUPPRESSED_AUTONOMY_SOURCES = new Set([
  "lifeops-reminder",
  "lifeops-workflow",
  "proactive-gm",
  "proactive-gn",
  "proactive-nudge",
]);

export async function routeAutonomyTextToUser(
  state: ServerState,
  responseText: string,
  source = "autonomy",
): Promise<void> {
  const runtime = state.runtime;
  if (!runtime) return;

  const normalizedText = responseText.trim();
  if (!normalizedText) return;

  // Find target conversation (active, or most recent)
  let conv: ConversationMeta | undefined;
  if (state.activeConversationId) {
    conv = state.conversations.get(state.activeConversationId);
  }
  if (!conv) {
    // Fall back to most recently updated conversation
    const sorted = Array.from(state.conversations.values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    conv = sorted[0];
  }
  if (!conv) return; // No conversations exist yet

  if (CHAT_SUPPRESSED_AUTONOMY_SOURCES.has(source)) {
    return;
  }

  // Ephemeral sources: broadcast to UI but don't persist to DB.
  const ephemeralSources = new Set(["coding-agent", "coordinator", "action"]);

  const messageId = crypto.randomUUID() as UUID;

  if (!ephemeralSources.has(source)) {
    const agentMessage = createMessageMemory({
      id: messageId,
      entityId: runtime.agentId,
      roomId: conv.roomId,
      content: {
        text: normalizedText,
        source,
      },
    });
    await runtime.createMemory(agentMessage, "messages");
  }
  conv.updatedAt = new Date().toISOString();

  // Broadcast to all WS clients (always, even for ephemeral sources)
  state.broadcastWs?.({
    type: "proactive-message",
    conversationId: conv.id,
    message: {
      id: messageId,
      role: "assistant",
      text: normalizedText,
      timestamp: Date.now(),
      source,
    },
  });
}

// ---------------------------------------------------------------------------
// Coding Agent Chat Bridge
// ---------------------------------------------------------------------------

/**
 * Get the SwarmCoordinator from the runtime services (if available).
 */
export function getCoordinatorFromRuntime(runtime: AgentRuntime): {
  setChatCallback?: (
    cb: (
      text: string,
      source?: string,
      routing?: {
        sessionId?: string;
        threadId?: string;
        roomId?: string | null;
      },
    ) => Promise<void>,
  ) => void;
  setWsBroadcast?: (cb: (event: SwarmEvent) => void) => void;
  setAgentDecisionCallback?: (
    cb: (
      eventDescription: string,
      sessionId: string,
      taskContext: TaskContext,
    ) => Promise<CoordinationLLMResponse | null>,
  ) => void;
  setSwarmCompleteCallback?: (
    cb: (payload: {
      tasks: TaskCompletionSummary[];
      total: number;
      completed: number;
      stopped: number;
      errored: number;
    }) => Promise<void>,
  ) => void;
  getTaskThread?: (
    threadId: string,
  ) => Promise<{ roomId?: string | null } | null>;
  sourceRoomId?: string | null;
} | null {
  const coordinator = runtime.getService("SWARM_COORDINATOR");
  if (coordinator) {
    return coordinator as ReturnType<typeof getCoordinatorFromRuntime>;
  }
  const ptyService = runtime.getService("PTY_SERVICE") as
    | (PTYService & { coordinator?: unknown })
    | null;
  if (ptyService?.coordinator) {
    return ptyService.coordinator as ReturnType<
      typeof getCoordinatorFromRuntime
    >;
  }
  return null;
}

export function wireCodingAgentBridgesNow(st: ServerState): void {
  wireCodingAgentChatBridge(st);
  wireCodingAgentWsBridge(st);
  wireCoordinatorEventRouting(st);
  wireCodingAgentSwarmSynthesis(st);
}

export function wireCodingAgentChatBridge(st: ServerState): boolean {
  if (!st.runtime) return false;
  const coordinator = getCoordinatorFromRuntime(st.runtime);
  if (!coordinator?.setChatCallback) return false;
  const hasPtyService = Boolean(st.runtime.getService("PTY_SERVICE"));
  if (hasPtyService) {
    coordinator.setChatCallback(async (text, source, routing) => {
      const delivered = await routeTaskAgentTextToConnector(
        st.runtime,
        text,
        source ?? "coding-agent",
        routing,
      );
      if (!delivered) {
        await routeAutonomyTextToUser(st, text, source ?? "coding-agent");
      }
    });
    return true;
  }

  coordinator.setChatCallback(async (text: string, source?: string) => {
    await routeAutonomyTextToUser(st, text, source ?? "coding-agent");
  });
  return true;
}

export function wireCodingAgentWsBridge(st: ServerState): boolean {
  if (!st.runtime) return false;
  const coordinator = getCoordinatorFromRuntime(st.runtime);
  if (!coordinator?.setWsBroadcast) return false;
  coordinator.setWsBroadcast((event: SwarmEvent) => {
    const { type: eventType, ...rest } = event;
    st.broadcastWs?.({ type: "pty-session-event", eventType, ...rest });
  });
  return true;
}

export function wireCodingAgentSwarmSynthesis(st: ServerState): boolean {
  if (!st.runtime) return false;
  const coordinator = getCoordinatorFromRuntime(st.runtime);
  if (!coordinator?.setSwarmCompleteCallback) return false;
  coordinator.setSwarmCompleteCallback(async () => {
    // Deliberately no-op -- synthesis happens via the streamer instead.
  });
  return true;
}

/**
 * Handle swarm completion by synthesizing a summary via the LLM.
 */
export async function handleSwarmSynthesis(
  st: { runtime: AgentRuntime | null },
  payload: {
    tasks: Array<{
      sessionId: string;
      label: string;
      agentType: string;
      originalTask: string;
      status: string;
      completionSummary: string;
    }>;
    total: number;
    completed: number;
    stopped: number;
    errored: number;
  },
  routeMessage: (text: string, source: string) => Promise<void> = (
    text,
    source,
  ) => routeAutonomyTextToUser(st as ServerState, text, source),
): Promise<void> {
  const runtime = st.runtime;
  if (!runtime) {
    logger.warn("[swarm-synthesis] No runtime available -- skipping synthesis");
    return;
  }

  logger.info(
    `[swarm-synthesis] Generating synthesis for ${payload.total} tasks (${payload.completed} completed, ${payload.stopped} stopped, ${payload.errored} errored)`,
  );

  const resultText = await buildSynthesisResultText(payload);
  logger.info("[swarm-synthesis] Synthesis generated, routing to user");
  await routeMessage(resultText, "swarm_synthesis");
  await routeSynthesisToConnector(runtime, resultText);
}

async function buildSynthesisResultText(payload: {
  tasks: Array<{
    originalTask: string;
    completionSummary: string;
    status: string;
  }>;
  total: number;
}): Promise<string> {
  const parts = await Promise.all(payload.tasks.map(buildTaskResultLine));
  return parts.length === 1
    ? `done -- ${parts[0]}`
    : `done -- ${payload.total} tasks:\n${parts.map((p) => `- ${p}`).join("\n")}`;
}

async function buildTaskResultLine(task: {
  originalTask: string;
  completionSummary: string;
}): Promise<string> {
  if (task.completionSummary) return task.completionSummary;
  const portMatch = task.originalTask.match(/port\s+(\d+)/i);
  const port = portMatch?.[1];
  if (!port) return task.originalTask;
  if (await isPortServing(port)) {
    const host = process.env.ELIZA_PUBLIC_HOST ?? "localhost";
    return `built and serving at http://${host}:${port}`;
  }
  return `built the files but server isn't running on port ${port} yet`;
}

async function isPortServing(port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function routeSynthesisToConnector(
  runtime: AgentRuntime,
  resultText: string,
): Promise<void> {
  const coordinator = getCoordinatorFromRuntime(runtime);
  const sourceRoomId = coordinator?.sourceRoomId;
  if (!sourceRoomId) return;
  try {
    const room = await runtime.getRoom(sourceRoomId as UUID);
    if (!room?.source) return;
    await runtime.sendMessageToTarget(
      {
        source: room.source,
        roomId: room.id,
        channelId: room.channelId ?? room.id,
        serverId: room.serverId,
      } as Parameters<typeof runtime.sendMessageToTarget>[0],
      { text: resultText, source: "swarm_synthesis" },
    );
    logger.info(
      `[swarm-synthesis] Routed result to ${room.source} room ${room.id}`,
    );
  } catch (err) {
    logger.debug(`[swarm-synthesis] Connector routing failed: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Coordinator Event Routing
// ---------------------------------------------------------------------------

export function wireCoordinatorEventRouting(st: ServerState): boolean {
  if (!st.runtime) return false;
  const coordinator = getCoordinatorFromRuntime(st.runtime);
  if (!coordinator?.setAgentDecisionCallback) return false;

  // Serialization queue -- one coordinator event at a time
  let eventQueue: Promise<void> = Promise.resolve();

  coordinator.setAgentDecisionCallback(
    async (
      eventDescription: string,
      _sessionId: string,
      _taskCtx: TaskContext,
    ): Promise<CoordinationLLMResponse | null> => {
      let resolveOuter!: (v: CoordinationLLMResponse | null) => void;
      const resultPromise = new Promise<CoordinationLLMResponse | null>((r) => {
        resolveOuter = r;
      });

      eventQueue = eventQueue.then(async () => {
        try {
          const runtime = st.runtime;
          if (!runtime) {
            resolveOuter(null);
            return;
          }

          // Ensure the legacy chat connection exists (creates room/world if needed).
          const agentName = runtime.character.name ?? "Eliza";
          const existingLegacyChatRoom = st.chatRoomId
            ? await runtime.getRoom(st.chatRoomId).catch(() => null)
            : null;
          if (!st.chatUserId || !st.chatRoomId || !existingLegacyChatRoom) {
            const adminId =
              st.adminEntityId ??
              (stringToUuid(`${st.agentName}-admin-entity`) as UUID);
            st.adminEntityId = adminId;
            st.chatUserId = adminId;
            st.chatRoomId =
              st.chatRoomId ??
              (stringToUuid(`${agentName}-web-chat-room`) as UUID);
            const worldId = stringToUuid(`${agentName}-web-chat-world`) as UUID;
            const messageServerId = stringToUuid(
              `${agentName}-web-server`,
            ) as UUID;
            await runtime.ensureConnection({
              entityId: adminId,
              roomId: st.chatRoomId,
              worldId,
              userName: resolveAppUserName(st.config),
              source: "client_chat",
              channelId: `${agentName}-web-chat`,
              type: ChannelType.DM,
              messageServerId,
              metadata: { ownership: { ownerId: adminId } },
            });
          }
          if (!st.chatUserId || !st.chatRoomId) {
            resolveOuter(null);
            return;
          }

          // Create a message memory so the event enters Eliza's conversation history.
          const message = createMessageMemory({
            id: crypto.randomUUID() as UUID,
            entityId: st.chatUserId,
            agentId: runtime.agentId,
            roomId: st.chatRoomId,
            content: {
              text: eventDescription,
              source: "coordinator",
              channelType: "DM",
            },
          });

          // Temporarily force TEXT_SMALL -- coordinator events are time-sensitive.
          const rt = runtime as unknown as Record<string, unknown>;
          const prevLlmMode = rt.llmModeOption;
          rt.llmModeOption = "SMALL";
          let result: { text: string; agentName?: string };
          try {
            result = await generateChatResponseFromChatRoutes(
              runtime,
              message,
              agentName,
              {
                resolveNoResponseText: () => "I'll look into that.",
              },
            );
          } finally {
            rt.llmModeOption = prevLlmMode;
          }

          // WS broadcast the natural language portion (strip JSON action block).
          if (result.text && result.text !== "(no response)") {
            const displayText = stripActionBlockFromDisplay(result.text);
            if (displayText && displayText.length > 2) {
              const conv = st.activeConversationId
                ? st.conversations.get(st.activeConversationId)
                : Array.from(st.conversations.values()).sort(
                    (a, b) =>
                      new Date(b.updatedAt).getTime() -
                      new Date(a.updatedAt).getTime(),
                  )[0];
              if (conv) {
                st.broadcastWs?.({
                  type: "proactive-message",
                  conversationId: conv.id,
                  message: {
                    id: `coordinator-${Date.now()}`,
                    role: "assistant",
                    text: displayText,
                    timestamp: Date.now(),
                    source: "coordinator",
                  },
                });
              }
            }
          }

          resolveOuter(parseActionBlock(result.text ?? ""));
        } catch (err) {
          logger.error(
            `Coordinator event routing failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          resolveOuter(null);
        }
      });

      return resultPromise;
    },
  );

  return true;
}

// ---------------------------------------------------------------------------
// PTY console bridge helper
// ---------------------------------------------------------------------------

export function getPtyConsoleBridge(st: ServerState) {
  if (!st.runtime) return null;
  const ptyService = st.runtime.getService("PTY_SERVICE") as PTYService | null;
  return ptyService?.consoleBridge ?? null;
}
