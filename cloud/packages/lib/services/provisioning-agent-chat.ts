/**
 * Provisioning placeholder agent chat service.
 *
 * Runs entirely on Cloudflare Workers via Cerebras (ultra-fast inference).
 * Converses with the user while their dedicated container is provisioning.
 * Conversation history is stored in Redis, keyed per user, capped at 20
 * messages (10 turns), TTL 7 days.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import {
  type AgentSandboxStatus,
  agentSandboxesRepository,
} from "@/db/repositories/agent-sandboxes";
import { cache } from "@/lib/cache/client";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { launchManagedElizaAgent } from "@/lib/services/eliza-managed-launch";
import { logger } from "@/lib/utils/logger";

const HISTORY_CACHE_KEY = (userId: string) => `prov-chat:${userId}`;
const HANDOFF_CACHE_KEY = (userId: string, agentId: string) => `prov-chat:handoff:${userId}:${agentId}`;
const HISTORY_TTL_SECONDS = 604800; // 7 days
const MAX_HISTORY_MESSAGES = 200;

const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
const CEREBRAS_MODEL = "gpt-oss-120b";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProvisioningChatResult {
  reply: string;
  containerStatus: AgentSandboxStatus | "none";
  bridgeUrl: string | null;
  agentId: string | null;
  history: ChatMessage[];
}

function buildSystemPrompt(status: AgentSandboxStatus | "none"): string {
  let statusBlock: string;

  if (status === "running") {
    statusBlock =
      "Current container status: running. The user's dedicated container is ready! You can let them know their agent is available and they'll be transferred automatically.";
  } else if (status === "provisioning" || status === "pending") {
    statusBlock = `Current container status: ${status}. The container is still being set up (typically 2–5 minutes total). Mention this warmly once if the topic comes up, but don't repeat it on every turn. Focus on being genuinely helpful.`;
  } else if (status === "error") {
    statusBlock =
      "Current container status: error. There was an issue provisioning the container. Be empathetic, let the user know the team is aware, and suggest they refresh or contact support if it persists.";
  } else {
    statusBlock = "Current container status: unknown. A container is being set up for the user.";
  }

  return `You are Eliza, a warm and knowledgeable AI assistant for the elizaOS platform. You're a serverless instance running on Cloudflare while the user's dedicated AI container is being provisioned.

${statusBlock}

You have comprehensive knowledge of elizaOS capabilities: agents, plugins, actions, providers, evaluators, connectors (Telegram, Discord, WhatsApp, iMessage), skills, the Eliza Cloud platform, billing, app creation, and more.

Be conversational, warm, and genuinely helpful. If the user asks what you can do while waiting, offer to:
- Explain elizaOS capabilities and what their agent will be able to do
- Help them think through which connectors to set up (Telegram, Discord, iMessage, etc.)
- Discuss their use cases and how elizaOS can help
- Answer questions about the platform, pricing, or features
- Just have a friendly conversation

Keep responses concise and natural. Don't repeat status information unless directly asked.`;
}

function getCerebrasClient(): ReturnType<typeof createOpenAI> {
  const env = getCloudAwareEnv();
  const apiKey = env.CEREBRAS_API_KEY;
  if (!apiKey) {
    throw new Error("CEREBRAS_API_KEY is not configured");
  }
  return createOpenAI({
    apiKey,
    baseURL: CEREBRAS_BASE_URL,
  });
}

async function loadHistory(userId: string): Promise<ChatMessage[]> {
  const cached = await cache.get<ChatMessage[]>(HISTORY_CACHE_KEY(userId));
  return cached ?? [];
}

async function saveHistory(userId: string, history: ChatMessage[]): Promise<void> {
  // Cap at MAX_HISTORY_MESSAGES, keeping the most recent
  const capped =
    history.length > MAX_HISTORY_MESSAGES
      ? history.slice(history.length - MAX_HISTORY_MESSAGES)
      : history;
  await cache.set(HISTORY_CACHE_KEY(userId), capped, HISTORY_TTL_SECONDS);
}

function historyToTranscript(history: ChatMessage[]): string {
  return [
    "Provisioning chat transcript copied from Eliza Cloud.",
    "",
    ...history.map((message) => {
      const speaker = message.role === "user" ? "User" : "Eliza provisioning";
      return `${speaker}: ${message.content}`;
    }),
  ].join("\n");
}

async function copyHistoryToManagedAgent(params: {
  userId: string;
  organizationId: string;
  agentId: string;
  history: ChatMessage[];
}): Promise<void> {
  const copiedKey = HANDOFF_CACHE_KEY(params.userId, params.agentId);
  if (await cache.get<{ copiedAt: string }>(copiedKey)) {
    return;
  }

  try {
    const launch = await launchManagedElizaAgent({
      agentId: params.agentId,
      organizationId: params.organizationId,
      userId: params.userId,
    });

    const response = await fetch(
      `${launch.connection.apiBase.replace(/\/+$/, "")}/api/memory/remember`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${launch.connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: historyToTranscript(params.history) }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`memory copy failed (${response.status}) ${body.slice(0, 200)}`);
    }

    await cache.set(copiedKey, { copiedAt: new Date().toISOString() }, HISTORY_TTL_SECONDS);
  } catch (error) {
    logger.warn("[ProvisioningAgentChat] Failed to copy history into managed agent", {
      userId: params.userId,
      agentId: params.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function provisioningAgentChat(
  userId: string,
  organizationId: string,
  userMessage: string,
  agentId?: string,
): Promise<ProvisioningChatResult> {
  // Resolve container status
  let containerStatus: AgentSandboxStatus | "none" = "none";
  let bridgeUrl: string | null = null;
  let resolvedAgentId: string | null = agentId ?? null;

  try {
    let sandbox = agentId
      ? await agentSandboxesRepository.findByIdAndOrg(agentId, organizationId)
      : undefined;

    if (!sandbox) {
      const sandboxes = await agentSandboxesRepository.listByOrganization(organizationId);
      sandbox = sandboxes[0];
    }

    if (sandbox) {
      containerStatus = sandbox.status;
      resolvedAgentId = sandbox.id;
      bridgeUrl = sandbox.status === "running" ? (sandbox.bridge_url ?? null) : null;
    }
  } catch (err) {
    logger.warn("[ProvisioningAgentChat] Failed to resolve sandbox status", {
      userId,
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Load history and append new user message
  const history = await loadHistory(userId);
  const updatedHistory: ChatMessage[] = [...history, { role: "user", content: userMessage }];

  // Generate response
  let reply = "";
  try {
    const cerebras = getCerebrasClient();
    const systemPrompt = buildSystemPrompt(containerStatus);

    const { text } = await generateText({
      model: cerebras.chat(CEREBRAS_MODEL),
      system: systemPrompt,
      messages: updatedHistory,
    });

    reply = text;
  } catch (err) {
    logger.error("[ProvisioningAgentChat] generateText failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    reply =
      "I'm having a brief moment of difficulty — please try again in a second. Your container is still being set up in the background.";
  }

  // Persist updated history with assistant reply
  const finalHistory: ChatMessage[] = [...updatedHistory, { role: "assistant", content: reply }];
  await saveHistory(userId, finalHistory);

  if (containerStatus === "running" && resolvedAgentId) {
    await copyHistoryToManagedAgent({
      userId,
      organizationId,
      agentId: resolvedAgentId,
      history: finalHistory,
    });
  }

  return {
    reply,
    containerStatus,
    bridgeUrl,
    agentId: resolvedAgentId,
    history: finalHistory,
  };
}
