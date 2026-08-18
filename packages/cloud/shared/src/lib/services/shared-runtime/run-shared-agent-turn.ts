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

import {
  type ActionResult,
  ChannelType,
  type ChannelType as ChannelTypeValue,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type MediaGenerationRequest,
  type MediaGenerationResponse,
  replaceNameTokens,
  type UUID,
} from "@elizaos/core/edge";
import type { ScheduledTaskRunner, SharedReminderDelivery } from "@elizaos/plugin-scheduling/edge";
import type { TodoStore } from "@elizaos/plugin-todos/edge";
import { generateText, streamText } from "ai";
import type { MobilePushMessage } from "../../mobile-push/types";
import { CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "../../models/catalog";
import {
  getInteractiveCerebrasLanguageModel,
  hasLanguageModelProviderConfigured,
} from "../../providers/language-model";
import {
  resolveSharedCapabilityIntent,
  type SharedCapabilityResolution,
  type SharedCapabilityWall,
} from "./shared-capability-wall";
import type { SharedMemoryStore } from "./shared-memory-store";
import type { TrustedSharedChannelEnvelope } from "./trusted-shared-channel";
import { LEGACY_SHARED_HISTORY_CHANNEL, SHARED_SYSTEM_CHANNEL } from "./trusted-shared-channel";

export interface SharedTurnMessage {
  /** Stable message id used by SSE, REST history, and storage merge paths. */
  id?: string;
  role: "system" | "user" | "assistant";
  content: string;
  /** Original transport source. Optional only for pre-provenance persisted rows. */
  source?: string;
  /** Original transport mode. Optional only for pre-provenance persisted rows. */
  channelType?: ChannelTypeValue;
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

/** Server-authenticated media authority injected into an ephemeral Shared runtime. */
export interface SharedMediaGenerationPort {
  canGenerateMedia(
    request: Pick<MediaGenerationRequest, "mediaType" | "audioKind">,
  ): boolean | Promise<boolean>;
  generateMedia(request: MediaGenerationRequest): Promise<MediaGenerationResponse>;
}

export interface RunSharedAgentTurnInput {
  character: SharedAgentCharacter;
  /** Prior conversation (oldest first). The new user message is NOT included. */
  history: SharedTurnMessage[];
  /** The incoming user message or event text. */
  message: string;
  /** Authenticated raw utterance used for capability checks when `message` includes server context. */
  capabilityText?: string;
  /** Trusted lifecycle callers may add a system event instead of impersonating the user. */
  messageRole?: "system" | "user";
  /** Stable ids assigned by the transport for the persisted user/assistant pair. */
  messageIds?: {
    user: string;
    assistant: string;
  };
  /** Raw transport turn identity shared with Dedicated action idempotency. */
  originClientMessageId?: string;
  /** Durable accounting transition invoked at the final provider handoff. */
  onProviderDispatch?: () => Promise<void>;
  /** Cancels provider generation when the response consumer disconnects. */
  abortSignal?: AbortSignal;
  /**
   * Flag-gated durable mirror of the landed user/assistant pair into the
   * tenant-scoped `shared_agent_memories` table (P2 edge memory store).
   * Attached by the caller only while `SHARED_MEMORY_TABLES_ENABLED === "true"`;
   * the runtime engine commits through it.
   */
  memory?: SharedMemoryStore;
  /**
   * Pre-rendered semantic-recall block (P3, `buildSharedRecallContext`) the
   * caller computed from the tenant memory store when the recall flag is on
   * and the recent window missed. Appended verbatim to the system prompt on
   * every runtime turn; absent means recall contributed nothing this turn.
   */
  recallContext?: string;
  /**
   * Selects the canonical Workerd AgentRuntime path and its stable identity.
   */
  execution?: {
    engine: "eliza-runtime";
    agentKey: string;
    /** Server-resolved conversation identity used for runtime room/world isolation. */
    roomKey?: string;
    /**
     * Server-only attestation that the hosting boundary resolved this turn to an
     * authenticated Personal Shared tenant/account. Transport payload fields
     * must never populate this grant.
     */
    authenticatedPersonalSharedUser?: true;
    /** Server-owned transport provenance; RPC/body fields never populate it. */
    trustedChannel?: TrustedSharedChannelEnvelope;
    todos?: {
      scope: { agentId: UUID; entityId: UUID };
      store: TodoStore;
    };
    reminders?: {
      delivery: SharedReminderDelivery;
      runner: ScheduledTaskRunner;
    };
    mobilePush?: {
      dispatch: (message: MobilePushMessage) => Promise<void>;
    };
    /** Present only when the server has a configured, billable Cloud image authority. */
    media?: SharedMediaGenerationPort;
  };
}

/** Streaming persistence belongs to the consumer-aware transport finalizer. */
export type RunSharedAgentTurnStreamInput = Omit<RunSharedAgentTurnInput, "memory">;

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
  /** Genuine plugin results, including applied effect receipts, for clients and replay. */
  actionResults?: ActionResult[];
  /** Typed refusal for a tool or device action Shared cannot execute. */
  capabilityWall?: SharedCapabilityWall;
  /** Unsupported clauses that follow an enabled primary reminder or Todo. */
  blockedSecondaryCapabilities?: SharedCapabilityWall[];
}

export type SharedAgentTurnStreamPart =
  | { type: "text-delta"; text: string }
  | {
      type: "finish";
      text: string;
      usage?: SharedAgentTurnUsage;
      /** Applied plugin effects that must land with the terminal turn. */
      actionResults?: ActionResult[];
    };

export interface RunSharedAgentTurnStreamResult {
  model: string;
  degraded: boolean;
  reply?: string;
  history?: SharedTurnMessage[];
  /** Genuine plugin results preserved on the terminal SSE frame and replay. */
  actionResults?: ActionResult[];
  parts?: AsyncIterable<SharedAgentTurnStreamPart>;
  /** Cancels the AI SDK response reader in addition to aborting provider I/O. */
  cancel?: (reason?: unknown) => Promise<void>;
  /** Typed refusal for a tool or device action Shared cannot execute. */
  capabilityWall?: SharedCapabilityWall;
  /** Unsupported clauses that follow an enabled primary reminder or Todo. */
  blockedSecondaryCapabilities?: SharedCapabilityWall[];
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
  capabilities: { webSearch: boolean; reminders: boolean; todos: boolean; media: boolean },
  recallContext?: string,
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
      (capabilities.webSearch
        ? "- You can converse, reason, draft, help the user plan, and use WEB_SEARCH for current public information.\n" +
          "- WEB_SEARCH reads public results only; it does not operate websites, access accounts, submit forms, or make changes.\n"
        : "- You can converse, reason, draft, and help the user plan; public web search is unavailable for this turn.\n") +
      (capabilities.reminders
        ? "- REMINDERS can create, list, snooze, complete, and dismiss reminders delivered to this private chat.\n"
        : "- Reminders are unavailable on this transport.\n") +
      (capabilities.todos
        ? "- TODO can create, list, update, complete, cancel, and delete this account's persistent checklist.\n"
        : "- Persistent todos are unavailable on this chat path.\n") +
      (capabilities.media
        ? "- GENERATE_MEDIA can create one organization-credit-funded image and return its public artifact URL.\n"
        : "- Image generation is unavailable on this chat path.\n") +
      "- You have no connected accounts, calendar, calling, arbitrary messaging, purchasing, notes store, shell, filesystem, browser control, or code execution in this runtime.\n" +
      "- Never claim that you performed, scheduled, sent, booked, bought, saved, opened, or changed anything unless a registered action returned a successful result for that exact effect.\n" +
      "- When an ambiguous follow-up asks you to execute a prior external action, state that the action needs Dedicated and offer the useful planning or drafting help you can provide here.",
  );
  if (recallContext?.trim()) parts.push(recallContext.trim());
  return parts.join("\n\n") || `You are ${character.name}, a helpful assistant.`;
}

export function appendSharedTurn(
  history: SharedTurnMessage[],
  userMessage: string,
  reply: string,
  messageIds?: RunSharedAgentTurnInput["messageIds"],
  messageRole: "system" | "user" = "user",
  provenance: TrustedSharedChannelEnvelope = messageRole === "system"
    ? SHARED_SYSTEM_CHANNEL
    : LEGACY_SHARED_HISTORY_CHANNEL,
): SharedTurnMessage[] {
  const sentAt = Date.now();
  return [
    ...history,
    {
      id: messageIds?.user,
      role: messageRole,
      content: userMessage,
      source: provenance.source,
      channelType: provenance.channelType,
      createdAt: sentAt,
    },
    {
      id: messageIds?.assistant,
      role: "assistant",
      content: reply,
      source: provenance.source,
      channelType: provenance.channelType,
      createdAt: sentAt + 1,
    },
  ];
}

/** Resolve the exact provenance stored for the newly landed turn pair. */
export function sharedTurnProvenance(
  input: Pick<RunSharedAgentTurnInput, "execution" | "messageRole">,
): TrustedSharedChannelEnvelope {
  if (input.messageRole === "system") return SHARED_SYSTEM_CHANNEL;
  if (input.execution?.trustedChannel) return input.execution.trustedChannel;
  return {
    source:
      input.execution?.authenticatedPersonalSharedUser === true
        ? MESSAGE_SOURCE_CLIENT_CHAT
        : "shared-runtime",
    channelType: ChannelType.DM,
  };
}

/**
 * Durable commit of the landed user/assistant pair into the tenant-scoped
 * memory table. Runs only when the caller attached a flag-gated
 * `execution.memory` store, and only for turns a model/runtime actually
 * produced — the capability-wall and degraded paths are transport UX, not
 * model conversation, and stay out of the memory rows.
 *
 * WHY a plain await and not waitUntil: this module is deliberately
 * executionCtx-independent (it also runs outside Cloudflare Workers), so no
 * waitUntil exists here. The await happens strictly AFTER the reply has fully
 * landed — TTFT and token streaming are unaffected — and it adds one bounded
 * scoped insert pair to the turn's final commit. A write failure propagates so
 * a turn is never reported durable while its memory rows silently vanished.
 */
async function commitSharedTurnMemory(
  input: RunSharedAgentTurnInput,
  reply: string,
): Promise<void> {
  const memory = input.memory;
  if (!memory) return;
  const provenance = sharedTurnProvenance(input);
  await memory.recordTurnPair({
    userMessage: input.message.trim(),
    assistantReply: reply,
    ...(input.messageIds ? { messageIds: input.messageIds } : {}),
    ...(input.messageRole ? { messageRole: input.messageRole } : {}),
    source: provenance.source,
    channelType: provenance.channelType,
  });
}

function modelHistoryContent(message: SharedTurnMessage): string {
  if (message.role === "assistant" && message.interrupted) {
    return `[interrupted assistant partial]\n${message.content}`;
  }
  return message.content;
}

function capabilityResolution(
  input: RunSharedAgentTurnInput,
  capabilities: { reminders: boolean; todos: boolean },
): SharedCapabilityResolution | null {
  return resolveSharedCapabilityIntent(input.capabilityText ?? input.message, capabilities);
}

function appendBlockedCapabilityReplies(reply: string, blocked: SharedCapabilityWall[]): string {
  const additions = blocked.map((wall) => wall.reply).filter((text) => !reply.includes(text));
  return additions.length ? `${reply.trim()}\n\n${additions.join("\n\n")}` : reply;
}

function blockedCapabilityReplySuffix(reply: string, blocked: SharedCapabilityWall[]): string {
  const additions = blocked.map((wall) => wall.reply).filter((text) => !reply.includes(text));
  return additions.length ? `\n\n${additions.join("\n\n")}` : "";
}

function withBlockedSecondaryCapabilities(
  result: RunSharedAgentTurnResult,
  input: RunSharedAgentTurnInput,
  blocked: SharedCapabilityWall[],
): RunSharedAgentTurnResult {
  if (!blocked.length) return result;
  const reply = appendBlockedCapabilityReplies(result.reply, blocked);
  return {
    ...result,
    reply,
    history: appendSharedTurn(
      input.history,
      input.message.trim(),
      reply,
      input.messageIds,
      input.messageRole,
      sharedTurnProvenance(input),
    ),
    blockedSecondaryCapabilities: blocked,
  };
}

function withBlockedSecondaryStream(
  result: RunSharedAgentTurnStreamResult,
  blocked: SharedCapabilityWall[],
): RunSharedAgentTurnStreamResult {
  if (!blocked.length || !result.parts) return result;
  const source = result.parts;
  const parts = (async function* (): AsyncIterable<SharedAgentTurnStreamPart> {
    for await (const part of source) {
      if (part.type === "text-delta") {
        yield part;
        continue;
      }
      const suffix = blockedCapabilityReplySuffix(part.text, blocked);
      const text = `${part.text.trim()}${suffix}`;
      if (suffix) yield { type: "text-delta", text: suffix };
      yield { ...part, text };
    }
  })();
  return { ...result, parts, blockedSecondaryCapabilities: blocked };
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

  const actionsEnabled = input.messageRole !== "system";
  const remindersEnabled = actionsEnabled && Boolean(input.execution?.reminders);
  const todosEnabled = actionsEnabled && Boolean(input.execution?.todos);
  const capabilities = {
    reminders: remindersEnabled,
    todos: todosEnabled,
  };
  const resolution = capabilityResolution(input, capabilities);
  const capabilityWall = resolution?.kind === "blocked-primary" ? resolution.blocked : undefined;
  const blockedSecondary =
    resolution?.kind === "enabled-primary" ? resolution.blockedSecondary : [];
  if (capabilityWall) {
    return {
      reply: capabilityWall.reply,
      history: appendSharedTurn(
        input.history,
        message,
        capabilityWall.reply,
        input.messageIds,
        input.messageRole,
        sharedTurnProvenance(input),
      ),
      model: "capability-wall",
      degraded: false,
      capabilityWall,
    };
  }

  const modelId = resolveSharedAgentTurnModel(input.character.model);

  if (!modelId) {
    const reply = `${input.character.name} is temporarily unavailable (no shared model configured).`;
    return {
      reply,
      history: appendSharedTurn(
        input.history,
        message,
        reply,
        input.messageIds,
        input.messageRole,
        sharedTurnProvenance(input),
      ),
      model: "none",
      degraded: true,
    };
  }

  if (input.execution?.engine === "eliza-runtime") {
    const { runSharedElizaRuntimeTurn } = await import("./shared-eliza-runtime");
    const result = await runSharedElizaRuntimeTurn({
      ...input,
      character: {
        ...input.character,
        system: buildSystemPrompt(
          input.character,
          {
            webSearch: actionsEnabled,
            reminders: remindersEnabled,
            todos: todosEnabled,
            media: actionsEnabled && Boolean(input.execution.media),
          },
          input.recallContext,
        ),
      },
      agentKey: input.execution.agentKey,
      model: modelId,
    });
    const turn = withBlockedSecondaryCapabilities(result, input, blockedSecondary);
    await commitSharedTurnMemory(input, turn.reply);
    return turn;
  }

  let turn: RunSharedAgentTurnResult;
  try {
    const model = getInteractiveCerebrasLanguageModel(modelId);
    const system = buildSystemPrompt(
      input.character,
      {
        webSearch: actionsEnabled,
        reminders: remindersEnabled,
        todos: todosEnabled,
        media: false,
      },
      input.recallContext,
    );
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
    turn = withBlockedSecondaryCapabilities(
      {
        reply,
        history: appendSharedTurn(
          input.history,
          message,
          reply,
          input.messageIds,
          input.messageRole,
          sharedTurnProvenance(input),
        ),
        model: modelId,
        degraded: false,
        usage,
      },
      input,
      blockedSecondary,
    );
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
  // The durable memory commit runs OUTSIDE the provider try/catch: its failure
  // is a storage fault on an already-landed reply and must not be re-labeled
  // as a provider outcome for the caller's settlement classification.
  await commitSharedTurnMemory(input, turn.reply);
  return turn;
}

/**
 * Start one shared turn and expose provider text deltas as they arrive. The
 * caller still owns history persistence and billing because it knows the
 * agent/channel/accounting context; this function only bridges the AI SDK
 * stream into the shared-runtime turn shape.
 */
export async function runSharedAgentTurnStream(
  input: RunSharedAgentTurnStreamInput,
): Promise<RunSharedAgentTurnStreamResult> {
  const message = input.message.trim();

  const actionsEnabled = input.messageRole !== "system";
  const remindersEnabled = actionsEnabled && Boolean(input.execution?.reminders);
  const todosEnabled = actionsEnabled && Boolean(input.execution?.todos);
  const capabilities = {
    reminders: remindersEnabled,
    todos: todosEnabled,
  };
  const resolution = capabilityResolution(input, capabilities);
  const capabilityWall = resolution?.kind === "blocked-primary" ? resolution.blocked : undefined;
  const blockedSecondary =
    resolution?.kind === "enabled-primary" ? resolution.blockedSecondary : [];
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
      history: appendSharedTurn(
        input.history,
        message,
        reply,
        input.messageIds,
        input.messageRole,
        sharedTurnProvenance(input),
      ),
      parts,
      capabilityWall,
    };
  }

  const modelId = resolveSharedAgentTurnModel(input.character.model);

  if (!modelId) {
    const reply = `${input.character.name} is temporarily unavailable (no shared model configured).`;
    return {
      reply,
      history: appendSharedTurn(
        input.history,
        message,
        reply,
        input.messageIds,
        input.messageRole,
        sharedTurnProvenance(input),
      ),
      model: "none",
      degraded: true,
    };
  }

  if (input.execution?.engine === "eliza-runtime") {
    const { runSharedElizaRuntimeTurnStream } = await import("./shared-eliza-runtime");
    return withBlockedSecondaryStream(
      await runSharedElizaRuntimeTurnStream({
        ...input,
        character: {
          ...input.character,
          system: buildSystemPrompt(
            input.character,
            {
              webSearch: actionsEnabled,
              reminders: remindersEnabled,
              todos: todosEnabled,
              media: actionsEnabled && Boolean(input.execution.media),
            },
            input.recallContext,
          ),
        },
        agentKey: input.execution.agentKey,
        model: modelId,
      }),
      blockedSecondary,
    );
  }

  try {
    const model = getInteractiveCerebrasLanguageModel(modelId);
    const system = buildSystemPrompt(
      input.character,
      {
        webSearch: actionsEnabled,
        reminders: remindersEnabled,
        todos: todosEnabled,
        media: false,
      },
      input.recallContext,
    );
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
    // error-policy:J5 cancel(reason) rejects the SDK's pending result
    // promises; the parts iterator below is the observed failure channel, so
    // mark every promise-typed result property handled here to keep a
    // barge-in from surfacing its cancellation reason as unhandled
    // rejections on the event loop. Stream-typed getters (fullStream,
    // textStream, ...) are deliberately NOT touched — accessing them tees or
    // locks the provider stream.
    const settledResultProps = [
      "content",
      "text",
      "reasoning",
      "reasoningText",
      "files",
      "sources",
      "toolCalls",
      "staticToolCalls",
      "dynamicToolCalls",
      "staticToolResults",
      "dynamicToolResults",
      "toolResults",
      "finishReason",
      "rawFinishReason",
      "usage",
      "totalUsage",
      "warnings",
      "steps",
      "request",
      "response",
      "providerMetadata",
    ] as const;
    for (const prop of settledResultProps) {
      const pending = (result as unknown as Record<string, unknown>)[prop];
      if (pending && typeof (pending as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(pending as PromiseLike<unknown>).catch(() => {});
      }
    }
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

    return withBlockedSecondaryStream(
      {
        model: modelId,
        degraded: false,
        parts,
        cancel,
      },
      blockedSecondary,
    );
  } catch (error) {
    // error-policy:J2 context-adding rethrow. Preserve the setup/provider cause
    // so the caller refunds only a provably unaccepted invocation.
    throw new Error(
      `[shared-runtime] streaming agent turn failed (agent=${input.character.name}, model=${modelId})`,
      { cause: error },
    );
  }
}
