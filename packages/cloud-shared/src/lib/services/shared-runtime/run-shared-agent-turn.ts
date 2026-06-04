/**
 * Shared runtime — runs a single agent turn container-free.
 *
 * This is the generalization of `eliza-app/onboarding-chat.ts` (which already
 * runs the onboarding persona via hosted Cerebras inference with no sandbox)
 * into a reusable primitive that runs ANY simple agent's character. It is the
 * execution engine for Tier 0 ("shared") agents — the default for plain
 * chat / webhook / cron agents that don't need a dedicated container.
 *
 * Caller responsibilities (kept out of here so this stays pure + testable):
 *  - load the agent's character + prior history (from DB/cache)
 *  - persist the returned history (memory) after the turn
 *  - route only shared-eligible agents here (see `agent-tier.ts`)
 */

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { getCloudAwareEnv } from "../../runtime/cloud-bindings";
import { logger } from "../../utils/logger";

export type SharedTurnRole = "user" | "assistant";

export interface SharedTurnMessage {
  role: SharedTurnRole;
  content: string;
}

export interface SharedAgentCharacter {
  /** Display/agent name. */
  name: string;
  /** The agent's system prompt / persona. */
  system: string;
  /** Optional bio/lore bullets folded into the system prompt. */
  bio?: string[];
  /** Optional model id override; otherwise the shared default is used. */
  model?: string;
}

export interface RunSharedAgentTurnInput {
  character: SharedAgentCharacter;
  /** Prior conversation (oldest first). The new user message is NOT included. */
  history: SharedTurnMessage[];
  /** The incoming user message or event text. */
  message: string;
}

export interface RunSharedAgentTurnResult {
  reply: string;
  /** history + the new user message + the assistant reply (persist this). */
  history: SharedTurnMessage[];
  model: string;
  /** True when no shared model was configured or generation failed. */
  degraded: boolean;
}

const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
const CEREBRAS_MODEL = "gpt-oss-120b";
const OPENAI_FALLBACK_MODEL = "gpt-4o-mini";

interface ResolvedModel {
  client: ReturnType<typeof createOpenAI>;
  model: string;
}

/**
 * Resolve the hosted model for shared execution. Prefers Cerebras (the same
 * ultra-fast path onboarding uses); falls back to an OpenAI-compatible default.
 */
function resolveSharedModel(preferred?: string): ResolvedModel | null {
  const env = getCloudAwareEnv();
  if (env.CEREBRAS_API_KEY) {
    return {
      client: createOpenAI({ apiKey: env.CEREBRAS_API_KEY, baseURL: CEREBRAS_BASE_URL }),
      model: preferred ?? CEREBRAS_MODEL,
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      client: createOpenAI({ apiKey: env.OPENAI_API_KEY }),
      model: preferred ?? OPENAI_FALLBACK_MODEL,
    };
  }
  return null;
}

function buildSystemPrompt(character: SharedAgentCharacter): string {
  const parts: string[] = [];
  const system = character.system?.trim();
  if (system) parts.push(system);
  if (character.bio?.length) {
    parts.push(
      `About you:\n- ${character.bio
        .map((b) => b.trim())
        .filter(Boolean)
        .join("\n- ")}`,
    );
  }
  return parts.join("\n\n") || `You are ${character.name}, a helpful assistant.`;
}

function appendTurn(
  history: SharedTurnMessage[],
  userMessage: string,
  reply: string,
): SharedTurnMessage[] {
  return [
    ...history,
    { role: "user", content: userMessage },
    { role: "assistant", content: reply },
  ];
}

/** Run one shared (container-free) turn for a simple agent. Never throws. */
export async function runSharedAgentTurn(
  input: RunSharedAgentTurnInput,
): Promise<RunSharedAgentTurnResult> {
  const message = input.message.trim();
  const resolved = resolveSharedModel(input.character.model);

  if (!resolved) {
    const reply = `${input.character.name} is temporarily unavailable (no shared model configured).`;
    return {
      reply,
      history: appendTurn(input.history, message, reply),
      model: "none",
      degraded: true,
    };
  }

  try {
    const { text } = await generateText({
      model: resolved.client.chat(resolved.model),
      system: buildSystemPrompt(input.character),
      messages: [
        ...input.history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: message },
      ],
    });
    const reply = text.trim() || "…";
    return {
      reply,
      history: appendTurn(input.history, message, reply),
      model: resolved.model,
      degraded: false,
    };
  } catch (error) {
    logger.warn("[shared-runtime] turn failed; degrading", {
      agent: input.character.name,
      model: resolved.model,
      error: error instanceof Error ? error.message : String(error),
    });
    const reply = `${input.character.name} hit a temporary error. Please try again.`;
    return {
      reply,
      history: appendTurn(input.history, message, reply),
      model: resolved.model,
      degraded: true,
    };
  }
}
