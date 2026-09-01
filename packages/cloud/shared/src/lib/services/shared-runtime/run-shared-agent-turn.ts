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
  stableStringify,
  type UUID,
} from "@elizaos/core/edge";
import {
  isSharedGroupReminderDelivery,
  type ScheduledTaskRunner,
  type SharedReminderDelivery,
} from "@elizaos/plugin-scheduling/edge";
import type { TodoStore } from "@elizaos/plugin-todos/edge";
import { runWebSearchEdge } from "@elizaos/plugin-web-search/edge";
import type {
  SharedRuntimePublicGrounding,
  SharedRuntimeReminderActionProvenance,
} from "../../../db/schemas/shared-runtime-history";
import type { MobilePushMessage } from "../../mobile-push/types";
import { CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "../../models/catalog";
import { hasLanguageModelProviderConfigured } from "../../providers/language-model";
import { logger } from "../../utils/logger";
import {
  buildSharedCapabilityCatalog,
  formatSharedCapabilityCatalogForPrompt,
  type SharedCapabilityFlags,
  sharedCapabilityTransportForSource,
} from "./shared-capability-catalog";
import {
  hasTrailingSharedActionCancellation,
  resolveSharedCapabilityIntent,
  type SharedCapabilityResolution,
  type SharedCapabilityWall,
} from "./shared-capability-wall";
import type { SharedMemoryStore } from "./shared-memory-store";
import {
  finalizeSharedRealtimeReply,
  hasSharedRealtimeIntent,
  requireTraceableRealtimeSearch,
  resolveSharedRealtimeRequirement,
  sharedRealtimePromptPolicy,
} from "./shared-realtime-grounding";
import type { SharedRuntimeChannel } from "./shared-runtime-channel";
import { SharedRuntimeTurnError } from "./shared-runtime-errors";
import {
  parseSharedReminderActionProvenance,
  sharedPublicWebGrounding,
} from "./shared-runtime-history-policy";
import type {
  SharedProviderTimingReceipt,
  SharedRuntimeTimingReceipt,
} from "./shared-runtime-timing";

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
  /** Bounded public-read authority retained for relevant follow-up turns. */
  grounding?: SharedRuntimePublicGrounding;
  /** Server-authenticated reminder receipt used only for the next scoped follow-up. */
  reminderAction?: SharedReminderActionProvenance;
}

export type SharedReminderOperation = SharedRuntimeReminderActionProvenance["operation"];

/** Mutation provenance derived from a genuine REMINDERS result, never assistant prose. */
export type SharedReminderActionProvenance = SharedRuntimeReminderActionProvenance;

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
    /** Trusted canonical conversation identity used for runtime room/world projection. */
    roomKey: string;
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
      roomKey: `shared:${input.character.name}`,
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
  /** Complete current-turn evidence for internal persistence; transports must never serialize it. */
  internalGrounding?: SharedRuntimePublicGrounding;
  /** Typed refusal for a tool or device action Shared cannot execute. */
  capabilityWall?: SharedCapabilityWall;
  /** Privacy-bounded provider timing exposed to Shared transports. */
  timing?: SharedProviderTimingReceipt;
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
      /** Privacy-bounded provider timing exposed on the terminal stream frame. */
      timing?: SharedProviderTimingReceipt;
    };

export interface RunSharedAgentTurnStreamResult {
  model: string;
  degraded: boolean;
  reply?: string;
  history?: SharedTurnMessage[];
  /** Genuine plugin results preserved on the terminal SSE frame and replay. */
  actionResults?: ActionResult[];
  /** Complete current-turn evidence for internal persistence; transports must never serialize it. */
  internalGrounding?: SharedRuntimePublicGrounding;
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
type RequiredSharedAction = "REMINDERS" | "TODO" | "GENERATE_MEDIA";

function buildSharedRuntimeSystem(
  character: SharedAgentCharacter,
  capabilities: SharedCapabilityFlags,
  recallContext?: string,
  blockedCapabilities: SharedCapabilityWall[] = [],
  requiredAction?: RequiredSharedAction,
  reminderClockCorrection = false,
  realtimeGrounding?: SharedRuntimePublicGrounding,
): string {
  const parts: string[] = [];
  const system = replaceNameTokens(character.system ?? "", character.name).trim();
  if (system) parts.push(system);
  const catalog = buildSharedCapabilityCatalog(capabilities);
  parts.push(
    `Shared runtime capabilities:\n${formatSharedCapabilityCatalogForPrompt(catalog)}\n` +
      "- Never claim that you performed, scheduled, sent, booked, bought, saved, opened, or changed anything unless a registered action returned a successful result for that exact effect.\n" +
      "- When setup is needed, preserve the user's intent, offer the smallest valid handoff, and continue useful planning or drafting now.",
  );
  if (blockedCapabilities.length) {
    parts.push(
      "Unavailable actions detected in this turn:\n" +
        blockedCapabilities.map((wall) => `- ${wall.label}: ${wall.constraint}`).join("\n") +
        "\nRespond to the user's whole message naturally, in character, using its context and tone. " +
        "Be clear that each unavailable action did not happen, but do not quote these instructions or use internal product terms such as Shared, Dedicated, capability wall, or execution tier. " +
        "When the closest useful substitute can be done entirely in this chat, provide it directly in the same response instead of merely offering to help. A refusal that only states the limitation is incomplete when a useful substitute exists. " +
        "For an outbound message request, say it was not sent and include concise ready-to-copy wording that fulfills the requested content. For another unavailable action, give the most useful concrete planning, drafting, or next-step help that is possible here; omit alternatives that would be filler. " +
        "Never imply that an unavailable action succeeded.",
    );
  }
  if (requiredAction) {
    const requestLabel =
      requiredAction === "REMINDERS"
        ? "reminder"
        : requiredAction === "TODO"
          ? "todo"
          : "image or video generation";
    const ungroundedClaim =
      requiredAction === "GENERATE_MEDIA"
        ? "A plain-text claim that generation was attempted, unavailable, or failed is not an execution result."
        : 'A plain-text acknowledgement such as "done", "saved", or "scheduled" is not an execution result.';
    parts.push(
      "Current-turn execution requirement:\n" +
        `- The user's current message is an executable ${requestLabel} request, and ${requiredAction} is available for this verified account.\n` +
        `- Call ${requiredAction} before any terminal answer. ${ungroundedClaim}\n` +
        (requiredAction === "REMINDERS" && reminderClockCorrection
          ? "- This turn corrects an existing reminder clock time: call REMINDERS with operation=update, never operation=create.\n"
          : "") +
        `- If the request is incomplete or cannot be applied, call ${requiredAction} anyway and use its grounded clarification or failure result; never invent success.`,
    );
  }
  if (realtimeGrounding) parts.push(sharedRealtimePromptPolicy(realtimeGrounding));
  if (recallContext?.trim()) parts.push(recallContext.trim());
  return parts.join("\n\n") || `You are ${character.name}, a helpful assistant.`;
}

function requiredActionForResolution(
  resolution: SharedCapabilityResolution | null,
): Exclude<RequiredSharedAction, "GENERATE_MEDIA"> | undefined {
  if (resolution?.kind !== "enabled-primary") return undefined;
  if (resolution.primary.capability === "reminders") return "REMINDERS";
  if (resolution.primary.capability === "todos") return "TODO";
  return undefined;
}

function isExplicitSharedMediaGenerationRequest(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
  if (!normalized) return false;
  const mediaNoun =
    "(?:image|picture|photo|art(?:work)?|illustration|logo|sticker|wallpaper|drawing|painting|meme|gif|video|animation|clip)";
  return (
    new RegExp(
      `\\b(?:generate|make|draw|create|render|paint|produce|design|animate)\\b[^.!?]{0,160}\\b${mediaNoun}s?\\b`,
      "iu",
    ).test(normalized) ||
    /\b(?:turn|convert|transform)\b[^.!?]{0,160}\b(?:image|picture|photo|attachment)\b[^.!?]{0,80}\b(?:into|to)\b[^.!?]{0,40}\b(?:video|animation|clip)\b/iu.test(
      normalized,
    )
  );
}

function requiredActionForTurn(
  input: RunSharedAgentTurnInput,
  resolution: SharedCapabilityResolution | null,
  actionsEnabled: boolean,
): RequiredSharedAction | undefined {
  const capabilityAction = requiredActionForResolution(resolution);
  if (capabilityAction) return capabilityAction;
  const intentText = input.capabilityText ?? input.message;
  if (
    actionsEnabled &&
    input.execution?.media &&
    isExplicitSharedMediaGenerationRequest(intentText)
  ) {
    return "GENERATE_MEDIA";
  }
  return undefined;
}

function hasRequiredActionResult(
  turn: RunSharedAgentTurnResult,
  actionName: RequiredSharedAction,
  reminderOperation?: SharedReminderOperation,
): boolean {
  return hasNamedActionResult(turn.actionResults, actionName, reminderOperation);
}

function hasNamedActionResult(
  results: ActionResult[] | undefined,
  actionName: RequiredSharedAction,
  reminderOperation?: SharedReminderOperation,
): boolean {
  return Boolean(
    results?.some(
      (result) =>
        result.data?.actionName === actionName &&
        (actionName !== "REMINDERS" ||
          reminderOperation === undefined ||
          result.data?.operation === reminderOperation),
    ),
  );
}

const SHARED_REMINDER_OPERATIONS = new Set<SharedReminderOperation>([
  "create",
  "list",
  "update",
  "snooze",
  "complete",
  "delete",
  "dismiss",
  "clear",
]);

function reminderDeliveryScope(delivery: SharedReminderDelivery): string {
  if (isSharedGroupReminderDelivery(delivery)) {
    const { ownerLabel: _ownerLabel, ...immutableAuthority } = delivery;
    return stableStringify(immutableAuthority);
  }
  return stableStringify(delivery);
}

function reminderActionProvenance(
  results: ActionResult[] | undefined,
  delivery: SharedReminderDelivery | undefined,
): SharedReminderActionProvenance | undefined {
  if (!delivery) return undefined;
  const result = results?.findLast((candidate) => candidate.data?.actionName === "REMINDERS");
  const operation = result?.data?.operation;
  if (
    !result ||
    typeof operation !== "string" ||
    !SHARED_REMINDER_OPERATIONS.has(operation as SharedReminderOperation)
  ) {
    return undefined;
  }
  const taskIds = new Set<string>();
  const addTaskId = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const taskId = (value as { taskId?: unknown }).taskId;
    if (typeof taskId === "string" && taskId.trim()) taskIds.add(taskId.trim());
  };
  addTaskId(result.data?.task);
  addTaskId(result.data?.replacement);
  const listedTasks = result.data?.tasks;
  if (Array.isArray(listedTasks)) {
    for (const task of listedTasks) addTaskId(task);
  }
  const candidateTaskIds =
    result.success === false &&
    result.data?.requiresSelection === true &&
    Array.isArray(result.data?.candidateTaskIds)
      ? [
          ...new Set(
            result.data.candidateTaskIds.flatMap((taskId) =>
              typeof taskId === "string" && taskId.trim() ? [taskId.trim()] : [],
            ),
          ),
        ].slice(0, 100)
      : [];
  // An update's dismissal receipt names the superseded row; only the
  // replacement in structured data may authorize a later correction.
  if (operation !== "update") {
    for (const receipt of result.effectReceipts ?? []) {
      if (receipt.resource?.kind === "shared.reminder") {
        const id = receipt.resource.id;
        if (typeof id === "string" && id.trim()) taskIds.add(id.trim());
      }
    }
  }
  return {
    actionName: "REMINDERS",
    operation: operation as SharedReminderOperation,
    success: result.success === true,
    ...(result.data?.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
    ...(candidateTaskIds.length ? { requiresSelection: true } : {}),
    taskIds: [...taskIds],
    ...(candidateTaskIds.length ? { candidateTaskIds } : {}),
    deliveryScope: reminderDeliveryScope(delivery),
  };
}

function withReminderActionProvenance(
  turn: RunSharedAgentTurnResult,
  input: RunSharedAgentTurnInput,
): RunSharedAgentTurnResult {
  const provenance = reminderActionProvenance(
    turn.actionResults,
    input.execution?.reminders?.delivery,
  );
  if (!provenance) return turn;
  const history = [...turn.history];
  const assistantIndex = input.messageIds?.assistant
    ? history.findLastIndex(
        (message) => message.role === "assistant" && message.id === input.messageIds?.assistant,
      )
    : history.findLastIndex((message) => message.role === "assistant");
  if (assistantIndex < 0) return turn;
  history[assistantIndex] = {
    ...history[assistantIndex],
    reminderAction: provenance,
  };
  return { ...turn, history };
}

function isWebSearchActionResult(result: ActionResult): boolean {
  return result.data?.actionName === "WEB_SEARCH";
}

function sharedRealtimeTransportReceipt(
  grounding: SharedRuntimePublicGrounding,
  deliveredReply: string,
): ActionResult {
  if (grounding.kind === "web_search_unavailable") {
    return {
      success: false,
      text: deliveredReply,
      error: "Live public data is temporarily unavailable.",
      data: {
        actionName: "WEB_SEARCH",
        query: grounding.query,
        observedAt: grounding.observedAt,
        deliveredReply,
        groundingStatus: "unavailable",
      },
    };
  }
  return {
    success: true,
    text: deliveredReply,
    data: {
      actionName: "WEB_SEARCH",
      query: grounding.query,
      provider: grounding.provider,
      observedAt: grounding.observedAt,
      deliveredReply,
      groundingStatus: "verified",
    },
  };
}

export function appendSharedTurn(
  history: SharedTurnMessage[],
  userMessage: string,
  reply: string,
  messageIds?: RunSharedAgentTurnInput["messageIds"],
  messageRole: "system" | "user" = "user",
  grounding?: SharedRuntimePublicGrounding,
): SharedTurnMessage[] {
  const sentAt = Date.now();
  return [
    ...history,
    { id: messageIds?.user, role: messageRole, content: userMessage, createdAt: sentAt },
    {
      id: messageIds?.assistant,
      role: "assistant",
      content: reply,
      createdAt: sentAt + 1,
      ...(grounding ? { grounding } : {}),
    },
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

function trustedReminderPredecessor(
  history: SharedTurnMessage[],
  delivery: SharedReminderDelivery | undefined,
): SharedReminderActionProvenance | undefined {
  if (!delivery) return undefined;
  const previous = history.at(-1);
  const provenance = parseSharedReminderActionProvenance(previous?.reminderAction);
  if (
    previous?.role !== "assistant" ||
    previous.interrupted === true ||
    provenance?.deliveryScope !== reminderDeliveryScope(delivery)
  ) {
    return undefined;
  }
  const operation = provenance.operation;
  if (!SHARED_REMINDER_OPERATIONS.has(operation)) return undefined;
  return provenance;
}

function groundedReminderSchedule(
  history: SharedTurnMessage[],
  delivery: SharedReminderDelivery | undefined,
): SharedReminderActionProvenance | undefined {
  const previous = trustedReminderPredecessor(history, delivery);
  return previous?.success === true &&
    (previous.operation === "create" || previous.operation === "update") &&
    previous.taskIds.length === 1
    ? previous
    : undefined;
}

function hasGroundedReminderClearChallenge(
  history: SharedTurnMessage[],
  delivery: SharedReminderDelivery | undefined,
): boolean {
  const previous = trustedReminderPredecessor(history, delivery);
  return Boolean(
    previous?.operation === "clear" &&
      previous.success === false &&
      previous.requiresConfirmation === true,
  );
}

function isReminderClockCorrectionText(text: string): boolean {
  return (
    /\b\d{1,2}(?::\d{2}|\s+\d{2}|\s*(?:am|pm))\b/iu.test(text) &&
    /\b(?:no|not|actually|instead|meant|change|make\s+that)\b/iu.test(text)
  );
}

function normalizedShortReminderCommand(text: string): string | undefined {
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized && normalized.length <= 120 ? normalized : undefined;
}

function normalizedReminderOperationCommand(text: string): string | undefined {
  const normalized = text
    .slice(0, 4_096)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized || undefined;
}

const POSITIVE_REMINDER_COMMAND_PREFIX = "(?:(?:can|could|would|will) you (?:please )?|please )?";

function primaryReminderCommandClause(text: string): string {
  return (
    text.split(
      /\s*(?:[,;]\s*|\b(?:and\s+)?then\s+)(?=(?:email|call|text|message|dm|send|add|create|update|delete|remove|complete|show|list)\b)/iu,
      1,
    )[0] ?? text
  );
}

function isExplicitReminderClearAllIntent(text: string): boolean {
  if (hasTrailingSharedActionCancellation(text)) return false;
  const normalized = normalizedReminderOperationCommand(primaryReminderCommandClause(text));
  if (!normalized) return false;
  const confirmation =
    "(?:yes|yep|oui|confirm|confirmed|confirmé|confirmée|i confirm|je confirme|do it|go ahead|vas y|allez y)";
  const clearCommand =
    "(?:(?:clear|clean|delete|remove|dismiss|cancel) (?:(?:all (?:(?:my|the) )?|my )reminders|the reminder list|the list)|(?:efface|supprime|vide) (?:tous mes rappels|la liste des rappels))";
  return new RegExp(
    `^(?:${confirmation} )*${POSITIVE_REMINDER_COMMAND_PREFIX}${clearCommand}\\b(?: .*)?$`,
    "iu",
  ).test(normalized);
}

function isShortReminderClearConfirmation(text: string): boolean {
  const normalized = normalizedShortReminderCommand(text);
  return Boolean(
    normalized &&
      /^(?:(?:yes|yep|oui|confirm(?:ed)?|confirmé|confirmée|i confirm|je confirme|do it|go ahead|vas y|allez y)(?: |$))+$/iu.test(
        normalized,
      ),
  );
}

function isExplicitReminderCreationIntent(text: string): boolean {
  if (hasTrailingSharedActionCancellation(text)) return false;
  const normalized = normalizedReminderOperationCommand(primaryReminderCommandClause(text));
  if (!normalized) return false;
  if (
    new RegExp(
      `^${POSITIVE_REMINDER_COMMAND_PREFIX}(?:set|create|add|schedule) (?:me )?(?:(?:a|an|new|another) )?reminder(?: .*)?$`,
      "iu",
    ).test(normalized)
  ) {
    return true;
  }
  const scheduleCue =
    /\b(?:today|tomorrow|tonight|noon|midnight|next (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (?:minute|minutes|hour|hours|day|days|week|weeks)|at \d{1,2}(?: \d{2})?(?: am| pm)?|\d{1,2}(?: \d{2})? (?:am|pm)|every (?:day|weekday|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+ (?:minute|minutes|hour|hours|day|days|week|weeks))|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}(?: \d{4})?|\d{1,2}(?: \d{1,2})?))\b/iu;
  if (!scheduleCue.test(normalized)) return false;
  return new RegExp(`^${POSITIVE_REMINDER_COMMAND_PREFIX}remind me\\b.+$`, "iu").test(normalized);
}

function isExplicitReminderUpdateIntent(text: string): boolean {
  if (hasTrailingSharedActionCancellation(text)) return false;
  const normalized = normalizedReminderOperationCommand(primaryReminderCommandClause(text));
  return Boolean(
    normalized &&
      new RegExp(
        `^${POSITIVE_REMINDER_COMMAND_PREFIX}(?:change|update|edit|reschedule)\\b[\\s\\S]{0,80}\\breminder\\b`,
        "iu",
      ).test(normalized),
  );
}

type TrustedReminderIntent = {
  operation: Exclude<SharedReminderOperation, "clear">;
  target?: string;
};

function reminderTargetAfterCommandNoun(
  normalized: string,
  operations: string,
): string | undefined {
  const match = normalized.match(
    new RegExp(
      `^${POSITIVE_REMINDER_COMMAND_PREFIX}(?:${operations}) (?:the |my )?reminder(?: (?:named|called))?(?: (.+?))?(?: please)?$`,
      "iu",
    ),
  );
  return match?.[1]?.trim() || undefined;
}

function reminderTargetBeforeCommandNoun(
  normalized: string,
  operations: string,
): string | undefined {
  const match = normalized.match(
    new RegExp(
      `^${POSITIVE_REMINDER_COMMAND_PREFIX}(?:${operations}) (?:the |my )?(.+?) reminder(?: (?:to|at|for|until) .+)?(?: please)?$`,
      "iu",
    ),
  );
  return match?.[1]?.trim() || undefined;
}

function reminderTargetAroundCommandNoun(
  normalized: string,
  operations: string,
): string | undefined {
  return (
    reminderTargetAfterCommandNoun(normalized, operations) ??
    reminderTargetBeforeCommandNoun(normalized, operations)
  );
}

function updateTargetBeforeSchedule(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(
    /^(.+)\s+(?:to|at|for)\s+(?:(?:at|in)\s+)?(?:\d{1,2}(?:\s+\d{2})?\s*(?:am|pm)?|today|tomorrow|tonight|noon|midnight|next\b|every\b|on\b|in\b)[\s\S]*$/iu,
  );
  return match?.[1]?.trim() || value;
}

function snoozeTargetBeforeDuration(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(
    /^(.+)\s+(?:for\s+(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:minutes?|hours?|days?)|until\s+.+)$/iu,
  );
  return match?.[1]?.trim() || value;
}

function trustedReminderOperationIntent(text: string): TrustedReminderIntent | undefined {
  if (hasTrailingSharedActionCancellation(text)) return undefined;
  const normalized = normalizedReminderOperationCommand(primaryReminderCommandClause(text));
  if (!normalized || isExplicitReminderClearAllIntent(text)) return undefined;
  if (isExplicitReminderCreationIntent(text)) return { operation: "create" };
  if (
    /^(?:(?:can|could|would) you (?:please )?|please )?(?:(?:list|show)(?: me)?(?: all)?(?: (?:the|my))? reminders?|what reminders do i have|do i have any reminders)(?: please)?$/iu.test(
      normalized,
    )
  ) {
    return { operation: "list" };
  }
  const deleteTarget = reminderTargetAroundCommandNoun(normalized, "remove|delete");
  if (deleteTarget) {
    return { operation: "delete", target: deleteTarget };
  }
  const dismissTarget = reminderTargetAroundCommandNoun(normalized, "dismiss|cancel");
  if (dismissTarget) {
    return { operation: "dismiss", target: dismissTarget };
  }
  if (isExplicitReminderUpdateIntent(text)) {
    return {
      operation: "update",
      target: updateTargetBeforeSchedule(
        reminderTargetAroundCommandNoun(normalized, "change|update|edit|reschedule"),
      ),
    };
  }
  const targetedMutation = normalized.match(
    /^(?:(?:can|could|would) you (?:please )?|please )?(snooze|complete|dismiss)\b[\s\S]*\breminder\b/iu,
  );
  const operation = targetedMutation?.[1]?.toLocaleLowerCase("en-US") as
    | "snooze"
    | "complete"
    | "dismiss"
    | undefined;
  if (operation) {
    const target = reminderTargetAroundCommandNoun(normalized, operation);
    return {
      operation,
      target: operation === "snooze" ? snoozeTargetBeforeDuration(target) : target,
    };
  }
  return undefined;
}

function contextualReminderOperationIntent(
  text: string,
): Exclude<SharedReminderOperation, "create" | "list" | "clear"> | undefined {
  const normalized = normalizedReminderOperationCommand(text);
  if (!normalized) return undefined;
  if (/\b(?:remove|delete)\b/iu.test(normalized)) return "delete";
  if (/\b(?:dismiss|cancel)\b/iu.test(normalized)) return "dismiss";
  if (/\bsnooze\b/iu.test(normalized)) return "snooze";
  if (/\bcomplete\b/iu.test(normalized)) return "complete";
  if (
    /\b(?:update|change|edit|reschedule)\b/iu.test(normalized) ||
    isReminderClockCorrectionText(text) ||
    /^(?:(?:the )?\d{1,2}:\d{2}(?:\s*(?:am|pm))?(?: one)?)$/iu.test(normalized)
  ) {
    return "update";
  }
  return undefined;
}

type ContextualReminderIntent = {
  operation: Exclude<SharedReminderOperation, "create" | "list" | "clear">;
  target?: string;
};

function reminderOrdinalSelectionIndex(text: string): number | undefined {
  const normalized = normalizedShortReminderCommand(text);
  if (!normalized) return undefined;
  const match = normalized.match(/^(?:the )?(first|second|third|1st|2nd|3rd)(?: one)?$/iu);
  switch (match?.[1]?.toLocaleLowerCase("en-US")) {
    case "first":
    case "1st":
      return 0;
    case "second":
    case "2nd":
      return 1;
    case "third":
    case "3rd":
      return 2;
    default:
      return undefined;
  }
}

function contextualReminderIntent(
  text: string,
  predecessor: SharedReminderActionProvenance | undefined,
): ContextualReminderIntent | undefined {
  if (!predecessor) return undefined;
  const explicitOperation = contextualReminderOperationIntent(text);
  if (explicitOperation) {
    return {
      operation: explicitOperation,
      ...(predecessor.taskIds.length === 1 ? { target: predecessor.taskIds[0] } : {}),
    };
  }
  const ordinalIndex = reminderOrdinalSelectionIndex(text);
  const target =
    ordinalIndex === undefined ? undefined : predecessor.candidateTaskIds?.[ordinalIndex];
  if (
    predecessor.success !== false ||
    predecessor.requiresSelection !== true ||
    !target ||
    predecessor.operation === "create" ||
    predecessor.operation === "list" ||
    predecessor.operation === "clear"
  ) {
    return undefined;
  }
  return { operation: predecessor.operation, target };
}

function isContextualReminderFollowup(input: RunSharedAgentTurnInput): boolean {
  const predecessor = trustedReminderPredecessor(
    input.history,
    input.execution?.reminders?.delivery,
  );
  if (!predecessor) {
    return false;
  }
  const text = (input.capabilityText ?? input.message).trim();
  if (!text || hasTrailingSharedActionCancellation(text)) return false;
  const normalizedConfirmation = text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    normalizedConfirmation.length <= 120 &&
    /^(?:(?:yes|yep|oui|confirm(?:ed)?|confirmé|confirmée|i confirm|je confirme|do it|go ahead|vas y|allez y)(?: |$))+$/iu.test(
      normalizedConfirmation,
    )
  ) {
    return (
      predecessor.operation === "clear" &&
      predecessor.success === false &&
      predecessor.requiresConfirmation === true
    );
  }
  if (
    /^(?:(?:can|could|would)\s+you\s+|please\s+)?(?:clear|clean|remove|delete|dismiss|cancel|update|change|edit|reschedule|snooze|complete)\b[\s\S]{0,80}$/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (/\b(?:efface|supprime|vide)\s+(?:tous mes rappels|la liste des rappels)\b/iu.test(text)) {
    return true;
  }
  if (
    /^(?:(?:the\s+)?(?:\d{1,2}:\d{2}(?:\s*(?:am|pm))?|first|second|third|1st|2nd|3rd)(?:\s+one)?)$/iu.test(
      text,
    )
  ) {
    return true;
  }
  return isReminderClockCorrectionText(text);
}

function capabilityResolution(
  input: RunSharedAgentTurnInput,
  capabilities: { reminders: boolean; todos: boolean },
  explicit: SharedCapabilityResolution | null,
): SharedCapabilityResolution | null {
  if (!isContextualReminderFollowup(input)) return explicit;
  const contextual = resolveSharedCapabilityIntent("update reminder", capabilities);
  if (
    contextual?.kind === "enabled-primary" &&
    explicit?.kind === "blocked-primary" &&
    explicit.blocked.capability !== "reminders"
  ) {
    return {
      ...contextual,
      blockedSecondary: [explicit.blocked],
    };
  }
  return explicit ?? contextual;
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
  const publicSearchText = input.capabilityText?.trim();

  const actionsEnabled = input.messageRole !== "system";
  const remindersEnabled = actionsEnabled && Boolean(input.execution?.reminders);
  const todosEnabled = actionsEnabled && Boolean(input.execution?.todos);
  const capabilities = {
    reminders: remindersEnabled,
    todos: todosEnabled,
  };
  const reminderIntentText = input.capabilityText ?? input.message;
  const explicitResolution = resolveSharedCapabilityIntent(reminderIntentText, capabilities);
  const resolution = capabilityResolution(input, capabilities, explicitResolution);
  const requiredAction = requiredActionForTurn(input, resolution, actionsEnabled);
  const reminderScheduleProvenance = groundedReminderSchedule(
    input.history,
    input.execution?.reminders?.delivery,
  );
  const reminderClockCorrection =
    requiredAction === "REMINDERS" &&
    reminderScheduleProvenance !== undefined &&
    isReminderClockCorrectionText(reminderIntentText) &&
    (!explicitResolution || isExplicitReminderUpdateIntent(reminderIntentText)) &&
    !isExplicitReminderCreationIntent(reminderIntentText);
  const reminderClearConfirmationChallenge = hasGroundedReminderClearChallenge(
    input.history,
    input.execution?.reminders?.delivery,
  );
  const reminderClearAllIntent =
    isExplicitReminderClearAllIntent(reminderIntentText) ||
    (reminderClearConfirmationChallenge && isShortReminderClearConfirmation(reminderIntentText));
  const trustedReminderIntent = trustedReminderOperationIntent(reminderIntentText);
  const trustedPredecessor = trustedReminderPredecessor(
    input.history,
    input.execution?.reminders?.delivery,
  );
  const contextualIntent = isContextualReminderFollowup(input)
    ? contextualReminderIntent(reminderIntentText, trustedPredecessor)
    : undefined;
  const reminderOperationIntent = trustedReminderIntent?.operation ?? contextualIntent?.operation;
  const reminderTargetIntent = reminderClockCorrection
    ? reminderScheduleProvenance?.taskIds[0]
    : (trustedReminderIntent?.target ?? contextualIntent?.target);
  const expectedReminderOperation = reminderClearAllIntent
    ? "clear"
    : reminderClockCorrection
      ? "update"
      : reminderOperationIntent;
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

  const realtimeRequirement =
    actionsEnabled && publicSearchText
      ? resolveSharedRealtimeRequirement(publicSearchText, input.history)
      : undefined;
  const trustedRealtimeIntent =
    actionsEnabled && publicSearchText
      ? hasSharedRealtimeIntent(publicSearchText, input.history)
      : false;
  const untrustedRealtimeIntent =
    actionsEnabled && !publicSearchText ? hasSharedRealtimeIntent(message, input.history) : false;
  let realtimeActionResults: ActionResult[] | undefined;
  let realtimeGrounding: SharedRuntimePublicGrounding | undefined;
  if (realtimeRequirement) {
    let searchResult: ActionResult;
    try {
      searchResult = await runWebSearchEdge(realtimeRequirement.query);
    } catch (error) {
      // error-policy:J4 current-data lookup failures become an explicit,
      // visibly unavailable receipt; the model never receives fake success.
      logger.warn("[runSharedAgentTurn] current public-data preflight failed", {
        errorType: error instanceof Error ? error.name : typeof error,
        domain: realtimeRequirement.domain,
      });
      searchResult = {
        success: false,
        text: "Live public data is temporarily unavailable.",
        error: "Live public data is temporarily unavailable.",
        data: {
          actionName: "WEB_SEARCH",
          query: realtimeRequirement.query,
          observedAt: Date.now(),
        },
      };
    }
    const traceableResult = requireTraceableRealtimeSearch(searchResult, realtimeRequirement.query);
    realtimeActionResults = [traceableResult];
    realtimeGrounding = sharedPublicWebGrounding(realtimeActionResults);
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
              webSearch: Boolean(realtimeRequirement),
              reminders: remindersEnabled,
              todos: todosEnabled,
              media: actionsEnabled && Boolean(execution.media),
              transport: sharedCapabilityTransportForSource(
                execution.channel.source,
                execution.channel.type,
              ),
            },
            input.recallContext,
            capabilityWall ? [capabilityWall] : blockedSecondary,
            requiredAction,
            reminderClockCorrection,
            realtimeGrounding,
          ),
        },
        execution,
        agentKey: execution.agentKey,
        model: modelId,
        reminderClockCorrection,
        reminderClearConfirmationChallenge,
        reminderClearAllIntent,
        reminderOperationIntent,
        reminderTargetIntent,
        ...(realtimeGrounding ? { realtimeGrounding } : {}),
        ...(realtimeActionResults ? { preflightActionResults: realtimeActionResults } : {}),
      }),
      capabilityWall,
      blockedSecondary,
    );
    if (realtimeActionResults) {
      const runtimeActionResults = (turn.actionResults ?? []).filter(
        (result) => !isWebSearchActionResult(result),
      );
      turn = { ...turn, actionResults: [...realtimeActionResults, ...runtimeActionResults] };
    }
    if (
      requiredAction &&
      !hasRequiredActionResult(
        turn,
        requiredAction,
        requiredAction === "REMINDERS" ? expectedReminderOperation : undefined,
      )
    ) {
      throw new Error(
        `Eliza Shared runtime completed an executable ${requiredAction} request without an action result`,
      );
    }
  } catch (error) {
    // error-policy:J2 the runtime is the sole inference engine; preserve its
    // cause while adding the agent/model identity used by billing boundaries.
    throw new SharedRuntimeTurnError(
      `[shared-runtime] AgentRuntime turn failed (agent=${input.character.name}, model=${modelId})`,
      error,
    );
  }
  if (realtimeRequirement) {
    const groundedReply = finalizeSharedRealtimeReply(turn.reply, realtimeGrounding);
    const history = [...turn.history];
    let replaced = false;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index].role !== "assistant") continue;
      history[index] = {
        ...history[index],
        content: groundedReply,
        ...(realtimeGrounding ? { grounding: realtimeGrounding } : {}),
      };
      replaced = true;
      break;
    }
    if (!replaced) {
      history.push({
        id: input.messageIds?.assistant,
        role: "assistant",
        content: groundedReply,
        createdAt: Date.now(),
        ...(realtimeGrounding ? { grounding: realtimeGrounding } : {}),
      });
    }
    const actionResults = [
      ...(realtimeGrounding
        ? [sharedRealtimeTransportReceipt(realtimeGrounding, groundedReply)]
        : []),
      ...(turn.actionResults ?? []).filter((result) => !isWebSearchActionResult(result)),
    ];
    turn = {
      ...turn,
      reply: groundedReply,
      responded: true,
      history,
      ...(actionResults.length ? { actionResults } : {}),
      ...(realtimeGrounding ? { internalGrounding: realtimeGrounding } : {}),
    };
  } else if (trustedRealtimeIntent || untrustedRealtimeIntent) {
    const groundedReply = finalizeSharedRealtimeReply(turn.reply, undefined);
    const history = [...turn.history];
    const assistantIndex = history.findLastIndex((entry) => entry.role === "assistant");
    if (assistantIndex >= 0) {
      history[assistantIndex] = { ...history[assistantIndex], content: groundedReply };
    } else {
      history.push({
        id: input.messageIds?.assistant,
        role: "assistant",
        content: groundedReply,
        createdAt: Date.now(),
      });
    }
    turn = { ...turn, reply: groundedReply, responded: true, history };
  }
  // The durable memory commit runs OUTSIDE the provider try/catch: its failure
  // is a storage fault on an already-landed reply and must not be re-labeled
  // as a provider outcome for the caller's settlement classification.
  turn = withReminderActionProvenance(turn, input);
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
  const publicSearchText = input.capabilityText?.trim();

  const actionsEnabled = input.messageRole !== "system";
  const remindersEnabled = actionsEnabled && Boolean(input.execution?.reminders);
  const todosEnabled = actionsEnabled && Boolean(input.execution?.todos);
  const capabilities = {
    reminders: remindersEnabled,
    todos: todosEnabled,
  };
  const reminderIntentText = input.capabilityText ?? input.message;
  const explicitResolution = resolveSharedCapabilityIntent(reminderIntentText, capabilities);
  const resolution = capabilityResolution(input, capabilities, explicitResolution);
  const requiredAction = requiredActionForTurn(input, resolution, actionsEnabled);
  const reminderScheduleProvenance = groundedReminderSchedule(
    input.history,
    input.execution?.reminders?.delivery,
  );
  const reminderClockCorrection =
    requiredAction === "REMINDERS" &&
    reminderScheduleProvenance !== undefined &&
    isReminderClockCorrectionText(reminderIntentText) &&
    (!explicitResolution || isExplicitReminderUpdateIntent(reminderIntentText)) &&
    !isExplicitReminderCreationIntent(reminderIntentText);
  const reminderClearConfirmationChallenge = hasGroundedReminderClearChallenge(
    input.history,
    input.execution?.reminders?.delivery,
  );
  const reminderClearAllIntent =
    isExplicitReminderClearAllIntent(reminderIntentText) ||
    (reminderClearConfirmationChallenge && isShortReminderClearConfirmation(reminderIntentText));
  const trustedReminderIntent = trustedReminderOperationIntent(reminderIntentText);
  const trustedPredecessor = trustedReminderPredecessor(
    input.history,
    input.execution?.reminders?.delivery,
  );
  const contextualIntent = isContextualReminderFollowup(input)
    ? contextualReminderIntent(reminderIntentText, trustedPredecessor)
    : undefined;
  const reminderOperationIntent = trustedReminderIntent?.operation ?? contextualIntent?.operation;
  const reminderTargetIntent = reminderClockCorrection
    ? reminderScheduleProvenance?.taskIds[0]
    : (trustedReminderIntent?.target ?? contextualIntent?.target);
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

  // Current-data answers are buffered until their complete grounded reply has
  // passed validation; streaming an unverified numeric claim cannot be undone.
  if (
    requiredAction ||
    (actionsEnabled &&
      ((publicSearchText && hasSharedRealtimeIntent(publicSearchText, input.history)) ||
        (!publicSearchText && hasSharedRealtimeIntent(message, input.history))))
  ) {
    const turn = await runSharedAgentTurn(input);
    const parts = (async function* (): AsyncIterable<SharedAgentTurnStreamPart> {
      if (turn.reply) yield { type: "text-delta", text: turn.reply };
      yield {
        type: "finish",
        text: turn.reply,
        ...(turn.responded === false ? { responded: false } : {}),
        ...(turn.usage ? { usage: turn.usage } : {}),
        ...(turn.actionResults?.length ? { actionResults: turn.actionResults } : {}),
        ...(turn.timing ? { timing: turn.timing } : {}),
      };
    })();
    return {
      model: turn.model,
      degraded: turn.degraded,
      reply: turn.reply,
      history: turn.history,
      ...(turn.actionResults?.length ? { actionResults: turn.actionResults } : {}),
      ...(turn.internalGrounding ? { internalGrounding: turn.internalGrounding } : {}),
      ...(turn.capabilityWall ? { capabilityWall: turn.capabilityWall } : {}),
      ...(turn.blockedSecondaryCapabilities?.length
        ? {
            blockedSecondaryCapabilities: turn.blockedSecondaryCapabilities,
          }
        : {}),
      parts,
    };
  }

  try {
    const execution = resolveRuntimeExecution(input);
    const { runSharedElizaRuntimeTurnStream } = await import("./shared-eliza-runtime");
    const stream = await runSharedElizaRuntimeTurnStream({
      ...input,
      character: {
        ...input.character,
        system: buildSharedRuntimeSystem(
          input.character,
          {
            // A current-data request already took the buffered path above.
            // Ordinary streamed turns must never expose a public-network tool.
            webSearch: false,
            reminders: remindersEnabled,
            todos: todosEnabled,
            media: actionsEnabled && Boolean(execution.media),
            transport: sharedCapabilityTransportForSource(
              execution.channel.source,
              execution.channel.type,
            ),
          },
          input.recallContext,
          capabilityWall ? [capabilityWall] : blockedSecondary,
          requiredAction,
          reminderClockCorrection,
        ),
      },
      execution,
      agentKey: execution.agentKey,
      model: modelId,
      reminderClockCorrection,
      reminderClearConfirmationChallenge,
      reminderClearAllIntent,
      reminderOperationIntent,
      reminderTargetIntent,
    });
    return withStreamCapabilityResolution(stream, capabilityWall, blockedSecondary);
  } catch (error) {
    // error-policy:J2 no SSE bytes exist during setup, so retain the exact
    // runtime cause and add stable billing/diagnostic context for the caller.
    throw new Error(
      `[shared-runtime] AgentRuntime stream setup failed (agent=${input.character.name}, model=${modelId})`,
      { cause: error },
    );
  }
}
