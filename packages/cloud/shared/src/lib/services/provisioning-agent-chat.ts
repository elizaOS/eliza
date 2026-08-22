/**
 * Provisioning agent chat service.
 *
 * Runs entirely on Cloudflare Workers via Cerebras (ultra-fast inference).
 * Converses with the user while observing an existing Dedicated container.
 * Conversation history is stored in Redis, keyed per user, capped at 20
 * messages (10 turns), TTL 7 days.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import {
  type AgentSandboxStatus,
  agentSandboxesRepository,
} from "../../db/repositories/agent-sandboxes";
import type { AgentSandbox } from "../../db/schemas/agent-sandboxes";
import { cache } from "../cache/client";
import { CEREBRAS_DEFAULT_TEXT_MODEL } from "../models";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { selectElizaAppProvisioningTarget } from "./eliza-app/provisioning";

const HISTORY_CACHE_KEY = (userId: string) => `prov-chat:${userId}`;
const HISTORY_TTL_SECONDS = 604800; // 7 days
const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
const CEREBRAS_MODEL = CEREBRAS_DEFAULT_TEXT_MODEL;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProvisioningChatResult {
  reply: string;
  containerStatus: ProvisioningChatContainerStatus;
  bridgeUrl: string | null;
  agentId: string | null;
  history: ChatMessage[];
}

export type ProvisioningChatContainerStatus = AgentSandboxStatus | "none" | "unknown";

export type ProvisioningAgentChatSandboxReader = Pick<
  typeof agentSandboxesRepository,
  "findByIdAndOrg" | "listByOrganization"
>;

export const PROVISIONING_CHAT_INFERENCE_FAILURE_REPLY =
  "I'm having a brief moment of difficulty — please try again in a second. I couldn't confirm your Dedicated container state right now.";

export function buildProvisioningChatSystemPrompt(status: ProvisioningChatContainerStatus): string {
  let statusBlock: string;

  switch (status) {
    case "running":
      statusBlock =
        "Current Dedicated container database status: running. This status observation alone does not prove live readiness or a successful transfer. Say only that the lifecycle record is running; do not promise that the agent will answer until the normal app path confirms it.";
      break;
    case "pending":
      statusBlock =
        "Current Dedicated container database status: pending. A pending row does not prove that provisioning was requested or that a job is running. Do not claim setup is underway or provide an ETA; direct the user to the explicit lifecycle controls.";
      break;
    case "provisioning":
      statusBlock =
        "Current Dedicated container database status: provisioning. The lifecycle record says provisioning, but this observation does not prove current readiness or an ETA. Report the recorded state without promising completion.";
      break;
    case "error":
      statusBlock =
        "Current Dedicated container database status: error. This observation does not identify which lifecycle operation failed or why. Say only that the agent needs attention and suggest the normal lifecycle controls or support; do not claim that provisioning specifically failed.";
      break;
    case "disconnected":
      statusBlock =
        "Current Dedicated container status: disconnected. The existing agent is unreachable, not being provisioned. Say that clearly and suggest retrying or contacting support; do not claim setup is progressing.";
      break;
    case "stopped":
      statusBlock =
        "Current Dedicated container status: stopped. The existing agent is stopped, not being provisioned. Suggest using the normal lifecycle controls to resume it; do not claim setup is progressing.";
      break;
    case "sleeping":
      statusBlock =
        "Current Dedicated container status: sleeping. The existing agent is asleep, not being provisioned. Suggest using the normal lifecycle controls to wake it; do not claim setup is progressing.";
      break;
    case "deletion_pending":
      statusBlock =
        "Current Dedicated container status: deletion_pending. The existing agent is being removed, not provisioned. Do not claim setup is progressing.";
      break;
    case "deletion_failed":
      statusBlock =
        "Current Dedicated container status: deletion_failed. Removal of the existing agent failed. Suggest contacting support; do not claim setup is progressing.";
      break;
    case "none":
      statusBlock =
        "No eligible Dedicated container is currently associated with this user. This status assistant does not create one. Do not claim that setup or provisioning is in progress.";
      break;
    case "unknown":
      statusBlock =
        "The Dedicated container status lookup is currently unavailable. Do not claim that a container exists or that setup is in progress; ask the user to retry shortly.";
      break;
    default:
      // Same reason as fallbackReply's catch-all: an unrecognised status must
      // not leave this unassigned and put the literal "undefined" into the
      // model's system prompt.
      statusBlock =
        "The Dedicated container status could not be recognised. Do not claim that a container exists or that setup is in progress; ask the user to retry shortly.";
      break;
  }

  return `You are Eliza, a warm and knowledgeable AI assistant for the elizaOS platform. You're the serverless Eliza App onboarding and status assistant. You can explain an existing Dedicated agent's state, but you never create, restart, resume, or provision compute.

${statusBlock}

You have comprehensive knowledge of elizaOS capabilities: agents, plugins, actions, providers, evaluators, connectors (Telegram, Discord, WhatsApp, iMessage), skills, the Eliza Cloud platform, billing, app creation, and more.

Be conversational, warm, and genuinely helpful. If the user asks what you can help with, offer to:
- Explain elizaOS capabilities and what their agent will be able to do
- Help them think through which connectors to set up (Telegram, Discord, iMessage, etc.)
- Discuss their use cases and how elizaOS can help
- Answer questions about the platform, pricing, or features
- Just have a friendly conversation

Keep responses concise and natural. Don't repeat status information unless directly asked.`;
}

/** Build the model payload whose status copy is pinned by unit tests. */
export function buildProvisioningChatGenerationInput(
  status: ProvisioningChatContainerStatus,
  messages: ChatMessage[],
): { system: string; messages: ChatMessage[] } {
  return {
    system: buildProvisioningChatSystemPrompt(status),
    messages,
  };
}

/** Resolve one user-owned Dedicated target without mutating its lifecycle. */
export async function resolveProvisioningAgentChatTarget(
  userId: string,
  organizationId: string,
  agentId?: string,
  repository: ProvisioningAgentChatSandboxReader = agentSandboxesRepository,
): Promise<AgentSandbox | undefined> {
  // The canonical target is whatever the selector picks over the org's rows —
  // the same authority the status endpoint reports. A client-supplied id is a
  // hint, never the answer: running the selector over `[thatRow]` alone only
  // re-checks ownership, so a client holding a superseded id (the hook keeps
  // the first id it ever saw) would pin chat to an older agent while status
  // correctly moved on, and the transcript handoff would follow the wrong one.
  const canonical = selectElizaAppProvisioningTarget(
    await repository.listByOrganization(organizationId),
    userId,
  );
  if (!agentId || !canonical || agentId === canonical.id) return canonical;

  // A superseded or foreign id. Not worth a second round-trip per message to
  // classify it: the canonical target is authoritative either way.
  logger.info("[provisioning-agent-chat] ignoring non-canonical client agent id", {
    requestedAgentId: agentId,
    canonicalAgentId: canonical.id,
  });
  return canonical;
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
  await cache.set(HISTORY_CACHE_KEY(userId), history, HISTORY_TTL_SECONDS);
}

export async function provisioningAgentChat(
  userId: string,
  organizationId: string,
  userMessage: string,
  agentId?: string,
): Promise<ProvisioningChatResult> {
  // Resolve container status
  let containerStatus: ProvisioningChatContainerStatus = "none";
  let bridgeUrl: string | null = null;
  let resolvedAgentId: string | null = null;

  try {
    const sandbox = await resolveProvisioningAgentChatTarget(userId, organizationId, agentId);

    if (sandbox) {
      containerStatus = sandbox.status;
      resolvedAgentId = sandbox.id;
      bridgeUrl = sandbox.status === "running" ? (sandbox.bridge_url ?? null) : null;
    }
  } catch (err) {
    // error-policy:J4 chat remains available with an explicit unknown status if observation fails.
    containerStatus = "unknown";
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
    const generationInput = buildProvisioningChatGenerationInput(containerStatus, updatedHistory);

    const { text } = await generateText({
      model: cerebras.chat(CEREBRAS_MODEL),
      ...generationInput,
    });

    reply = text;
  } catch (err) {
    // error-policy:J4 the chat returns a visible retry response when inference is unavailable.
    logger.error("[ProvisioningAgentChat] generateText failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    reply = PROVISIONING_CHAT_INFERENCE_FAILURE_REPLY;
  }

  // Persist updated history with assistant reply
  const finalHistory: ChatMessage[] = [...updatedHistory, { role: "assistant", content: reply }];
  await saveHistory(userId, finalHistory);

  return {
    reply,
    containerStatus,
    bridgeUrl,
    agentId: resolvedAgentId,
    history: finalHistory,
  };
}
