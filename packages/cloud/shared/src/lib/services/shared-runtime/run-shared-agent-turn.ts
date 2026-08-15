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

import { replaceNameTokens } from "@elizaos/core/edge";
import type { ScheduledTaskRunner, SharedReminderDelivery } from "@elizaos/plugin-scheduling/edge";
import { generateText, streamText } from "ai";
import { CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "../../models/catalog";
import {
  getInteractiveCerebrasLanguageModel,
  hasLanguageModelProviderConfigured,
} from "../../providers/language-model";
import { resolveSharedCapabilityWall, type SharedCapabilityWall } from "./shared-capability-wall";
import { resolveSharedNavIntent, type SharedNavIntent } from "./shared-nav-intent";

export interface SharedTurnMessage {
  /** Stable message id used by SSE, REST history, and storage merge paths. */
  id?: string;
  role: "system" | "user" | "assistant";
  content: string;
  /** Epoch-ms timestamp used by REST chat clients to reconcile persisted turns. */
  createdAt?: number;
  /**
   * True when an assistant message is a partial prefix from a canceled or failed
   * stream. Model history keeps the text but annotates it as incomplete.
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
  /** Trusted lifecycle callers may add a system event instead of impersonating the user. */
  messageRole?: "system" | "user";
  /** Stable ids assigned by the transport for the persisted user/assistant pair. */
  messageIds?: {
    user: string;
    assistant: string;
  };
  /** Durable accounting transition invoked at the final provider handoff. */
  onProviderDispatch?: () => Promise<void>;
  /** Cancels provider generation when the response consumer disconnects. */
  abortSignal?: AbortSignal;
  /**
   * Transition-only selector for the genuine Workerd AgentRuntime path. The
   * direct model path remains the control until the runtime path has passed
   * live model and connector proof.
   */
  execution?: {
    engine: "eliza-runtime";
    agentKey: string;
    reminders?: {
      delivery: SharedReminderDelivery;
      runner: ScheduledTaskRunner;
    };
  };
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
  /** Typed refusal for a tool or device action Shared cannot execute. */
  capabilityWall?: SharedCapabilityWall;
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
  /** Cancels the AI SDK response reader in addition to aborting provider I/O. */
  cancel?: (reason?: unknown) => Promise<void>;
  /**
   * Set when the turn was an in-app navigation command handled deterministically
   * (no LLM call, so `parts` streams the canned confirmation text). The caller
   * attaches a VIEWS navigation handoff to the `done` SSE frame from this so the
   * PWA opens the view. See shared-nav-intent.ts.
   */
  navIntent?: SharedNavIntent;
  /** Typed refusal for a tool or device action Shared cannot execute. */
  capabilityWall?: SharedCapabilityWall;
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

/**
 * Assemble the turn's system prompt.
 *
 * `{{name}}` / `{{agentName}}` tokens are resolved here because a character can
 * reach this path still carrying them: the shipped presets ship tokenized
 * `system` / `bio` so a later rename keeps propagating, and the cloud create
 * path seeds one verbatim. A container-backed agent gets the same substitution
 * from `@elizaos/core`'s prompt builder; the shared turn talks to the provider
 * directly, so it is the only renderer on this side.
 */
function buildSystemPrompt(
  character: SharedAgentCharacter,
  capabilities: { reminders: boolean },
): string {
  const parts: string[] = [];
  const system = replaceNameTokens(character.system ?? "", character.name).trim();
  if (system) parts.push(system);
  if (character.bio?.length) {
    parts.push(
      `About you:\n- ${character.bio
        .map((b) => replaceNameTokens(b, character.name).trim())
        .filter(Boolean)
        .join("\n- ")}`,
    );
  }
  parts.push(
    "Shared runtime boundaries:\n" +
      "- You can converse, reason, draft, help the user plan, and use WEB_SEARCH for current public information.\n" +
      "- WEB_SEARCH reads public results only; it does not operate websites, access accounts, submit forms, or make changes.\n" +
      (capabilities.reminders
        ? "- REMINDERS can create, list, snooze, complete, and dismiss reminders delivered to this private chat.\n"
        : "- Reminders are unavailable on this transport.\n") +
      "- You have no connected accounts, calendar, calling, arbitrary messaging, purchasing, notes store, shell, filesystem, browser control, or code execution in this runtime.\n" +
      "- Never claim that you performed, scheduled, sent, booked, bought, saved, opened, or changed anything outside this conversation.\n" +
      "- When an ambiguous follow-up asks you to execute a prior external action, state that the action needs Dedicated and offer the useful planning or drafting help you can provide here.",
  );
  return parts.join("\n\n") || `You are ${character.name}, a helpful assistant.`;
}

export function appendSharedTurn(
  history: SharedTurnMessage[],
  userMessage: string,
  reply: string,
  messageIds?: RunSharedAgentTurnInput["messageIds"],
  messageRole: "system" | "user" = "user",
): SharedTurnMessage[] {
  const sentAt = Date.now();
  return [
    ...history,
    { id: messageIds?.user, role: messageRole, content: userMessage, createdAt: sentAt },
    { id: messageIds?.assistant, role: "assistant", content: reply, createdAt: sentAt + 1 },
  ];
}

function modelHistoryContent(message: SharedTurnMessage): string {
  if (message.role === "assistant" && message.interrupted) {
    return `[interrupted assistant partial]\n${message.content}`;
  }
  return message.content;
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

  const remindersEnabled = Boolean(input.execution?.reminders);
  const capabilityWall = resolveSharedCapabilityWall(message, {
    reminders: remindersEnabled,
  });
  if (capabilityWall) {
    return {
      reply: capabilityWall.reply,
      history: appendSharedTurn(
        input.history,
        message,
        capabilityWall.reply,
        input.messageIds,
        input.messageRole,
      ),
      model: "capability-wall",
      degraded: false,
      capabilityWall,
    };
  }

  // Deterministic in-app navigation fast path (no LLM, no plugin). A Tier-0
  // shared agent has no VIEWS action, so "go to settings" would otherwise be a
  // hallucinated prose refusal; resolve it here and hand the client a VIEWS
  // navigation so the view actually opens (#F5-ACTIONS).
  const navIntent = resolveSharedNavIntent(message);
  if (navIntent) {
    return {
      reply: navIntent.reply,
      history: appendSharedTurn(
        input.history,
        message,
        navIntent.reply,
        input.messageIds,
        input.messageRole,
      ),
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
      history: appendSharedTurn(input.history, message, reply, input.messageIds, input.messageRole),
      model: "none",
      degraded: true,
    };
  }

  if (input.execution?.engine === "eliza-runtime") {
    const { runSharedElizaRuntimeTurn } = await import("./shared-eliza-runtime");
    return await runSharedElizaRuntimeTurn({
      ...input,
      character: {
        ...input.character,
        system: buildSystemPrompt(input.character, {
          reminders: remindersEnabled,
        }),
      },
      agentKey: input.execution.agentKey,
      model: modelId,
    });
  }

  try {
    const model = getInteractiveCerebrasLanguageModel(modelId);
    const system = buildSystemPrompt(input.character, {
      reminders: remindersEnabled,
    });
    const messages = [
      ...input.history.map((m) => ({ role: m.role, content: modelHistoryContent(m) })),
      { role: input.messageRole ?? ("user" as const), content: message },
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
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    const reply = text.trim() || "…";
    return {
      reply,
      history: appendSharedTurn(input.history, message, reply, input.messageIds, input.messageRole),
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
  const remindersEnabled = false;

  const capabilityWall = resolveSharedCapabilityWall(message, {
    reminders: remindersEnabled,
  });
  if (capabilityWall) {
    const reply = capabilityWall.reply;
    const parts = (async function* (): AsyncIterable<SharedAgentTurnStreamPart> {
      yield { type: "text-delta", text: reply };
      yield { type: "finish", text: reply };
    })();
    return {
      model: "capability-wall",
      degraded: false,
      reply,
      history: appendSharedTurn(input.history, message, reply, input.messageIds, input.messageRole),
      parts,
      capabilityWall,
    };
  }

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
      history: appendSharedTurn(input.history, message, reply, input.messageIds, input.messageRole),
      parts,
      navIntent,
    };
  }

  const modelId = resolveSharedAgentTurnModel(input.character.model);

  if (!modelId) {
    const reply = `${input.character.name} is temporarily unavailable (no shared model configured).`;
    return {
      reply,
      history: appendSharedTurn(input.history, message, reply, input.messageIds, input.messageRole),
      model: "none",
      degraded: true,
    };
  }

  try {
    const model = getInteractiveCerebrasLanguageModel(modelId);
    const system = buildSystemPrompt(input.character, {
      reminders: remindersEnabled,
    });
    const messages = [
      ...input.history.map((m) => ({ role: m.role, content: modelHistoryContent(m) })),
      { role: input.messageRole ?? ("user" as const), content: message },
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
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });

    const providerReader = result.fullStream.getReader();
    let providerStreamDone = false;
    let providerStreamCancelled = false;
    let providerCancelPromise: Promise<void> | null = null;
    const cancel = async (reason?: unknown): Promise<void> => {
      if (providerStreamDone) return;
      providerStreamCancelled = true;
      providerCancelPromise ??= providerReader.cancel(reason).finally(() => {
        providerStreamDone = true;
      });
      await providerCancelPromise;
    };
    const parts = (async function* (): AsyncIterable<SharedAgentTurnStreamPart> {
      let reply = "";
      let finishSeen = false;
      try {
        for (;;) {
          const next = await providerReader.read();
          if (next.done) {
            providerStreamDone = true;
            if (!finishSeen && !providerStreamCancelled) {
              // Some AI SDK provider streams close cleanly after their text deltas
              // without forwarding a finish part. The SDK result promises are the
              // authoritative completion signal: they reject for a failed stream.
              const finalText = (await result.text).trim();
              if (!finalText) {
                throw new Error("provider stream ended without text or a finish part");
              }
              yield {
                type: "finish",
                text: finalText,
                usage: await result.totalUsage,
              };
            }
            break;
          }
          const part = next.value;
          if (part.type === "text-delta") {
            reply += part.text;
            yield { type: "text-delta", text: part.text };
          }
          if (part.type === "error") {
            throw part.error instanceof Error
              ? part.error
              : new Error("provider stream reported an unknown error");
          }
          if (part.type === "finish") {
            finishSeen = true;
            yield {
              type: "finish",
              text: reply.trim() || "…",
              usage: part.totalUsage,
            };
          }
        }
      } catch (error) {
        providerStreamDone = true;
        // error-policy:J2 context-adding rethrow. Stream failures happen after
        // the HTTP response may have started, so callers need this failure to
        // classify the preserved provider outcome before settling the reservation.
        throw new Error(
          `[shared-runtime] streaming agent turn failed (agent=${input.character.name}, model=${modelId})`,
          { cause: error },
        );
      } finally {
        if (!providerStreamDone) {
          await cancel("shared runtime stream consumer stopped");
        }
        providerReader.releaseLock();
      }
    })();

    return {
      model: modelId,
      degraded: false,
      parts,
      cancel,
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
