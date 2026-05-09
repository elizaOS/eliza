/**
 * Swarm/autonomy/coding-agent helpers extracted from server.ts.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  SwarmEvent,
  TaskCompletionSummary,
  TaskContext,
} from "@elizaos/app-task-coordinator";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  logger,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { generateChatResponse as generateChatResponseFromChatRoutes } from "./chat-routes.js";
import { resolveClientChatAdminEntityId } from "./client-chat-admin.js";
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
import { routeTaskAgentTextToConnector } from "./task-agent-message-routing.js";

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

  // Ephemeral sources: broadcast to UI but don't persist to DB. Connector
  // bridges, such as swarm synthesis, are persisted by the destination
  // connector when the actual platform message is observed.
  const ephemeralSources = new Set([
    "coding-agent",
    "coordinator",
    "action",
    "swarm_synthesis",
  ]);

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
  coordinator.setSwarmCompleteCallback(async (payload) => {
    await handleSwarmSynthesis(st, payload);
  });
  return true;
}

/**
 * Handle swarm completion by routing the captured task result to the user.
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
      validationSummary?: string;
      roomId?: string | null;
      workdir?: string;
      replyToExternalMessageId?: string | null;
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
  // coordinator.sourceRoomId is declared on the interface but never assigned
  // by the orchestrator, so without a fallback the connector route is dead.
  // Pick the most recently terminal task's roomId: that's the task whose
  // completion fired this swarm_complete, and whose room is waiting for an
  // answer. Naively taking "first task with a roomId" leaks results into
  // stale rooms when the coordinator carries tasks across rooms.
  const terminalStatuses = new Set(["completed", "stopped", "errored"]);
  let fallbackRoomId: string | null = null;
  let fallbackReplyToExternalMessageId: string | null = null;
  for (let i = payload.tasks.length - 1; i >= 0; i--) {
    const candidate = payload.tasks[i];
    const candidateReplyId =
      typeof candidate.replyToExternalMessageId === "string" &&
      candidate.replyToExternalMessageId.trim().length > 0
        ? candidate.replyToExternalMessageId.trim()
        : null;
    if (typeof candidate.roomId !== "string" || !candidate.roomId) continue;
    if (terminalStatuses.has(candidate.status)) {
      fallbackRoomId = candidate.roomId;
      fallbackReplyToExternalMessageId = candidateReplyId;
      break;
    }
    // Track last-seen room as a fallback if no terminal task carries one.
    if (!fallbackRoomId) {
      fallbackRoomId = candidate.roomId;
      fallbackReplyToExternalMessageId = candidateReplyId;
    }
  }
  await routeSynthesisToConnector(
    runtime,
    resultText,
    fallbackRoomId,
    fallbackReplyToExternalMessageId,
  );
}

async function buildSynthesisResultText(payload: {
  tasks: Array<{
    originalTask: string;
    completionSummary: string;
    validationSummary?: string;
    status: string;
    agentType: string;
    workdir?: string;
  }>;
  total: number;
}): Promise<string> {
  const parts = await Promise.all(payload.tasks.map(buildTaskResultLine));
  return parts.length === 1
    ? parts[0]
    : `${payload.total} tasks:\n${parts.map((p) => `- ${p}`).join("\n")}`;
}

async function buildTaskResultLine(task: {
  originalTask: string;
  completionSummary: string;
  validationSummary?: string;
  agentType: string;
  workdir?: string;
}): Promise<string> {
  const validationSummary = task.validationSummary?.trim();
  // Claude Code persists final assistant messages in per-workdir jsonl. That
  // path is Claude-specific; for Codex and other agents the coordinator's
  // completionSummary is already the captured user-facing output.
  if (task.agentType === "claude" && task.workdir) {
    const finalText = await readAgentFinalAssistantMessage(task.workdir);
    if (finalText) {
      return validationSummary
        ? preserveEvidenceUrls(validationSummary, finalText)
        : finalText;
    }
  }
  if (validationSummary) {
    return preserveEvidenceUrls(validationSummary, task.completionSummary);
  }
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

function collectHttpUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/giu)) {
    const candidate = match[0].replace(/[),.;:!?]+$/u, "");
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue;
      }
    } catch {
      continue;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      urls.push(candidate);
    }
  }
  return urls;
}

function preserveEvidenceUrls(summary: string, evidence: string): string {
  const missingUrls = collectHttpUrls(evidence).filter(
    (url) => !summary.includes(url),
  );
  if (missingUrls.length === 0) return summary;
  return [summary, ...missingUrls].join("\n");
}

async function readAgentFinalAssistantMessage(
  workdir: string,
): Promise<string | null> {
  try {
    // claude-code persists each session under a project directory whose name
    // is the workdir with both "/" and "." replaced by "-" (so a hidden
    // path like /home/u/.eliza/workspaces/<id> becomes
    // -home-u--eliza-workspaces-<id>).
    const sanitized = workdir.replace(/[/.]/g, "-");
    const projectDir = path.join(
      os.homedir(),
      ".claude",
      "projects",
      sanitized,
    );
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    const jsonls = entries.filter(
      (e) => e.isFile() && e.name.endsWith(".jsonl"),
    );
    if (jsonls.length === 0) return null;
    const stats = await Promise.all(
      jsonls.map(async (e) => ({
        name: e.name,
        mtime: (await fs.stat(path.join(projectDir, e.name))).mtimeMs,
      })),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    const newest = path.join(projectDir, stats[0].name);
    const raw = await fs.readFile(newest, "utf8");
    let lastText = "";
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj.type !== "assistant") continue;
        const message = obj.message as Record<string, unknown> | undefined;
        if (!message || message.role !== "assistant") continue;
        const content = message.content;
        if (typeof content === "string") {
          lastText = content;
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (
              part &&
              typeof part === "object" &&
              (part as Record<string, unknown>).type === "text" &&
              typeof (part as Record<string, unknown>).text === "string"
            ) {
              lastText = (part as Record<string, string>).text;
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }
    const collapsed = lastText.trim();
    return collapsed.length > 0 ? collapsed : null;
  } catch {
    return null;
  }
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
  fallbackRoomId: string | null = null,
  replyToExternalMessageId: string | null = null,
): Promise<void> {
  const coordinator = getCoordinatorFromRuntime(runtime);
  const sourceRoomId = coordinator?.sourceRoomId ?? fallbackRoomId;
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
      {
        text: resultText,
        source: "swarm_synthesis",
        ...(replyToExternalMessageId
          ? { inReplyTo: replyToExternalMessageId }
          : {}),
      },
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
            const adminId = resolveClientChatAdminEntityId(st);
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
          const rt = runtime as AgentRuntime & Record<string, unknown>;
          const prevLlmMode = rt["llmModeOption"];
          rt["llmModeOption"] = "SMALL";
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
            rt["llmModeOption"] = prevLlmMode;
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
