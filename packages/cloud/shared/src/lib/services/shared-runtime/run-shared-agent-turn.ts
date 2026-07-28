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
 * (`gemma-4-31b`, `gpt-oss-120b`, `zai-glm-4.7`) go straight to Cerebras, every other id goes
 * through BitRouter. There is deliberately NO bespoke provider client here, so a
 * shared agent supports exactly the models the platform does and can never
 * diverge from the proven `/api/v1/chat/completions` path.
 *
 * Caller responsibilities (kept out of here so this stays pure + testable):
 *  - load the agent's character + prior history (from DB/cache)
 *  - persist the returned history (memory) after the turn
 *  - route only shared-eligible agents here (see `agent-tier.ts`)
 */

import { generateText, streamText } from "ai";
import { CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "../../models/catalog";
import {
  getInteractiveCerebrasLanguageModel,
  hasLanguageModelProviderConfigured,
} from "../../providers/language-model";
import { resolveSharedNavIntent, type SharedNavIntent } from "./shared-nav-intent";

export interface SharedTurnMessage {
  role: "user" | "assistant";
  content: string;
  /** Epoch-ms timestamp used by REST chat clients to reconcile persisted turns. */
  createdAt?: number;
  /**
   * True when this assistant turn was cut short (voice barge-in, client
   * disconnect, upstream stream drop) and `content` is therefore a prefix of
   * what the model was generating. Persisting the fragment keeps the user's
   * utterance in memory; this flag stops a later turn from treating the
   * fragment as a complete thing the agent finished saying.
   */
  interrupted?: boolean;
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
  /** Durable accounting transition invoked at the final provider handoff. */
  onProviderDispatch?: () => Promise<void>;
}

export interface RunSharedAgentTurnResult {
  reply: string;
  /** history + the new user message + the assistant reply (persist this). */
  history: SharedTurnMessage[];
  model: string;
  /**
   * True only for the designed no-model-configured "unavailable" state (the sole
   * degrade path). An inference/provider failure THROWS instead — so a broken
   * turn never reads as this benign flag. The caller classifies the preserved
   * provider cause before deciding whether zero cost is actually proven.
   */
  degraded: boolean;
  usage?: SharedAgentTurnUsage;
  /**
   * Set when the turn was an in-app navigation command handled deterministically
   * (no LLM call). The caller attaches a VIEWS navigation handoff to the turn's
   * `done` SSE frame so the PWA opens the view. See shared-nav-intent.ts.
   */
  navIntent?: SharedNavIntent;
}

export type SharedAgentTurnStreamPart =
  | { type: "text-delta"; text: string }
  | { type: "finish"; text: string; usage?: SharedAgentTurnUsage };

export interface RunSharedAgentTurnStreamResult {
  model: string;
  degraded: boolean;
  reply?: string;
  history?: SharedTurnMessage[];
  parts?: AsyncIterable<SharedAgentTurnStreamPart>;
  /**
   * Set when the turn was an in-app navigation command handled deterministically
   * (no LLM call, so `parts` streams the canned confirmation text). The caller
   * attaches a VIEWS navigation handoff to the `done` SSE frame from this so the
   * PWA opens the view. See shared-nav-intent.ts.
   */
  navIntent?: SharedNavIntent;
}

/**
 * The shared default when an agent configures no model: the bare Cerebras small
 * id, which `getLanguageModel` sends straight to Cerebras (fast + cheap, no
 * gateway hop). Big-model agents can still set another bare Cerebras model.
 */
const DEFAULT_SHARED_MODEL = CEREBRAS_DEFAULT_TEXT_SMALL_MODEL;

/**
 * Retry budget for the shared-runtime (Tier 0) chat turn.
 *
 * WHY THIS IS NOT THE AI-SDK DEFAULT (2): the shared turn is the interactive
 * chat / voice hot path with a sub-1.5s TTFT budget, and it runs the Cerebras
 * default route with NO cross-provider fallback (`withRateLimitFailFast` only
 * short-circuits 429; 5xx/network keep the SDK's retry). The AI SDK's default
 * exponential backoff is `initialDelayInMs=2000, backoffFactor=2`, so a single
 * transient Cerebras 5xx/network blip costs +2s (1 retry) or +6s (2 retries)
 * of pure sleep BEFORE the turn can succeed or surface. That is the exact
 * bimodal 5-10s warm-stall signature measured on staging (fast turns ~1s;
 * stalled turns ~5s single-retry / ~7-9s double-retry) — a promotion blocker.
 *
 * COLD-PATH stall-B fix (COLDPATH-FIX-2026-07-21): the default is now ZERO.
 * #16713 capped the SDK retry at ONE, which still cost a ~2s `initialDelayInMs`
 * SLEEP that then retried the SAME dead Cerebras upstream. The interactive turn
 * now routes through `getInteractiveCerebrasLanguageModel`, whose middleware
 * fails over to OpenRouter IMMEDIATELY (no backoff) on a transient 5xx/network
 * error — so the SDK's sleeping retry is redundant and, worse, additive. With
 * `maxRetries: 0` a transient blip costs one instant cross-provider failover
 * instead of a 2s–6s sleep, and a hard failure surfaces fast to the refund path.
 * Still tunable via `SHARED_TURN_MAX_RETRIES` for ops without a redeploy;
 * clamped to [0, 2] so it can never re-introduce the SDK default it bounds.
 * Ops can raise it, but the healthy default keeps zero SDK backoff on the
 * interactive path since the failover wrapper owns resilience now.
 */
function resolveSharedTurnMaxRetries(
  raw: string | undefined = process.env.SHARED_TURN_MAX_RETRIES,
): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 2);
}

export const SHARED_TURN_MAX_RETRIES = resolveSharedTurnMaxRetries();

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
  const sentAt = Date.now();
  return [
    ...history,
    { role: "user", content: userMessage, createdAt: sentAt },
    { role: "assistant", content: reply, createdAt: sentAt + 1 },
  ];
}

/**
 * Run one shared (container-free) turn for a simple agent. Returns a degraded
 * result only when NO shared model is configured (a designed-unavailable state);
 * an inference/provider failure is thrown with its cause so the caller can make
 * a conservative settlement decision and surface the failure rather than
 * mistaking it for a delivered reply.
 */
export async function runSharedAgentTurn(
  input: RunSharedAgentTurnInput,
): Promise<RunSharedAgentTurnResult> {
  const message = input.message.trim();

  // Deterministic in-app navigation fast path (no LLM, no plugin). A Tier-0
  // shared agent has no VIEWS action, so "go to settings" would otherwise be a
  // hallucinated prose refusal; resolve it here and hand the client a VIEWS
  // navigation so the view actually opens (#F5-ACTIONS).
  const navIntent = resolveSharedNavIntent(message);
  if (navIntent) {
    return {
      reply: navIntent.reply,
      history: appendTurn(input.history, message, navIntent.reply),
      model: "nav-intent",
      degraded: false,
      navIntent,
    };
  }

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
    const model = getInteractiveCerebrasLanguageModel(modelId);
    const system = buildSystemPrompt(input.character);
    const messages = [
      ...input.history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: message },
    ];
    await input.onProviderDispatch?.();
    const { text, usage } = await generateText({
      model,
      // Zero SDK backoff on the interactive turn (see SHARED_TURN_MAX_RETRIES):
      // the model wrapper fails over to a healthy provider INSTANTLY on a 5xx,
      // so the SDK's 2-6s sleeping retry is redundant and only adds latency.
      maxRetries: SHARED_TURN_MAX_RETRIES,
      system,
      messages,
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
    // error-policy:J2 context-adding rethrow. An inference/provider failure is an
    // INTERNAL failure, not a designed-empty result: swallowing it into a
    // `degraded: true` reply made a broken turn indistinguishable from the
    // no-model-configured unavailable state above and let it read as a delivered
    // (if apologetic) chat message. Rethrow with `cause` so it surfaces and the
    // caller can distinguish explicit rejection from an ambiguous provider
    // outcome before choosing zero-cost versus estimate settlement.
    throw new Error(
      `[shared-runtime] agent turn failed (agent=${input.character.name}, model=${modelId})`,
      { cause: error },
    );
  }
}

/**
 * Start one shared turn and expose provider text deltas as they arrive. The
 * caller still owns history persistence and billing because it knows the
 * agent/channel/accounting context; this function only bridges the AI SDK
 * stream into the shared-runtime turn shape.
 */
export async function runSharedAgentTurnStream(
  input: RunSharedAgentTurnInput,
): Promise<RunSharedAgentTurnStreamResult> {
  const message = input.message.trim();

  // Deterministic in-app navigation fast path (no LLM, no plugin). Synthesize a
  // one-shot stream that yields the confirmation text so the SSE shape is
  // identical to a normal turn; the caller reads `navIntent` to attach a VIEWS
  // navigation handoff to the `done` frame (#F5-ACTIONS).
  const navIntent = resolveSharedNavIntent(message);
  if (navIntent) {
    const reply = navIntent.reply;
    const parts = (async function* (): AsyncIterable<SharedAgentTurnStreamPart> {
      yield { type: "text-delta", text: reply };
      yield { type: "finish", text: reply };
    })();
    return {
      model: "nav-intent",
      degraded: false,
      reply,
      history: appendTurn(input.history, message, reply),
      parts,
      navIntent,
    };
  }

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
    const model = getInteractiveCerebrasLanguageModel(modelId);
    const system = buildSystemPrompt(input.character);
    const messages = [
      ...input.history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: message },
    ];
    await input.onProviderDispatch?.();
    const result = streamText({
      model,
      // Zero SDK backoff on the interactive turn (see SHARED_TURN_MAX_RETRIES):
      // the model wrapper fails over to a healthy provider INSTANTLY on a 5xx,
      // so the SDK's 2-6s sleeping retry is redundant and only adds latency.
      maxRetries: SHARED_TURN_MAX_RETRIES,
      system,
      messages,
    });

    const parts = (async function* (): AsyncIterable<SharedAgentTurnStreamPart> {
      let reply = "";
      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            reply += part.text;
            yield { type: "text-delta", text: part.text };
          }
          if (part.type === "finish") {
            yield {
              type: "finish",
              text: reply.trim() || "…",
              usage: part.totalUsage,
            };
          }
        }
      } catch (error) {
        // error-policy:J2 context-adding rethrow. Stream failures happen after
        // the HTTP response may have started, so callers need this failure to
        // classify the preserved provider outcome before settling the reservation.
        throw new Error(
          `[shared-runtime] streaming agent turn failed (agent=${input.character.name}, model=${modelId})`,
          { cause: error },
        );
      }
    })();

    return {
      model: modelId,
      degraded: false,
      parts,
    };
  } catch (error) {
    // error-policy:J2 context-adding rethrow. Preserve the setup/provider cause
    // so the caller refunds only a provably unaccepted invocation.
    throw new Error(
      `[shared-runtime] streaming agent turn failed (agent=${input.character.name}, model=${modelId})`,
      { cause: error },
    );
  }
}
