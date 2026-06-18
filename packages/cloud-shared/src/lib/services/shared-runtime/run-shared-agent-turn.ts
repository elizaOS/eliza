/**
 * Shared runtime — runs a single agent turn container-free.
 *
 * This is the generalization of `eliza-app/onboarding-chat.ts` (which already
 * runs the onboarding persona via hosted Cerebras inference with no sandbox)
 * into a reusable primitive that runs ANY simple agent's character. It is the
 * execution engine for Tier 0 ("shared") agents — the default for plain
 * chat / webhook / cron agents that don't need a dedicated container.
 *
 * Model routing: the turn goes through the SAME canonical `getLanguageModel`
 * router as every other inference path in cloud — bare Cerebras ids
 * (`gpt-oss-120b`, `zai-glm-4.7`) go straight to Cerebras, every other id goes
 * through BitRouter. There is deliberately NO bespoke provider client here, so a
 * shared agent supports exactly the models the platform does and can never
 * diverge from the proven `/api/v1/chat/completions` path.
 *
 * Caller responsibilities (kept out of here so this stays pure + testable):
 *  - load the agent's character + prior history (from DB/cache)
 *  - persist the returned history (memory) after the turn
 *  - route only shared-eligible agents here (see `agent-tier.ts`)
 */

import { generateText } from "ai";
import { CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "../../models/catalog";
import {
  getLanguageModel,
  hasLanguageModelProviderConfigured,
} from "../../providers/language-model";
import { logger } from "../../utils/logger";

export interface SharedTurnMessage {
  role: "user" | "assistant";
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
  usage?: SharedAgentTurnUsage;
}

/**
 * The shared default when an agent configures no model: the bare Cerebras small
 * id, which `getLanguageModel` sends straight to Cerebras (fast + cheap, no
 * gateway hop). Big-model agents simply set `zai-glm-4.7` (also bare Cerebras).
 */
const DEFAULT_SHARED_MODEL = CEREBRAS_DEFAULT_TEXT_SMALL_MODEL;

/** Token counts the shared-runtime billing path consumes (input/output/total). */
export interface SharedAgentTurnUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Resolve the model id used BOTH to run the shared turn (via `getLanguageModel`)
 * and to bill it (eliza-sandbox `billingModel`). The agent's own model is
 * honored when a provider is configured for it; otherwise we fall back to the
 * always-available shared default. Returns null only when no provider can serve
 * even the default, so the caller degrades cleanly without billing.
 */
export function resolveSharedAgentTurnModel(preferred?: string): string | null {
  const configured = preferred?.trim();
  if (configured && hasLanguageModelProviderConfigured(configured)) {
    return configured;
  }
  return hasLanguageModelProviderConfigured(DEFAULT_SHARED_MODEL) ? DEFAULT_SHARED_MODEL : null;
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
  const modelId = resolveSharedAgentTurnModel(input.character.model);

  if (!modelId) {
    const reply = `${input.character.name} is temporarily unavailable (no shared model configured).`;
    return {
      reply,
      history: appendTurn(input.history, message, reply),
      model: "none",
      degraded: true,
    };
  }

  try {
    const { text, usage } = await generateText({
      model: getLanguageModel(modelId),
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
      model: modelId,
      degraded: false,
      usage,
    };
  } catch (error) {
    logger.error("[shared-runtime] turn failed; degrading", {
      agent: input.character.name,
      model: modelId,
      errorName: error instanceof Error ? error.name : "unknown",
      error: error instanceof Error ? error.message : String(error),
    });
    const reply = `${input.character.name} hit a temporary error. Please try again.`;
    return {
      reply,
      history: appendTurn(input.history, message, reply),
      model: modelId,
      degraded: true,
    };
  }
}
