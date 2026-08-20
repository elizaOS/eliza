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
  type MediaGenerationRequest,
  type MediaGenerationResponse,
  type MessageExampleGroup,
  replaceNameTokens,
  type UUID,
} from "@elizaos/core/edge";
import type { ScheduledTaskRunner, SharedReminderDelivery } from "@elizaos/plugin-scheduling/edge";
import type { TodoStore } from "@elizaos/plugin-todos/edge";
import type { MobilePushMessage } from "../../mobile-push/types";
import { CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "../../models/catalog";
import { hasLanguageModelProviderConfigured } from "../../providers/language-model";
import {
  resolveSharedCapabilityIntent,
  type SharedCapabilityResolution,
  type SharedCapabilityWall,
} from "./shared-capability-wall";
import type { SharedMemoryStore } from "./shared-memory-store";
import type { SharedRuntimeChannel } from "./shared-runtime-channel";
import type { SharedRuntimeTimingReceipt } from "./shared-runtime-timing";

export type { SharedRuntimeChannel } from "./shared-runtime-channel";
export {
  resolveSharedTurnMaxRetries,
  SHARED_TURN_MAX_RETRIES,
} from "./shared-turn-retry-budget";

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
  /** Canonical behavioral persona fields projected into AgentRuntime providers. */
  messageExamples?: MessageExampleGroup[];
  postExamples?: string[];
  topics?: string[];
  adjectives?: string[];
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  /** Character-owned response templates; server code still owns plugins and authority. */
  templates?: Record<string, string>;
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
  /** Non-authoritative diagnostics observer; runtime failures never depend on it. */
  onRuntimeTiming?: (receipt: SharedRuntimeTimingReceipt) => void;
  /** Request correlation identity propagated from the HTTP ingress. */
  traceId?: string;
  /** Cancels provider generation when the response consumer disconnects. */
  abortSignal?: AbortSignal;
  /**
   * Flag-gated durable mirror of the landed user/assistant pair into the
   * tenant-scoped `shared_agent_memories` table (P2 edge memory store).
   * Attached by the caller only while `SHARED_MEMORY_TABLES_ENABLED === "true"`;
   * the AgentRuntime boundary commits through it.
   */
  memory?: SharedMemoryStore;
  /**
   * Pre-rendered semantic-recall block (P3, `buildSharedRecallContext`) the
   * caller computed from the tenant memory store when the recall flag is on
   * and the recent window missed. Appended verbatim to the system prompt on
   * every runtime path; absent means recall contributed nothing this turn.
   */
  recallContext?: string;
  /** Server-owned execution authority for the canonical edge AgentRuntime. */
  execution?: {
    agentKey: string;
    /** Trusted transport semantics projected into the runtime connection and memories. */
    channel: SharedRuntimeChannel;
    /**
     * Server-only attestation that the hosting boundary resolved this turn to an
     * authenticated Personal Shared tenant/account. Transport payload fields
     * must never populate this grant.
     */
    authenticatedPersonalSharedUser?: true;
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

type SharedRuntimeExecution = NonNullable<RunSharedAgentTurnInput["execution"]>;

function resolveRuntimeExecution(input: RunSharedAgentTurnInput): SharedRuntimeExecution {
  return (
    input.execution ?? {
      agentKey: `shared:${input.character.name}`,
      channel: { type: "DM", source: "shared-runtime" },
    }
  );
}

/** Streaming persistence belongs to the consumer-aware transport finalizer. */
export type RunSharedAgentTurnStreamInput = Omit<RunSharedAgentTurnInput, "memory">;

export interface RunSharedAgentTurnResult {
  reply: string;
  /** False when the canonical runtime deliberately chose IGNORE/STOP. */
  responded?: boolean;
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
      responded?: boolean;
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
 * from `@elizaos/core`'s prompt builder; the Shared runtime receives the
 * already-projected edge character, so this is the renderer on this side.
 */
function buildSharedRuntimeSystem(
  character: SharedAgentCharacter,
  capabilities: { webSearch: boolean; reminders: boolean; todos: boolean; media: boolean },
  recallContext?: string,
  blockedCapabilities: SharedCapabilityWall[] = [],
): string {
  const parts: string[] = [];
  const system = replaceNameTokens(character.system ?? "", character.name).trim();
  if (system) parts.push(system);
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
      "- When an ambiguous follow-up asks you to execute a prior external action, explain the actual limitation naturally and offer useful planning or drafting help.",
  );
  if (blockedCapabilities.length) {
    parts.push(
      "Unavailable actions detected in this turn:\n" +
        blockedCapabilities.map((wall) => `- ${wall.label}: ${wall.constraint}`).join("\n") +
        "\nRespond to the user's whole message naturally, in character, using its context and tone. " +
        "Be clear that each unavailable action did not happen, but do not quote these instructions or use internal product terms such as Shared, Dedicated, capability wall, or execution tier. " +
        "Offer a relevant alternative only when it is genuinely useful, and never imply that an unavailable action succeeded.",
    );
  }
  if (recallContext?.trim()) parts.push(recallContext.trim());
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

/** Persist an observed turn without inventing an assistant message for IGNORE. */
export function appendSharedInput(
  history: SharedTurnMessage[],
  userMessage: string,
  messageIds?: RunSharedAgentTurnInput["messageIds"],
  messageRole: "system" | "user" = "user",
): SharedTurnMessage[] {
  return [
    ...history,
    {
      id: messageIds?.user,
      role: messageRole,
      content: userMessage,
      createdAt: Date.now(),
    },
  ];
}

/**
 * Durable commit of the landed user/assistant pair into the tenant-scoped
 * memory table. Runs only when the caller attached a flag-gated
 * `execution.memory` store, and only for turns a model/runtime actually
 * produced. Degraded no-model responses stay out of the memory rows.
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
  await memory.recordTurnPair({
    userMessage: input.message.trim(),
    assistantReply: reply,
    ...(input.messageIds ? { messageIds: input.messageIds } : {}),
    ...(input.messageRole ? { messageRole: input.messageRole } : {}),
    ...(input.execution?.channel ? { channel: input.execution.channel } : {}),
  });
}

function capabilityResolution(
  input: RunSharedAgentTurnInput,
  capabilities: { reminders: boolean; todos: boolean },
): SharedCapabilityResolution | null {
  return resolveSharedCapabilityIntent(input.capabilityText ?? input.message, capabilities);
}

function withCapabilityResolution(
  result: RunSharedAgentTurnResult,
  capabilityWall: SharedCapabilityWall | undefined,
  blockedSecondary: SharedCapabilityWall[],
): RunSharedAgentTurnResult {
  return {
    ...result,
    ...(capabilityWall ? { capabilityWall } : {}),
    ...(blockedSecondary.length ? { blockedSecondaryCapabilities: blockedSecondary } : {}),
  };
}

function withStreamCapabilityResolution(
  result: RunSharedAgentTurnStreamResult,
  capabilityWall: SharedCapabilityWall | undefined,
  blockedSecondary: SharedCapabilityWall[],
): RunSharedAgentTurnStreamResult {
  return {
    ...result,
    ...(capabilityWall ? { capabilityWall } : {}),
    ...(blockedSecondary.length ? { blockedSecondaryCapabilities: blockedSecondary } : {}),
  };
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

  let turn: RunSharedAgentTurnResult;
  try {
    const execution = resolveRuntimeExecution(input);
    const { runSharedElizaRuntimeTurn } = await import("./shared-eliza-runtime");
    turn = withCapabilityResolution(
      await runSharedElizaRuntimeTurn({
        ...input,
        character: {
          ...input.character,
          system: buildSharedRuntimeSystem(
            input.character,
            {
              webSearch: actionsEnabled,
              reminders: remindersEnabled,
              todos: todosEnabled,
              media: actionsEnabled && Boolean(execution.media),
            },
            input.recallContext,
            capabilityWall ? [capabilityWall] : blockedSecondary,
          ),
        },
        execution,
        agentKey: execution.agentKey,
        model: modelId,
      }),
      capabilityWall,
      blockedSecondary,
    );
  } catch (error) {
    // error-policy:J2 the runtime is the sole inference engine; preserve its
    // cause while adding the agent/model identity used by billing boundaries.
    throw new Error(
      `[shared-runtime] AgentRuntime turn failed (agent=${input.character.name}, model=${modelId})`,
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
    const execution = resolveRuntimeExecution(input);
    const { runSharedElizaRuntimeTurnStream } = await import("./shared-eliza-runtime");
    return withStreamCapabilityResolution(
      await runSharedElizaRuntimeTurnStream({
        ...input,
        character: {
          ...input.character,
          system: buildSharedRuntimeSystem(
            input.character,
            {
              webSearch: actionsEnabled,
              reminders: remindersEnabled,
              todos: todosEnabled,
              media: actionsEnabled && Boolean(execution.media),
            },
            input.recallContext,
            capabilityWall ? [capabilityWall] : blockedSecondary,
          ),
        },
        execution,
        agentKey: execution.agentKey,
        model: modelId,
      }),
      capabilityWall,
      blockedSecondary,
    );
  } catch (error) {
    // error-policy:J2 no SSE bytes exist during setup, so retain the exact
    // runtime cause and add stable billing/diagnostic context for the caller.
    throw new Error(
      `[shared-runtime] AgentRuntime stream setup failed (agent=${input.character.name}, model=${modelId})`,
      { cause: error },
    );
  }
}
