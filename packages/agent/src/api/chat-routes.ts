/**
 * Chat route handlers extracted from server.ts.
 *
 * Handles:
 *   POST /v1/chat/completions   – OpenAI-compatible
 *   POST /v1/messages           – Anthropic-compatible
 *   GET  /v1/models             – OpenAI model listing
 *   GET  /v1/models/:id         – OpenAI single model
 *
 * Also exports generateChatResponse() and supporting helpers so that
 * conversation-routes.ts (and server.ts itself) can reuse them.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { isDeepStrictEqual } from "node:util";
import {
  type ActionResult,
  type AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  ChannelType,
  type Content,
  createMessageMemory,
  drainRoomPostDeliveryTasks,
  ElizaError,
  EventType,
  emitInferenceTiming,
  executePlannedToolCall,
  getInferenceTimer,
  getSwarmCoordinatorService,
  hasAppliedUserFacingEffectProof,
  INFERENCE_MARKS,
  INSUFFICIENT_CREDITS_REPLY,
  InferenceTurnTimer,
  isRateLimitError,
  isTextGenerationModelType,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
  type MessageMetadata,
  ModelType,
  markInference,
  nextInferenceTurnId,
  persistInferenceTimingSummary,
  type RolesWorldMetadata,
  type RoomHandlerLease,
  type RouteRequestContext,
  recordOwnerGrant,
  renderInteractionsAsPlainText,
  revertedEffectReceiptIds,
  runWithInferenceTiming,
  runWithTrajectoryContext,
  stringToUuid,
  stripDashboardOnlyMarkers,
  type TrustedApiPrincipal,
  tagsMayProduceEffects,
  timeInferenceSpan,
  toWellFormedUnicode,
  trackPostDeliveryTask,
  truncateWellFormed,
  type UUID,
} from "@elizaos/core";
import type {
  ChatFailureKind,
  ChatToolCallEvent,
  ChatTurnStatus,
  LinkedAccountProviderId,
  LogEntry,
  ReadJsonBodyOptions,
} from "@elizaos/shared";
import {
  asRecord,
  DELTA_STREAM_PROTOCOL,
  extractAssistantReplyText,
  isLinkedAccountProviderId,
  normalizeCharacterLanguage,
  parseChatFailureKind,
  readAliasedEnv,
  resolveStreamingUpdate,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import {
  type CapturedModelUsage,
  estimateTokenCount,
  withModelUsageCapture,
} from "../runtime/prompt-optimization.ts";
import { resolveTrajectoryGrouping } from "../runtime/trajectory-internals.ts";
import { startTrajectoryStepInDatabase } from "../runtime/trajectory-storage.ts";
import { syncCharacterIntoConfig } from "../services/character-persistence.ts";
import {
  type ChatIdempotencyAdmission,
  type ChatIdempotencyReservation,
  ChatIdempotencyWaitAbortedError,
  createChatIdempotencyStore,
} from "../services/chat-idempotency-service.ts";
import { detectRuntimeModel } from "./agent-model.ts";
import {
  maybeAugmentChatMessageWithDocuments,
  maybeAugmentChatMessageWithLanguage,
} from "./chat-augmentation.ts";
import {
  isClientVisibleNoResponse,
  isNoResponsePlaceholder,
} from "./chat-text-helpers.ts";
import { resolveClientChatAdminEntityId } from "./client-chat-admin.ts";
import {
  extractAnthropicSystemAndLastUser,
  extractCompatTextContent,
  extractOpenAiSystemAndLastUser,
  resolveCompatRoomKey,
} from "./compat-utils.ts";
import {
  isInsufficientCreditsError,
  isInsufficientCreditsMessage,
} from "./credit-detection.ts";
import {
  executeFallbackParsedActions,
  parseFallbackActionBlocks,
} from "./fallback-action-helpers.ts";
import {
  type LocalInferenceChatMetadata,
  type LocalInferenceCommandIntent,
  type LocalInferenceRouteApi,
  loadLocalInferenceRouteApi,
} from "./local-inference-server-api.ts";
import {
  buildWalletActionNotExecutedReply,
  cloneWithoutBlockedObjectKeys,
  decodePathComponent,
  getErrorMessage,
  hasBlockedObjectKeyDeep,
  isWalletActionRequiredIntent,
  maybeAugmentChatMessageWithWalletContext,
  normalizeIncomingChatPrompt,
  resolveAppUserName,
  trimWalletProgressPrefix,
  validateChatImages,
} from "./server-helpers.ts";
import {
  isAuthorized,
  isServerTokenAuthorized,
} from "./server-helpers-auth.ts";
import type { ChatImageAttachment } from "./server-types.ts";

export type { ChatImageAttachment, LogEntry };

const CHAT_APPEND_ONLY_STREAM_DIVERGENCE = "CHAT_APPEND_ONLY_STREAM_DIVERGENCE";
type LocalInferenceChatApi = Pick<
  LocalInferenceRouteApi,
  "getLocalInferenceChatStatus" | "handleLocalInferenceChatCommand"
>;

interface StreamingResponseAbortTracker {
  signal: AbortSignal;
  dispose: () => void;
  markCompleted: () => void;
}

type AbortEventSource = {
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
};

function createStreamingResponseAbortTracker(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  operation: string,
): StreamingResponseAbortTracker {
  const controller = new AbortController();
  const registrations: Array<{
    source: AbortEventSource;
    event: string;
    listener: () => void;
  }> = [];
  let completed = false;

  const abort = () => {
    if (!completed && !controller.signal.aborted) {
      controller.abort(new Error(`${operation} client disconnected`));
    }
  };
  const register = (
    source: AbortEventSource | null | undefined,
    event: string,
    listener: () => void,
  ) => {
    if (typeof source?.on !== "function") return;
    source.on(event, listener);
    registrations.push({ source, event, listener });
  };
  const onResponseClose = () => {
    if (!res.writableEnded) abort();
  };

  // IncomingMessage.close describes request-body completion on current Node
  // and Bun releases, not the lifetime of the streamed response. The response
  // and socket events remain live after body parsing and therefore own
  // disconnect cancellation.
  register(req, "aborted", abort);
  register(req, "error", abort);
  register(res, "close", onResponseClose);
  register(res, "error", abort);
  register(req.socket, "close", abort);
  register(req.socket, "error", abort);

  if (req.aborted || req.destroyed || res.destroyed) {
    abort();
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const { source, event, listener } of registrations) {
        source.off?.(event, listener);
      }
      registrations.length = 0;
    },
    markCompleted: () => {
      completed = true;
    },
  };
}

let localInferenceChatApiPromise: Promise<LocalInferenceChatApi> | null = null;

/**
 * Resolve the plugin-local-inference chat API used to turn a local-inference
 * failure into a user-facing status (download prompts, switch-model hints, …).
 *
 * An error-reporting path must NEVER throw. On any platform the loaded module
 * can carry an `undefined` named export (tree-shake / circular-init artifact) —
 * which previously made the catch blocks throw
 * `getLocalInferenceChatStatus is not a function` and MASK the real error. So
 * validate the loaded functions and fall back to a status derived from the raw
 * error, guaranteeing the actual failure surfaces. The always-real subpath is
 * owned by `./local-inference-server-api.ts`.
 */
function getLocalInferenceChatApi(): Promise<LocalInferenceChatApi> {
  localInferenceChatApiPromise ??=
    (async (): Promise<LocalInferenceChatApi> => {
      const fallback: LocalInferenceChatApi = {
        getLocalInferenceChatStatus: async (_intent, error) => ({
          text:
            error instanceof Error
              ? error.message
              : typeof error === "string" && error
                ? error
                : "Local inference is unavailable.",
          localInference: {},
        }),
        handleLocalInferenceChatCommand: async (_intent, prompt) => ({
          text: prompt,
          localInference: {},
        }),
      };
      try {
        const mod =
          (await loadLocalInferenceRouteApi()) as Partial<LocalInferenceChatApi>;
        return {
          getLocalInferenceChatStatus:
            typeof mod.getLocalInferenceChatStatus === "function"
              ? mod.getLocalInferenceChatStatus
              : fallback.getLocalInferenceChatStatus,
          handleLocalInferenceChatCommand:
            typeof mod.handleLocalInferenceChatCommand === "function"
              ? mod.handleLocalInferenceChatCommand
              : fallback.handleLocalInferenceChatCommand,
        };
      } catch {
        return fallback;
      }
    })();
  return localInferenceChatApiPromise;
}

const CHAT_MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB (image-capable)

/**
 * Short-window idempotency cache for the HTTP chat path, the analogue of the
 * WebSocket `isDuplicateWsMessage` cache in server.ts. Chat sends go over HTTP
 * SSE (not WS), so the WS cache does not cover them. The client stamps a stable
 * `clientMessageId` on every send (`ui/src/api/client-base.ts`); a retried or
 * double-submitted POST carries the same id, and without this guard would start
 * a second LLM turn and persist a duplicate assistant memory (report 05,
 * Finding 1 / W3.1).
 *
 * Keyed by `${conversationOrUserScope}:${clientMessageId}` so a legitimately
 * identical message in a different conversation, or the same text re-sent after
 * the retention window, is NOT suppressed. The map stays bounded via an
 * amortized sweep (at most once per retention window) — the same O(1)-check /
 * amortized-eviction shape as the WS cache. This window only retains keys; it
 * never delays or aborts a response.
 */
export interface ChatMessageIdOutcome {
  text: string;
  agentName: string;
  messageId?: UUID;
  userMessageId?: UUID;
  assistantEphemeral?: boolean;
  historyRefreshRequired?: boolean;
  transcriptVisibility?: "internal";
  thought?: string;
  usage?: ChatGenerationResult["usage"];
  actionResults?: ChatActionResultSummary[];
  failureKind?: ChatFailureKind;
  accountConnect?: AccountConnectRequest;
  localInference?: LocalInferenceChatMetadata;
  noResponseReason?: "ignored";
  /**
   * The turn ended by explicit Stop/disconnect abort. `text` carries the
   * partial reply that streamed before the abort (possibly empty for a
   * zero-token Stop) and `messageId` its durable interrupted receipt, so a
   * retried key adopts the interrupted outcome instead of regenerating.
   */
  interrupted?: boolean;
}

const chatIdempotency = createChatIdempotencyStore<ChatMessageIdOutcome>();

export type ChatMessageIdAdmission =
  ChatIdempotencyAdmission<ChatMessageIdOutcome>;
export type ChatMessageIdReservation = ChatIdempotencyReservation;
export { ChatIdempotencyWaitAbortedError };

/** Join an active keyed turn, replay its durable result, or own a fresh turn. */
export function admitChatMessageId(
  scope: string,
  clientMessageId: string | null,
  options: { fingerprint?: string; now?: number } = {},
): ChatMessageIdAdmission {
  return chatIdempotency.admit(scope, clientMessageId, options);
}

/** Normalize a raw body value into a usable idempotency key, or `null` when
 *  absent/invalid. Exported for unit testing the dedupe decision in isolation. */
export function normalizeClientMessageId(value: unknown): string | null {
  return chatIdempotency.normalize(value);
}

/**
 * Lifecycle-aware O(1) duplicate check for an HTTP chat send. Active turns
 * remain reserved until their owner either settles or explicitly releases the
 * key; they must not become duplicate work merely because generation is slow.
 * Settled outcomes remain replayable for a bounded retention period.
 *
 * `scope` is the conversation room id (dashboard chat) or the per-user room key
 * (agent-message API) so the key cannot collide across conversations/users.
 */
export function isDuplicateChatMessage(
  scope: string,
  clientMessageId: string | null,
  now: number = Date.now(),
): boolean {
  return chatIdempotency.reserve(scope, clientMessageId, now);
}

/**
 * Roll back an idempotency key recorded by {@link isDuplicateChatMessage}.
 *
 * The guard records at request ARRIVAL (so a duplicate landing while the
 * original is still mid-turn is suppressed — that's the blip-retry window it
 * exists for). But when the original turn dies WITHOUT persisting a visible
 * assistant reply — a client disconnect aborts generation, or an error hits
 * after a disconnect so no fallback reply is persisted — a suppressed retry
 * would eat the user's message entirely: no reply, no error, no retry chip.
 * Callers release the key on exactly those paths so the client's single
 * auto-retry legitimately re-runs the turn (it is not a duplicate of any
 * delivered outcome). Releasing is always safe: the worst case is the
 * pre-guard behavior (a second turn) on a turn that produced nothing.
 */
export function releaseChatMessageId(
  scope: string,
  clientMessageId: string | null,
  reservation?: ChatMessageIdReservation | null,
): void {
  chatIdempotency.release(scope, clientMessageId, reservation);
}

/**
 * Original arrival timestamp recorded for a `(scope, clientMessageId)` pair,
 * or `null` when the pair is unknown (never seen, expired and swept, or
 * released). A duplicate sighting never refreshes it, so diagnostics and
 * focused cache tests can distinguish the first request from later retries.
 */
export function getChatMessageIdFirstSeenAt(
  scope: string,
  clientMessageId: string | null,
): number | null {
  return chatIdempotency.firstSeenAt(scope, clientMessageId);
}

/**
 * Bind the durable terminal result to the exact client idempotency key.
 *
 * A room-level "latest assistant memory" lookup cannot identify which of two
 * concurrent turns produced a reply. The first request records its result only
 * after that result is durable; a retry can then replay this exact outcome
 * without starting another model turn or borrowing a neighboring turn.
 */
export function setChatMessageIdOutcome(
  scope: string,
  clientMessageId: string | null,
  outcome: ChatMessageIdOutcome,
  reservation?: ChatMessageIdReservation | null,
): void {
  chatIdempotency.settle(scope, clientMessageId, outcome, reservation);
}

/** Return the durable outcome bound to an exact idempotency key, if settled. */
export function getChatMessageIdOutcome(
  scope: string,
  clientMessageId: string | null,
): ChatMessageIdOutcome | null {
  return chatIdempotency.outcome(scope, clientMessageId);
}

/** Test-only: clear the HTTP chat idempotency cache between cases. */
export function __resetChatDedupeForTests(): void {
  chatIdempotency.reset();
}

/** Test-only: expose the configured dedupe window without freezing env policy
 *  into the unit fixtures. */
export function __getChatDedupeTtlMsForTests(): number {
  return chatIdempotency.retentionMs;
}

const ANDROID_LOCAL_DIRECT_CHAT_DENY_PATTERN =
  /\b(check|search|find|fetch|get|look\s+up|browse|open|click|call|email|send|create|update|delete|save|remember|schedule|remind|set|run|execute|install|download|upload|read|inspect|build|deploy|commit|push|pull|merge|rebase|book|pay|buy|order)\b/i;

const ANDROID_LOCAL_CURRENT_DATA_PATTERN =
  /\b(latest|current|today|tomorrow|yesterday|weather|price|calendar|email|file|repo|repository|log|logs|issue|issues|pr|pull\s+request|wallet|transaction|account|contact|contacts)\b/i;

const ANDROID_LOCAL_CONTEXTUAL_MEMORY_PATTERN =
  /\b(what\s+did\s+i\s+just\s+say|what\s+(?:is|'s)\s+my\s+name|who\s+am\s+i|do\s+you\s+remember|remember\s+(?:me|my|that)|what\s+was\s+my|what\s+did\s+we|previous(?:ly)?|earlier|last\s+(?:message|thing|question|conversation)|recent\s+(?:message|conversation)|my\s+(?:name|email|address|phone|preference|preferences))\b/i;

function readRuntimeStringSetting(
  runtime: AgentRuntime,
  key: string,
): string | null {
  const setting =
    typeof runtime.getSetting === "function" ? runtime.getSetting(key) : null;
  if (typeof setting === "string" && setting.trim().length > 0) {
    return setting.trim();
  }
  if (typeof setting === "number" || typeof setting === "boolean") {
    return String(setting);
  }
  const env = process.env[key];
  return typeof env === "string" && env.trim().length > 0 ? env.trim() : null;
}

function readPositiveIntegerSetting(
  runtime: AgentRuntime,
  key: string,
  fallback: number,
): number {
  const raw = readRuntimeStringSetting(runtime, key);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isAndroidLocalDirectChatRuntime(runtime: AgentRuntime): boolean {
  const optIn = readRuntimeStringSetting(
    runtime,
    "ELIZA_MOBILE_LOCAL_DIRECT_REPLY",
  );
  // A native device bridge says where capabilities execute, not which model
  // owns conversation. Bypassing the full Eliza planner is therefore explicit
  // opt-in; merely connecting an Android/iOS bridge must keep chat on the host
  // runtime and its configured model providers.
  if (!/^(1|true|yes|on)$/i.test(optIn ?? "")) {
    return false;
  }
  const platform =
    readRuntimeStringSetting(runtime, "ELIZA_MOBILE_PLATFORM") ??
    readRuntimeStringSetting(runtime, "ELIZA_PLATFORM");
  const normalizedPlatform = platform?.toLowerCase();
  const localLlama =
    readRuntimeStringSetting(runtime, "ELIZA_LOCAL_LLAMA") === "1" ||
    readRuntimeStringSetting(runtime, "ELIZA_DEVICE_BRIDGE_ENABLED") === "1" ||
    readRuntimeStringSetting(runtime, "ELIZA_IOS_LOCAL_BACKEND") === "1";
  return (
    (normalizedPlatform === "android" || normalizedPlatform === "ios") &&
    localLlama
  );
}

function hasAndroidLocalDirectChatBlockingContent(
  content: Content & Record<string, unknown>,
): boolean {
  if (Array.isArray(content.attachments) && content.attachments.length > 0) {
    return true;
  }
  if (Array.isArray(content.media) && content.media.length > 0) {
    return true;
  }
  if (Array.isArray(content.files) && content.files.length > 0) {
    return true;
  }
  if (content.documentIds || content.documents || content.localInference) {
    return true;
  }
  const metadata =
    content.metadata && typeof content.metadata === "object"
      ? (content.metadata as Record<string, unknown>)
      : {};
  return Boolean(
    metadata.benchmark || metadata.localInference || metadata.contextRouting,
  );
}

function isAndroidLocalDirectChatChannel(content: Content): boolean {
  const channelType = (content as Record<string, unknown>).channelType;
  return (
    channelType === ChannelType.API ||
    channelType === ChannelType.DM ||
    channelType === ChannelType.SELF ||
    channelType === ChannelType.VOICE_DM ||
    channelType === undefined
  );
}

function shouldUseAndroidLocalDirectChat(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): boolean {
  if (!isAndroidLocalDirectChatRuntime(runtime)) {
    return false;
  }
  const text = normalizeAndroidLocalDirectUserText(
    extractCompatTextContent(message.content),
  );
  if (!text || text.length > 700) {
    return false;
  }
  if (!isAndroidLocalDirectChatChannel(message.content)) {
    return false;
  }
  if (
    hasAndroidLocalDirectChatBlockingContent(
      message.content as Content & Record<string, unknown>,
    )
  ) {
    return false;
  }
  if (ANDROID_LOCAL_DIRECT_CHAT_DENY_PATTERN.test(text)) {
    return false;
  }
  if (ANDROID_LOCAL_CONTEXTUAL_MEMORY_PATTERN.test(text)) {
    return false;
  }
  if (ANDROID_LOCAL_CURRENT_DATA_PATTERN.test(text)) {
    return /\b(local|locally|on[-\s]?device|device|pixel|eliza[-\s]?1|llama)\b/i.test(
      text,
    );
  }
  return true;
}

function escapeAndroidLocalChatTemplateTokens(text: string): string {
  return text
    .replaceAll("<start_of_turn>", "< start_of_turn >")
    .replaceAll("<end_of_turn>", "< end_of_turn >")
    .replaceAll("<|im_start|>", "<| im_start |>")
    .replaceAll("<|im_end|>", "<| im_end |>")
    .replaceAll("<think>", "< think >")
    .replaceAll("</think>", "</ think >");
}

function normalizeAndroidLocalDirectUserText(text: string): string {
  return text
    .replace(/(^|\s)\/(?:no_)?think\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compareCreatedAtAscending(
  left: { createdAt?: number },
  right: { createdAt?: number },
): number {
  if (left.createdAt === right.createdAt) return 0;
  if (left.createdAt === undefined) return -1;
  if (right.createdAt === undefined) return 1;
  return left.createdAt - right.createdAt;
}

async function buildAndroidLocalDirectChatPrompt(args: {
  runtime: AgentRuntime;
  message: ReturnType<typeof createMessageMemory>;
  userText: string;
}): Promise<string | null> {
  let history: string[] = [];
  try {
    const recent = await args.runtime.getMemories({
      roomId: args.message.roomId,
      tableName: "messages",
      includeEmbedding: false,
    });
    history = recent
      .filter((memory) => memory.id !== args.message.id)
      .sort(compareCreatedAtAscending)
      .flatMap((memory) => {
        const text = extractCompatTextContent(memory.content).trim();
        if (!text) return [];
        const role =
          memory.entityId === args.runtime.agentId ? "Assistant" : "User";
        return [`${role}: ${escapeAndroidLocalChatTemplateTokens(text)}`];
      });
  } catch (err) {
    // error-policy:J7 diagnostics-must-not-kill-the-loop — the full message
    // runtime remains a correct fallback, but the failed memory path must still
    // reach RECENT_ERRORS and owner escalation instead of disappearing in logcat.
    args.runtime.reportError("AndroidLocalDirectChat.history", err, {
      roomId: args.message.roomId,
      messageId: args.message.id,
    });
    args.runtime.logger.warn(
      { src: "eliza-api", err },
      "[eliza-api] Android local direct chat history unavailable; using normal runtime",
    );
    return null;
  }

  const systemText = [
    "Eliza-1 on device.",
    "Answer in 1-3 concise, natural spoken sentences.",
    "If asked local/on-device: yes, local Eliza-1.",
    "No markdown, labels, tools, logs, or hidden reasoning.",
  ].join("\n");
  return [
    "<start_of_turn>user",
    systemText,
    ...(history.length > 0
      ? ["", "Recent conversation (oldest to newest):", ...history]
      : []),
    "",
    escapeAndroidLocalChatTemplateTokens(args.userText),
    "<end_of_turn>",
    "<start_of_turn>model",
    // Match the Gemma thinking-disabled chat-template shape.
    // The direct mobile path is for short voice/chat replies; pre-filling an
    // empty think block prevents the model from spending its first tokens on
    // hidden `<think>...</think>` scaffolding before any speakable text.
    "<think>",
    "",
    "</think>",
    "",
  ].join("\n");
}

function extractAndroidLocalModelText(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (!raw || typeof raw !== "object") {
    return "";
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    return record.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const partRecord = part as Record<string, unknown>;
          return typeof partRecord.text === "string" ? partRecord.text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function stripAndroidLocalReasoning(text: string): string {
  let next = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const danglingClose = next.lastIndexOf("</think>");
  if (danglingClose >= 0) {
    next = next.slice(danglingClose + "</think>".length);
  }
  const danglingOpen = next.indexOf("<think>");
  if (danglingOpen >= 0) {
    next = next.slice(0, danglingOpen);
  }
  return next;
}

function cleanAndroidLocalDirectChatReply(raw: unknown): string {
  let text = stripAndroidLocalReasoning(extractAndroidLocalModelText(raw));
  text = text
    .split("<end_of_turn>")[0]
    .split("<start_of_turn>")[0]
    .split("<|im_end|>")[0]
    .split("<|im_start|>")[0]
    .replace(/^\s*(assistant|model|eliza)\s*:\s*/i, "")
    .replace(/\bEliza-1\b/gi, "Eliza-1")
    .trim();
  text = text.replace(/\s+/g, " ").trim();
  return toWellFormedUnicode(text);
}

async function rewriteDirectActionCallbackText(args: {
  runtime: AgentRuntime;
  actionName: string;
  text: string;
  content?: Content;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const text = args.text.trim();
  if (!text) return args.text;
  const fallback = () => {
    const error =
      typeof args.content?.error === "string" && args.content.error.trim()
        ? ` It reported: ${args.content.error.trim()}`
        : "";
    return `I ran ${args.actionName} and got a result, but I couldn't format the details cleanly here.${error}`;
  };
  if (args.abortSignal?.aborted) return fallback();
  try {
    const raw = await args.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: [
        "Rewrite this direct action callback in the assistant character's user-facing voice.",
        'Return strict JSON only: {"response":"..."}.',
        "",
        "Rules:",
        "- Preserve status, IDs, names, URLs, counts, errors, and next steps.",
        "- Do not expose raw JSON, shell output, schema names, stack traces, or internal action plumbing unless an exact value is necessary.",
        "- Do not claim success if the payload says failed or pending.",
        "- Keep it brief and natural.",
        "",
        `Character: ${JSON.stringify({
          name: args.runtime.character?.name,
          system: args.runtime.character?.system,
          bio: args.runtime.character?.bio,
          style: args.runtime.character?.style,
        })}`,
        `Action: ${JSON.stringify(args.actionName)}`,
        `Payload: ${JSON.stringify(text)}`,
        `Metadata: ${JSON.stringify({
          source: args.content?.source,
          actions: args.content?.actions,
          actionStatus: args.content?.actionStatus,
          error: args.content?.error,
        })}`,
      ].join("\n"),
      maxTokens: 260,
      signal: args.abortSignal,
      providerOptions: { eliza: { thinking: "off" } },
    });
    const parsed = JSON.parse(String(raw).trim()) as { response?: unknown };
    return typeof parsed.response === "string" && parsed.response.trim()
      ? parsed.response.trim()
      : fallback();
  } catch (err) {
    args.runtime.logger.debug(
      {
        src: "eliza-api",
        action: args.actionName,
        err: err instanceof Error ? err.message : String(err),
      },
      "[eliza-api] Direct action callback voice rewrite failed",
    );
    return fallback();
  }
}

async function maybeGenerateAndroidLocalDirectChatResponse(args: {
  runtime: AgentRuntime;
  message: ReturnType<typeof createMessageMemory>;
  agentName: string;
  signal: AbortSignal;
  opts?: ChatGenerateOptions;
}): Promise<ChatGenerationResult | null> {
  if (!shouldUseAndroidLocalDirectChat(args.runtime, args.message)) {
    return null;
  }
  const userText = normalizeAndroidLocalDirectUserText(
    extractCompatTextContent(args.message.content),
  );
  if (!userText) return null;
  const prompt = await buildAndroidLocalDirectChatPrompt({
    runtime: args.runtime,
    message: args.message,
    userText,
  });
  if (!prompt) return null;
  const maxTokens = readPositiveIntegerSetting(
    args.runtime,
    "ELIZA_MOBILE_LOCAL_DIRECT_REPLY_MAX_TOKENS",
    128,
  );
  const startedAt = Date.now();
  args.runtime.logger.info(
    {
      src: "eliza-api",
      promptChars: prompt.length,
      maxTokens,
      messageId: args.message.id,
    },
    "[eliza-api] Android local direct chat fast path start",
  );
  let streamedRaw = "";
  let lastStreamedSnapshot = "";
  let streamedChunks = 0;
  const emitCleanStreamingSnapshot = (snapshot: string): void => {
    if (!snapshot || snapshot === lastStreamedSnapshot) return;
    const update = resolveStreamingUpdate(lastStreamedSnapshot, snapshot);
    if (update.kind === "append") {
      args.opts?.onChunk?.(update.emittedText);
    } else if (update.kind === "replace" && !args.opts?.onSnapshot) {
      // OpenAI-compatible SSE cannot rewrite already-sent text. In the rare
      // case cleaning turns a partial local reply into a non-append snapshot,
      // hold the rewrite for the final response body instead of duplicating
      // content on the token stream.
      args.runtime.logger.debug(
        {
          src: "eliza-api",
          previousChars: lastStreamedSnapshot.length,
          nextChars: snapshot.length,
          messageId: args.message.id,
        },
        "[eliza-api] Android local direct chat fast path held non-append streaming snapshot",
      );
    }
    args.opts?.onSnapshot?.(snapshot);
    lastStreamedSnapshot = snapshot;
  };
  const raw = await args.runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    maxTokens,
    stopSequences: ["<end_of_turn>", "<start_of_turn>"],
    temperature: 0,
    providerOptions: {
      eliza: {
        thinking: "off",
      },
      androidLocal: {
        stopOnFirstSentence: false,
        minFirstSentenceChars: 12,
      },
    },
    signal: args.signal,
    stream: true,
    onStreamChunk: (chunk: string) => {
      streamedRaw += chunk;
      streamedChunks += 1;
      const snapshot = cleanAndroidLocalDirectChatReply(streamedRaw);
      emitCleanStreamingSnapshot(snapshot);
    },
  });
  const text = cleanAndroidLocalDirectChatReply(raw);
  if (!text) {
    args.runtime.logger.warn(
      { src: "eliza-api", messageId: args.message.id },
      "[eliza-api] Android local direct chat fast path returned empty text",
    );
    return null;
  }
  const latencyMs = Date.now() - startedAt;
  emitCleanStreamingSnapshot(text);
  const localInference = {
    provider: "mobile-local-direct-reply",
    mode: "api_fast_path",
    latencyMs,
    promptChars: prompt.length,
    maxTokens,
    streamedChunks,
  } satisfies LocalInferenceChatMetadata;
  const responseContent = {
    text,
    source: MESSAGE_SOURCE_CLIENT_CHAT,
    actions: ["REPLY"],
    localInference,
  } satisfies Content;
  args.runtime.logger.info(
    {
      src: "eliza-api",
      latencyMs,
      textChars: text.length,
      messageId: args.message.id,
    },
    "[eliza-api] Android local direct chat fast path done",
  );
  return {
    text,
    agentName: args.agentName,
    localInference,
    responseContent,
    usage: {
      promptTokens: estimateTokenCount(prompt),
      completionTokens: estimateTokenCount(text),
      totalTokens: estimateTokenCount(prompt) + estimateTokenCount(text),
      model: detectRuntimeModel(args.runtime, undefined) ?? undefined,
      provider: "mobile-local-direct-reply",
      isEstimated: true,
      llmCalls: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * "Connect another account" request an assistant turn can carry, emitted by the
 * CONNECT_ACCOUNT action when the user asks to add/log into an additional
 * provider account. Threaded to the client the same way `failureKind` is (a
 * structured field on the turn that round-trips), so the renderer can offer an
 * inline entry point into the existing `AddAccountDialog` flow.
 */
export interface AccountConnectRequest {
  providers: LinkedAccountProviderId[];
  reason?: string;
}

export interface ChatGenerationResult {
  text: string;
  agentName: string;
  /** Machine-only final text that must not render as assistant prose. */
  transcriptVisibility?: "internal";
  /** The agent's internal reasoning for this turn, when the model emitted one. */
  thought?: string;
  noResponseReason?: "ignored";
  failureKind?: ChatFailureKind;
  /** Structured "connect another account" request carried from the CONNECT_ACCOUNT action. */
  accountConnect?: AccountConnectRequest;
  localInference?: LocalInferenceChatMetadata;
  usedActionCallbacks?: boolean;
  actionCallbackHistory?: string[];
  actionResults?: ChatActionResultSummary[];
  responseContent?: Content | null;
  responseMessages?: Memory[];
  /** Exact response IDs durably committed by the message service before return. */
  persistedResponseMessageIds?: string[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    cachedInputTokens?: number;
    model?: string;
    provider?: string;
    isEstimated: boolean;
    llmCalls: number;
  };
}

export interface ChatActionResultSummary {
  actionName?: string;
  success: boolean;
  text?: string;
  error?: string;
  values?: Record<string, unknown>;
}

/**
 * Where a streamed text emission originated. `"model"` text is (or extends)
 * the turn's final reply; `"action_callback"` text is an in-flight action
 * status delivery that the turn's final reply may replace entirely. Voice
 * clients must not synthesize `"action_callback"` text until the terminal
 * frame confirms it — speech, unlike a chat bubble, cannot be retracted
 * (the "double-speak" defect: ack spoken, then the reply spoken again).
 */
export type ChatStreamTextOrigin = "model" | "action_callback";

export interface ChatGenerateOptions {
  onChunk?: (chunk: string, origin?: ChatStreamTextOrigin) => void;
  onSnapshot?: (text: string, origin?: ChatStreamTextOrigin) => void;
  /**
   * In-flight phase changes for the rich status indicator. Emitted additively
   * alongside `onChunk`/`onSnapshot` — `thinking` before the first visible
   * token, then `streaming` (LLM tokens) or `running_action` (an action handler
   * is producing the reply, carrying `actionName`). Never required for the reply
   * itself; a caller that omits it loses only the status surface.
   */
  onStatus?: (status: ChatTurnStatus) => void;
  /**
   * Inline tool/action-call steps for the chat thread's tool rows (#13535).
   * Forked from the runtime's native planner/tool stream — the same channel the
   * reply streams on — so a `call` is followed by its correlated `result`/
   * `error`. Additive; a caller that omits it loses only the inline tool surface.
   */
  onToolEvent?: (event: ChatToolCallEvent) => void;
  abortSignal?: AbortSignal;
  /** Existing runtime-validated ownership for a host's wider durable turn. */
  roomHandlerLease?: RoomHandlerLease;
  resolveNoResponseText?: () => string;
  preferredLanguage?: string;
}

const POST_COMMIT_INTERRUPTED_REPLY =
  "The action finished before the response was interrupted. It was not run again.";

function recoverSettledMutatingActionTurn(
  runtime: AgentRuntime,
  settledResults: readonly ActionResult[],
): {
  text: string;
  actionResults: ActionResult[];
  actionNames: string[];
} | null {
  const allReceipts = settledResults.flatMap(
    (result) => result.effectReceipts ?? [],
  );
  const revertedReceiptIds = revertedEffectReceiptIds(allReceipts);
  const actionByName = new Map(
    runtime.actions.map((action) => [action.name, action]),
  );
  const committedResults = settledResults.filter((result) => {
    const receipts = result.effectReceipts ?? [];
    const hasActiveAppliedReceipt = receipts.some(
      (receipt) =>
        receipt.outcome === "applied" &&
        !revertedReceiptIds.has(receipt.receiptId),
    );
    if (receipts.length > 0) return hasActiveAppliedReceipt;
    if (
      result.data?.reconciliationRequired === true &&
      result.data?.retryable === false
    ) {
      return true;
    }
    const actionName =
      typeof result.data?.actionName === "string" ? result.data.actionName : "";
    return (
      result.success !== false &&
      tagsMayProduceEffects(actionByName.get(actionName)?.tags)
    );
  });
  if (committedResults.length === 0) return null;

  let verifiedResult: ActionResult | undefined;
  try {
    verifiedResult = [...committedResults]
      .reverse()
      .find((result) => hasAppliedUserFacingEffectProof(result, allReceipts));
  } catch (error) {
    // error-policy:J4 conflicting receipt evidence degrades to the explicit
    // post-commit interruption reply rather than inventing action-specific text.
    runtime.logger.warn(
      {
        src: "eliza-api",
        error: getErrorMessage(error),
      },
      "Conflicting action receipts prevented exact post-commit reply recovery",
    );
  }
  const verifiedText = verifiedResult?.userFacingText?.trim();
  const actionNames = Array.from(
    new Set(
      committedResults
        .map((result) =>
          typeof result.data?.actionName === "string"
            ? result.data.actionName
            : "",
        )
        .filter((name) => name.length > 0),
    ),
  );
  return {
    text: verifiedText || POST_COMMIT_INTERRUPTED_REPLY,
    actionResults: [...settledResults],
    actionNames,
  };
}

function isAppendOnlyStreamDivergenceError(
  error: unknown,
): error is ElizaError {
  return (
    error instanceof ElizaError &&
    error.code === CHAT_APPEND_ONLY_STREAM_DIVERGENCE
  );
}

// LogEntry is canonical in @elizaos/shared and re-exported above.

type CallbackMergeMode = "append" | "replace";

function resolveCallbackMergeMode(
  content: Content,
  fallback: CallbackMergeMode = "replace",
): CallbackMergeMode {
  return content.merge === "append" || content.merge === "replace"
    ? content.merge
    : fallback;
}

function normalizeActionCallbackText(text: string): string {
  return text.trim();
}

function isInternalStructuredStreamPayload(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;

  const type = typeof record.type === "string" ? record.type : "";
  if (type === "tool_call" || type === "tool_result" || type === "tool_error") {
    return true;
  }

  if (type === "evaluation" && asRecord(record.evaluation)) {
    return true;
  }

  if (asRecord(record.toolCall) || asRecord(record.toolResult)) {
    return true;
  }

  const contextEvent = asRecord(record.contextEvent);
  if (contextEvent) {
    const contextType =
      typeof contextEvent.type === "string" ? contextEvent.type : "";
    if (
      contextType === "tool" ||
      contextType === "tool_result" ||
      contextType === "tool_error"
    ) {
      return true;
    }
  }

  return false;
}

function isInternalStructuredStreamText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    return isInternalStructuredStreamPayload(JSON.parse(trimmed));
  } catch {
    // error-policy:J3 an unparseable "{"-prefixed chunk is not a structured
    // payload — let it flow to the visible text path, which handles it.
    return false;
  }
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Coerce a tool-call's arguments (object, JSON string, or absent) into a plain
 *  record for the inline tool row, or undefined when there's nothing to show. */
function normalizeToolArgs(
  toolCall: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw = toolCall.arguments ?? toolCall.args ?? toolCall.input;
  const record = asRecord(raw);
  if (record) return record;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = asRecord(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      // error-policy:J3 a non-JSON args string is shown verbatim under `raw`.
      return { raw };
    }
  }
  return undefined;
}

/**
 * Project the runtime's internal planner/tool stream payload — forwarded through
 * `onStreamChunk` as a JSON string, then filtered out of the visible reply by
 * {@link isInternalStructuredStreamText} — onto the two chat surfaces it should
 * drive: the working-indicator phase (`running_tool` / `evaluating`) and, for
 * tool steps, an inline tool-call row. Returns null for payloads with no
 * chat-visible signal (e.g. `context_event`) so the caller drops them (#13535).
 */
export function chatEventsFromStructuredStreamPayload(
  payload: unknown,
): { status?: ChatTurnStatus; toolEvent?: ChatToolCallEvent } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const type = typeof record.type === "string" ? record.type : "";

  if (type === "tool_call") {
    const toolCall = asRecord(record.toolCall);
    if (!toolCall) return null;
    const toolName = firstNonEmptyString(
      toolCall.name,
      toolCall.toolName,
      toolCall.tool,
      toolCall.action,
    );
    if (!toolName) return null;
    const callId =
      firstNonEmptyString(toolCall.id, toolCall.toolCallId, record.messageId) ??
      toolName;
    const args = normalizeToolArgs(toolCall);
    return {
      status: { kind: "running_tool", toolName },
      toolEvent: {
        phase: "call",
        callId,
        toolName,
        ...(args ? { args } : {}),
      },
    };
  }

  if (type === "tool_result" || type === "tool_error") {
    const toolCall = asRecord(record.toolCall);
    const toolName =
      firstNonEmptyString(
        toolCall?.name,
        toolCall?.toolName,
        toolCall?.tool,
        toolCall?.action,
      ) ?? "tool";
    const callId =
      firstNonEmptyString(record.toolCallId, toolCall?.id, record.messageId) ??
      toolName;
    const statusText = firstNonEmptyString(record.status, toolCall?.status);
    const failed = type === "tool_error" || statusText === "failed";
    const result = record.result ?? toolCall?.result;
    const resultRecord = asRecord(result);
    const transcriptVisibility =
      resultRecord?.transcriptVisibility === "internal"
        ? ("internal" as const)
        : undefined;
    if (failed) {
      return {
        toolEvent: {
          phase: "error",
          callId,
          toolName,
          ...(transcriptVisibility ? { transcriptVisibility } : {}),
          error: firstNonEmptyString(result, statusText) ?? "tool failed",
        },
      };
    }
    return {
      toolEvent: {
        phase: "result",
        callId,
        toolName,
        ...(transcriptVisibility ? { transcriptVisibility } : {}),
        result,
      },
    };
  }

  if (type === "evaluation") {
    return { status: { kind: "evaluating" } };
  }

  return null;
}

/** Text-level companion to {@link chatEventsFromStructuredStreamPayload}: parse a
 *  raw stream chunk and, when it is an internal structured payload, return the
 *  chat events it drives. Null when the chunk is visible reply text or an
 *  internal payload with no chat-visible signal. */
function chatEventsFromStructuredStreamText(
  text: string,
): { status?: ChatTurnStatus; toolEvent?: ChatToolCallEvent } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // error-policy:J3 a non-JSON "{"-chunk is visible text, not a payload.
    return null;
  }
  if (!isInternalStructuredStreamPayload(parsed)) return null;
  return chatEventsFromStructuredStreamPayload(parsed);
}

function getLatestVisibleResponseMessageText(
  responseMessages:
    | Array<{
        id?: string;
        content?: Content;
      }>
    | undefined,
): string {
  if (!Array.isArray(responseMessages) || responseMessages.length === 0) {
    return "";
  }

  for (let index = responseMessages.length - 1; index >= 0; index -= 1) {
    const content = responseMessages[index]?.content;
    if (content?.transcriptVisibility === "internal") {
      continue;
    }
    const text =
      typeof extractCompatTextContent(content) === "string"
        ? extractCompatTextContent(content).trim()
        : "";
    if (!text || isNoResponsePlaceholder(text)) {
      continue;
    }
    return text;
  }

  return "";
}

const EXACT_GROUNDED_VALUE_REQUEST =
  /\b(?:exact|verbatim|copy|quoted?|identifier|codeword|return only|only the)\b/i;
const DOCUMENT_VALUE_CAPTURE =
  /\b(?:codeword|identifier|token|value)\s*(?:is|=|:)\s*([A-Za-z0-9][A-Za-z0-9._-]{1,127})\b/gi;
const UPPERCASE_IDENTIFIER_CAPTURE = /\b[A-Z0-9]+(?:[-_][A-Z0-9]+)+\b/g;
const UUID_IDENTIFIER_CAPTURE =
  /\b[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/gi;

function uniqueMatches(matches: Iterable<string>): string[] {
  return Array.from(
    new Set(Array.from(matches).map((value) => value.trim())),
  ).filter((value) => value.length > 0);
}

function collectRegexMatches(
  text: string,
  pattern: RegExp,
  groupIndex?: number,
): string[] {
  const regex = new RegExp(pattern.source, pattern.flags);
  return Array.from(text.matchAll(regex), (match) =>
    String(groupIndex === undefined ? match[0] : (match[groupIndex] ?? "")),
  );
}

function extractExactGroundedValueFromText(
  messageText: string,
  documentText: string,
): string | null {
  if (!messageText || !EXACT_GROUNDED_VALUE_REQUEST.test(messageText)) {
    return null;
  }

  if (!documentText) {
    return null;
  }

  const capturedDocumentValues = uniqueMatches(
    collectRegexMatches(documentText, DOCUMENT_VALUE_CAPTURE, 1),
  );
  if (capturedDocumentValues.length === 1) {
    return capturedDocumentValues[0];
  }

  const uppercaseCandidates = uniqueMatches(
    collectRegexMatches(documentText, UPPERCASE_IDENTIFIER_CAPTURE),
  );
  if (uppercaseCandidates.length === 1) {
    return uppercaseCandidates[0];
  }

  const uuidCandidates = uniqueMatches(
    collectRegexMatches(documentText, UUID_IDENTIFIER_CAPTURE),
  );
  if (uuidCandidates.length === 1) {
    return uuidCandidates[0];
  }

  return null;
}

async function resolveExactDocumentValueForChat(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): Promise<string | null> {
  const messageText =
    typeof extractCompatTextContent(message.content) === "string"
      ? extractCompatTextContent(message.content).trim()
      : "";
  if (!messageText || !EXACT_GROUNDED_VALUE_REQUEST.test(messageText)) {
    return null;
  }

  const documentsService = runtime.getService("documents") as
    | {
        searchDocuments?: (
          message: ReturnType<typeof createMessageMemory>,
        ) => Promise<
          Array<{
            content?: { text?: string };
            metadata?: Record<string, unknown>;
          }>
        >;
      }
    | null
    | undefined;
  if (
    !documentsService ||
    typeof documentsService.searchDocuments !== "function"
  ) {
    return null;
  }

  try {
    const matches = await documentsService.searchDocuments(message);
    if (!Array.isArray(matches) || matches.length === 0) {
      return null;
    }

    const uploadedMatches = matches.filter((match) => {
      const metadata =
        match.metadata && typeof match.metadata === "object"
          ? match.metadata
          : null;
      return metadata?.source === "upload";
    });
    const preferredMatches =
      uploadedMatches.length > 0 ? uploadedMatches : matches;
    const exactMatchCandidates = uniqueMatches(
      preferredMatches
        .map((match) =>
          typeof match.content?.text === "string"
            ? extractExactGroundedValueFromText(
                messageText,
                match.content.text.trim(),
              )
            : null,
        )
        .filter((value): value is string => typeof value === "string"),
    );
    if (exactMatchCandidates.length === 1) {
      return exactMatchCandidates[0];
    }

    const documentsText = preferredMatches
      .map((match) =>
        typeof match.content?.text === "string"
          ? match.content.text.trim()
          : "",
      )
      .filter((text) => text.length > 0)
      .join("\n\n");
    return extractExactGroundedValueFromText(messageText, documentsText);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chat failure / no-response helpers
// ---------------------------------------------------------------------------

// Reserved for path #4 — actual generation throw caught by getChatFailureReply.
// Do NOT use as the generic empty-response fallback; that mislabels every
// IGNORE / empty-action / empty-normalized-text path as a provider failure.
const PROVIDER_ISSUE_CHAT_REPLY = "Sorry, I'm having a provider issue";
// Shared with the connector failure-reply path in @elizaos/core so every
// delivery surface phrases credit exhaustion identically.
const INSUFFICIENT_CREDITS_CHAT_REPLY = INSUFFICIENT_CREDITS_REPLY;
// A transient 429 (no billing context) — e.g. the shared model key briefly
// over its requests/min under concurrent load. Tell the user it's momentary so
// they retry, instead of the generic "provider issue" which reads as broken.
const RATE_LIMITED_CHAT_REPLY =
  "I'm being rate-limited right now — give it a few seconds and try again.";
/** Remote/large models can exceed the local default; distinguish from a broken provider. */
const GENERATION_TIMEOUT_CHAT_REPLY =
  "The model is taking too long to respond — it may still be loading. Wait a moment and try again.";
// Used by paths #1-#3: planner picked IGNORE/NONE/empty REPLY, action ran but
// emitted no text callback, or normalized text became empty. None of these are
// provider failures, so the message must not blame the provider.
const NO_RESPONSE_FALLBACK_REPLY =
  "I don't have a reply for that — try rephrasing?";
// Routed-model errors raised by the model router when no provider plugin is
// loaded for a requested model class (e.g. TEXT_SMALL). Identifies the OOB
// "no provider configured" case so chat routes can return a structured 503
// instead of a generic 500 — UI clients gate on `error.type === "no_provider"`
// to render a "Connect a provider" CTA instead of an opaque error toast.
const NO_PROVIDER_ERROR_FRAGMENTS = [
  "No provider registered for",
  "No model registered for",
];
const MISSING_DELEGATE_TYPE_PATTERN =
  /No handler found for delegate type:\s*([A-Z][A-Z0-9_]*)/i;
function isNoProviderError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (NO_PROVIDER_ERROR_FRAGMENTS.some((frag) => msg.includes(frag))) {
    return true;
  }

  const missingDelegateType = msg.match(MISSING_DELEGATE_TYPE_PATTERN)?.[1];
  return isTextGenerationModelType(missingDelegateType);
}
const NO_PROVIDER_CHAT_MESSAGE =
  "Connect an LLM provider to start chatting. Open Settings → Providers, " +
  "or choose Eliza Cloud during first-run setup.";
const DEFAULT_CHAT_GENERATION_TIMEOUT_MS = 180_000;
/** Remote Ollama (Pi → VPS) runs multiple model calls per turn; allow more headroom. */
const REMOTE_CHAT_GENERATION_TIMEOUT_MS = 600_000;
const CHAT_GENERATION_TIMEOUT_PATTERN =
  /chat generation timed out after \d+ms/i;
const NON_EXECUTABLE_FALLBACK_ACTIONS = new Set(["REPLY", "NONE", "IGNORE"]);
type SyntheticChatFailureKind =
  | ChatFailureKind
  | "no_response"
  | "transient_failure";

function isExecutableFallbackAction(action: { name: string }): boolean {
  return !NON_EXECUTABLE_FALLBACK_ACTIONS.has(action.name);
}

function classifySyntheticChatFailureText(
  text: string,
): SyntheticChatFailureKind | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ");
  if (!normalized) return null;
  if (normalized === PROVIDER_ISSUE_CHAT_REPLY.toLowerCase()) {
    return "provider_issue";
  }
  if (/\bprovider issue\b/.test(normalized)) {
    return "provider_issue";
  }
  if (normalized === NO_RESPONSE_FALLBACK_REPLY.toLowerCase()) {
    return "no_response";
  }
  if (normalized === INSUFFICIENT_CREDITS_CHAT_REPLY.toLowerCase()) {
    return "insufficient_credits";
  }
  if (normalized === RATE_LIMITED_CHAT_REPLY.toLowerCase()) {
    return "rate_limited";
  }
  if (normalized === GENERATION_TIMEOUT_CHAT_REPLY.toLowerCase()) {
    return "generation_timeout";
  }
  if (normalized === NO_PROVIDER_CHAT_MESSAGE.toLowerCase()) {
    return "no_provider";
  }
  if (normalized === "something went wrong on my end. please try again.") {
    return "transient_failure";
  }
  return null;
}

/**
 * Validate an untrusted `accountConnect` payload from a response Content into a
 * strict {@link AccountConnectRequest}. Returns `undefined` when the value is
 * absent, malformed, or carries no valid provider id — a broken/empty request
 * must not surface an empty block on the client.
 */
export function normalizeAccountConnectRequest(
  value: unknown,
): AccountConnectRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.providers)) return undefined;
  const providers: LinkedAccountProviderId[] = [];
  for (const provider of record.providers) {
    if (isLinkedAccountProviderId(provider) && !providers.includes(provider)) {
      providers.push(provider);
    }
  }
  if (providers.length === 0) return undefined;
  const reason =
    typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim()
      : undefined;
  return reason ? { providers, reason } : { providers };
}

export function markSyntheticChatFailureContent<T extends Content>(
  content: T,
): T {
  const text = extractCompatTextContent(content);
  const failureKind =
    typeof content.failureKind === "string"
      ? (content.failureKind as SyntheticChatFailureKind)
      : classifySyntheticChatFailureText(text);
  if (!failureKind) return content;

  const metadata = asRecord(content.metadata);
  return {
    ...content,
    metadata: {
      ...(metadata ? metadata : {}),
      elizaSyntheticFailure: true,
      chatFailureKind: failureKind,
    },
  } as T;
}

function normalizeActionName(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function ensureMessageMemoryContent(
  content: Content,
): Content & { text: string } {
  return typeof content.text === "string"
    ? { ...content, text: content.text }
    : { ...content, text: "" };
}

function buildRuntimeActionNameLookup(
  runtime: AgentRuntime,
): Map<string, string> {
  const lookup = new Map<string, string>();
  const runtimeActions = Array.isArray(
    (runtime as { actions?: unknown[] }).actions,
  )
    ? ((runtime as { actions: unknown[] }).actions as Array<{
        name?: unknown;
        similes?: unknown;
      }>)
    : [];

  for (const action of runtimeActions) {
    const canonicalName = normalizeActionName(action.name);
    if (!canonicalName) {
      continue;
    }
    lookup.set(canonicalName, canonicalName);
    if (!Array.isArray(action.similes)) {
      continue;
    }
    for (const alias of action.similes) {
      const normalizedAlias = normalizeActionName(alias);
      if (normalizedAlias) {
        lookup.set(normalizedAlias, canonicalName);
      }
    }
  }

  return lookup;
}

function readRuntimeActionResults(
  runtime: AgentRuntime,
  messageId: UUID | undefined,
): unknown[] {
  if (!messageId) {
    return [];
  }

  const getActionResults = (
    runtime as {
      getActionResults?: (id: UUID) => unknown[];
    }
  ).getActionResults;
  if (typeof getActionResults !== "function") {
    return [];
  }

  try {
    return getActionResults(messageId);
  } catch {
    return [];
  }
}

function readActionResultName(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const record = result as Record<string, unknown>;
  if (typeof record.actionName === "string") {
    return normalizeActionName(record.actionName);
  }
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : null;
  return normalizeActionName(data?.actionName);
}

function listSuccessfulActionNames(
  runtime: AgentRuntime,
  messageId: UUID | undefined,
  turnActionResults: readonly unknown[] | undefined,
  actionNameLookup: ReadonlyMap<string, string>,
): Set<string> {
  const successfulNames = new Set<string>();
  for (const result of listSuccessfulActionResults(
    runtime,
    messageId,
    turnActionResults,
  )) {
    const normalizedName = readActionResultName(result);
    if (!normalizedName) {
      continue;
    }
    successfulNames.add(actionNameLookup.get(normalizedName) ?? normalizedName);
  }
  return successfulNames;
}

function listSuccessfulActionResults(
  runtime: AgentRuntime,
  messageId: UUID | undefined,
  turnActionResults: readonly unknown[] | undefined,
): unknown[] {
  return [
    ...(turnActionResults ?? []),
    ...readRuntimeActionResults(runtime, messageId),
  ].filter((result) => {
    if (
      !result ||
      typeof result !== "object" ||
      (result as Record<string, unknown>).success !== true
    ) {
      return false;
    }
    return Boolean(readActionResultName(result));
  });
}

function isProgressActionCallback(content: Content): boolean {
  const status = normalizeActionName(
    (content as Record<string, unknown>).actionStatus,
  );
  return (
    status === "PENDING" ||
    status === "QUEUED" ||
    status === "RUNNING" ||
    status === "IN_PROGRESS" ||
    status === "PROGRESS"
  );
}

type WalletAttributedOperation =
  | "APPROVE"
  | "BALANCE"
  | "BUY"
  | "EXECUTE"
  | "SELL"
  | "SWAP"
  | "TRADE"
  | "TRANSFER";

const WALLET_ROUTER_SUBACTION_OPERATIONS = new Map<
  string,
  readonly WalletAttributedOperation[]
>([
  ["TRANSFER", ["TRANSFER"]],
  ["SWAP", ["BUY", "SELL", "SWAP", "TRADE"]],
  ["BRIDGE", ["TRANSFER"]],
  ["GOV", []],
  ["PUMP_FUN_BUY", ["BUY", "TRADE"]],
  ["TOKEN_INFO", []],
  ["SEARCH_ADDRESS", ["BALANCE"]],
]);

const WALLET_GOV_OP_OPERATIONS = new Map<
  string,
  readonly WalletAttributedOperation[]
>([
  ["PROPOSE", []],
  ["VOTE", ["APPROVE"]],
  ["QUEUE", []],
  ["EXECUTE", ["EXECUTE"]],
]);

// This fail-closed boundary intentionally duplicates the wallet plugin's public
// action names and similes so an unrelated action cannot gain wallet authority
// merely by containing a financial verb.
const WALLET_ACTION_OPERATIONS = new Map<
  string,
  readonly WalletAttributedOperation[]
>([
  ["EVM_TRANSFER", ["TRANSFER"]],
  ["SOLANA_TRANSFER", ["TRANSFER"]],
  ["CROSS_CHAIN_TRANSFER", ["TRANSFER"]],
  ["TRANSFER", ["TRANSFER"]],
  ["TRANSFER_TOKEN", ["TRANSFER"]],
  ["TRANSFER_TOKENS", ["TRANSFER"]],
  ["TRANSFER_SOL", ["TRANSFER"]],
  ["WALLET_TRANSFER", ["TRANSFER"]],
  ["SEND_TOKEN", ["TRANSFER"]],
  ["SEND_TOKENS", ["TRANSFER"]],
  ["SEND_SOL", ["TRANSFER"]],
  ["PREPARE_TRANSFER", ["TRANSFER"]],
  ["PAY", ["TRANSFER"]],
  ["EVM_SWAP", ["BUY", "SELL", "SWAP", "TRADE"]],
  ["SOLANA_SWAP", ["BUY", "SELL", "SWAP", "TRADE"]],
  ["SWAP", ["BUY", "SELL", "SWAP", "TRADE"]],
  ["SWAP_SOL", ["BUY", "SELL", "SWAP", "TRADE"]],
  ["SWAP_SOLANA", ["BUY", "SELL", "SWAP", "TRADE"]],
  ["SWAP_TOKEN", ["BUY", "SELL", "SWAP", "TRADE"]],
  ["SWAP_TOKENS", ["BUY", "SELL", "SWAP", "TRADE"]],
  ["WALLET_SWAP", ["BUY", "SELL", "SWAP", "TRADE"]],
  ["TOKEN_SWAP", ["BUY", "SELL", "SWAP", "TRADE"]],
  ["TRADE", ["TRADE", "BUY", "SELL"]],
  ["PUMP_FUN_BUY", ["BUY", "TRADE"]],
  ["PUMPFUN_BUY", ["BUY", "TRADE"]],
  ["BUY_PUMP_FUN", ["BUY", "TRADE"]],
  ["BUY_PUMPFUN", ["BUY", "TRADE"]],
  ["CHECK_BALANCE", ["BALANCE"]],
  ["WALLET_SEARCH_ADDRESS", ["BALANCE"]],
  ["BIRDEYE_SEARCH", ["BALANCE"]],
  ["BIRDEYE_LOOKUP", ["BALANCE"]],
]);

function walletActionMatchesIntent(
  prompt: string,
  successfulActionName: string,
  result?: unknown,
): boolean {
  const actionName = normalizeActionName(successfulActionName);
  if (!actionName) return false;
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : null;
  const data =
    record?.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : null;
  const values =
    record?.values && typeof record.values === "object"
      ? (record.values as Record<string, unknown>)
      : null;
  const metadata =
    data?.metadata && typeof data.metadata === "object"
      ? (data.metadata as Record<string, unknown>)
      : null;
  const walletSubaction = normalizeActionName(
    data?.subaction ??
      data?.walletSubaction ??
      values?.walletSubaction ??
      values?.subaction,
  );
  const walletGovOp = normalizeActionName(
    data?.op ?? metadata?.op ?? values?.walletGovOp,
  );
  const tradeHasExecutionEvidence =
    values?.tradeActionPrepared === true ||
    values?.tradeActionSucceeded === true ||
    normalizeActionName(values?.tradeOutcome) === "SUBMITTED" ||
    normalizeActionName(data?.outcome) === "SUBMITTED";
  const attributedOperations =
    actionName === "WALLET"
      ? walletSubaction === "GOV"
        ? WALLET_GOV_OP_OPERATIONS.get(walletGovOp)
        : WALLET_ROUTER_SUBACTION_OPERATIONS.get(walletSubaction)
      : actionName === "TRADE"
        ? tradeHasExecutionEvidence
          ? WALLET_ACTION_OPERATIONS.get(actionName)
          : undefined
        : WALLET_ACTION_OPERATIONS.get(actionName);
  if (!attributedOperations) return false;
  const matches = (operation: WalletAttributedOperation) =>
    attributedOperations.includes(operation);

  if (/\b(send|transfer)\b/i.test(prompt)) {
    return matches("TRANSFER");
  }
  if (/\bswap\b/i.test(prompt)) {
    return matches("SWAP");
  }
  if (/\btrade\b/i.test(prompt)) {
    return matches("TRADE") || matches("BUY") || matches("SELL");
  }
  if (/\bbuy\b/i.test(prompt)) {
    return matches("BUY");
  }
  if (/\bsell\b/i.test(prompt)) {
    return matches("SELL");
  }
  if (/\bapprove\b/i.test(prompt)) {
    return matches("APPROVE");
  }
  if (/\bexecute\b/i.test(prompt)) {
    return matches("EXECUTE");
  }
  if (/\b(balance|portfolio|holdings|funds)\b/i.test(prompt)) {
    return matches("BALANCE");
  }
  return attributedOperations.length > 0;
}

function sanitizeActionResultValue(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const wellFormed = toWellFormedUnicode(value);
    return wellFormed.length > 1000
      ? `${truncateWellFormed(wellFormed, 997)}...`
      : wellFormed;
  }
  if (Array.isArray(value)) {
    if (depth >= 2) return undefined;
    return value
      .slice(0, 20)
      .map((entry) => sanitizeActionResultValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") {
    if (depth >= 2) return undefined;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 20)) {
      const safe = sanitizeActionResultValue(entry, depth + 1);
      if (safe !== undefined) output[key] = safe;
    }
    return output;
  }
  return undefined;
}

function sanitizeActionResultValues(
  values: unknown,
): Record<string, unknown> | undefined {
  if (!values || typeof values !== "object" || Array.isArray(values))
    return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values).slice(0, 20)) {
    const safe = sanitizeActionResultValue(value);
    if (safe !== undefined) output[key] = safe;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function summarizeActionResultForClient(
  result: unknown,
): ChatActionResultSummary | null {
  if (typeof result === "string") {
    const actionName = normalizeActionName(result);
    return actionName ? { actionName, success: true } : null;
  }
  if (!result || typeof result !== "object") return null;
  const record = result as ActionResult & Record<string, unknown>;
  const data = asRecord(record.data);
  const actionName =
    (typeof data?.actionName === "string" && data.actionName.trim()) ||
    (typeof record.actionName === "string" && record.actionName.trim()) ||
    undefined;
  const values = sanitizeActionResultValues(record.values);
  const text =
    typeof record.text === "string" && record.text.trim()
      ? String(sanitizeActionResultValue(record.text))
      : undefined;
  const error =
    typeof record.error === "string" && record.error.trim()
      ? String(sanitizeActionResultValue(record.error))
      : record.error instanceof Error
        ? record.error.message
        : undefined;
  if (!actionName && !values && !text && !error) return null;
  return {
    ...(actionName ? { actionName } : {}),
    success: Boolean(record.success),
    ...(text ? { text } : {}),
    ...(error ? { error } : {}),
    ...(values ? { values } : {}),
  };
}

function summarizeRuntimeActionResults(
  runtime: AgentRuntime,
  messageId: UUID | undefined,
  turnActionResults?: unknown[],
): ChatActionResultSummary[] {
  const actionResults =
    turnActionResults && turnActionResults.length > 0
      ? turnActionResults
      : readRuntimeActionResults(runtime, messageId);
  return actionResults
    .map(summarizeActionResultForClient)
    .filter((entry): entry is ChatActionResultSummary => Boolean(entry))
    .slice(-8);
}

function resolveFinalTranscriptVisibility(
  finalText: string,
  actionResults: readonly ActionResult[] | undefined,
  contents: readonly (Content | null | undefined)[] = [],
): "internal" | undefined {
  if (!finalText) return undefined;
  return contents.some(
    (content) =>
      content?.transcriptVisibility === "internal" &&
      extractCompatTextContent(content) === finalText,
  ) ||
    actionResults?.some(
      (result) =>
        result.transcriptVisibility === "internal" && result.text === finalText,
    )
    ? "internal"
    : undefined;
}

function pickInsufficientCreditsChatReply(): string {
  return INSUFFICIENT_CREDITS_CHAT_REPLY;
}

function findRecentInsufficientCreditsLog(
  logBuffer: LogEntry[],
  lookbackMs = 60_000,
): LogEntry | null {
  const now = Date.now();
  for (let i = logBuffer.length - 1; i >= 0; i--) {
    const entry = logBuffer[i];
    if (now - entry.timestamp > lookbackMs) break;
    if (isInsufficientCreditsMessage(entry.message)) {
      return entry;
    }
  }
  return null;
}

export function resolveNoResponseFallback(
  logBuffer: LogEntry[],
  _runtime?: AgentRuntime | null,
  _lang = "en",
): string {
  if (findRecentInsufficientCreditsLog(logBuffer)) {
    return pickInsufficientCreditsChatReply();
  }
  return NO_RESPONSE_FALLBACK_REPLY;
}

function getProviderIssueChatReply(): string {
  return PROVIDER_ISSUE_CHAT_REPLY;
}

export function isChatGenerationTimeoutError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return CHAT_GENERATION_TIMEOUT_PATTERN.test(msg);
}

function isRemoteOllamaEndpointConfigured(): boolean {
  const raw =
    readAliasedEnv("OLLAMA_BASE_URL") ?? readAliasedEnv("OLLAMA_API_ENDPOINT");
  if (!raw?.trim()) return false;
  try {
    const normalized = raw.trim().replace(/\/api\/?$/i, "");
    const host = new URL(normalized).hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
}

function resolveChatGenerationTimeoutMs(explicit?: number): number {
  if (
    typeof explicit === "number" &&
    Number.isFinite(explicit) &&
    explicit > 0
  ) {
    return Math.max(1, Math.floor(explicit));
  }

  const fromEnv = readAliasedEnv("ELIZA_CHAT_GENERATION_TIMEOUT_MS");
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(1_000, parsed);
    }
  }

  if (isRemoteOllamaEndpointConfigured()) {
    return REMOTE_CHAT_GENERATION_TIMEOUT_MS;
  }

  return DEFAULT_CHAT_GENERATION_TIMEOUT_MS;
}

function createChatGenerationTimeoutError(timeoutMs: number): Error {
  return new Error(`Chat generation timed out after ${timeoutMs}ms`);
}

/**
 * Run a generation under a wall-clock deadline, cancelling it on expiry.
 *
 * Racing a bare promise against a timer would leave the model call running
 * after the caller has already been told it failed — it would keep holding a
 * provider slot and keep emitting `onChunk` into a turn nobody is reading. So
 * the deadline drives a real `AbortSignal`, chained to any caller-supplied
 * signal, and `run` receives the options with that signal substituted in.
 */
export async function runWithGenerationTimeout<T>(
  timeoutMs: number,
  createError: () => Error,
  opts: ChatGenerateOptions | undefined,
  run: (opts: ChatGenerateOptions | undefined) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = opts?.abortSignal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort(createError());
  }, timeoutMs);

  try {
    return await run({ ...(opts ?? {}), abortSignal: controller.signal });
  } catch (err) {
    // error-policy:J2 the abort surfaces as whatever the generation threw on
    // cancellation; re-key it to the typed deadline error so `classifyChatFailure`
    // reports `generation_timeout` rather than a generic provider issue.
    if (timedOut) throw createError();
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export function getChatFailureReply(
  err: unknown,
  logBuffer: LogEntry[],
): string {
  if (
    isInsufficientCreditsError(err) ||
    findRecentInsufficientCreditsLog(logBuffer)
  ) {
    return pickInsufficientCreditsChatReply();
  }
  if (isNoProviderError(err)) {
    return NO_PROVIDER_CHAT_MESSAGE;
  }
  // After credits (a 429 *with* billing is "top up"): a bare 429 is transient.
  if (isRateLimitError(err)) {
    return RATE_LIMITED_CHAT_REPLY;
  }
  if (isChatGenerationTimeoutError(err)) {
    return GENERATION_TIMEOUT_CHAT_REPLY;
  }
  return getProviderIssueChatReply();
}

export function classifyChatFailure(
  err: unknown,
  logBuffer: LogEntry[],
): ChatFailureKind {
  if (
    isInsufficientCreditsError(err) ||
    findRecentInsufficientCreditsLog(logBuffer)
  ) {
    return "insufficient_credits";
  }
  if (isNoProviderError(err)) {
    return "no_provider";
  }
  if (isLocalInferenceError(err)) {
    return "local_inference";
  }
  if (isRateLimitError(err)) {
    return "rate_limited";
  }
  if (isChatGenerationTimeoutError(err)) {
    return "generation_timeout";
  }
  return "provider_issue";
}

function normalizeIntentText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasLocalInferenceMetadata(
  message: ReturnType<typeof createMessageMemory>,
): boolean {
  const contentMetadata = asRecord(message.content.metadata);
  const messageMetadata = asRecord(message.metadata);
  const metadata = {
    ...(contentMetadata ? contentMetadata : {}),
    ...(messageMetadata ? messageMetadata : {}),
  };
  const localValue =
    metadata.localInference ??
    metadata.localInferenceContext ??
    metadata.localModel ??
    metadata.modelHub;
  if (localValue === true) return true;
  if (typeof localValue === "string") {
    return /^(1|true|yes|local|local-inference|model-hub)$/i.test(
      localValue.trim(),
    );
  }
  const context =
    typeof metadata.context === "string"
      ? metadata.context
      : typeof metadata.scope === "string"
        ? metadata.scope
        : "";
  return /\blocal[-_\s]?inference\b|\bmodel[-_\s]?hub\b/i.test(context);
}

function hasLocalInferenceTopic(text: string): boolean {
  return (
    /\b(local|locally|on device|on-device|device model|local model|local inference|model hub|gguf|llama|inference|provider|runtime)\b/i.test(
      text,
    ) || /\bmodel\s+(?:download|install|load|setup)\b/i.test(text)
  );
}

function isImperativeCloudOrLocalRouting(text: string): boolean {
  return /^(?:please\s+)?(?:use|switch|prefer|route|go|move)\s+(?:me\s+)?(?:to\s+)?(?:the\s+)?(?:cloud|local|on device|on-device)\b/i.test(
    text,
  );
}

export function detectLocalInferenceCommandIntent(
  text: string,
  options: { localInferenceContext?: boolean } = {},
): LocalInferenceCommandIntent | null {
  const normalized = normalizeIntentText(text);
  if (!normalized) return null;

  const explicitContext =
    options.localInferenceContext === true ||
    hasLocalInferenceTopic(normalized) ||
    isImperativeCloudOrLocalRouting(normalized);
  if (!explicitContext) return null;

  if (
    /\b(?:use|switch|prefer|route|go|move)\s+(?:to\s+)?(?:the\s+)?cloud\b/.test(
      normalized,
    ) ||
    /\bcloud\s+(?:mode|provider|inference|model|routing)\b/.test(normalized)
  ) {
    return "use_cloud";
  }

  if (
    /\b(?:status|progress|state|ready|loaded|loading|how far|what model)\b/.test(
      normalized,
    ) &&
    (options.localInferenceContext === true ||
      /\b(?:download|model|local|inference|gguf|eliza-1|provider|runtime)\b/.test(
        normalized,
      ))
  ) {
    return "status";
  }

  if (
    /\b(?:use|switch|prefer|route|go|move)\s+(?:to\s+)?(?:the\s+)?(?:local|on device|on device model)\b/.test(
      normalized,
    ) ||
    /\b(?:local|on device)\s+(?:mode|provider|inference|model|routing)\b/.test(
      normalized,
    )
  ) {
    return "use_local";
  }

  if (
    /\b(?:smaller|smallest|tiny|lighter|lightweight|less memory|low ram|low memory)\b/.test(
      normalized,
    ) &&
    /\b(?:switch|use|load|pick|select|change|model)\b/.test(normalized)
  ) {
    return "switch_smaller";
  }

  if (
    /\b(?:cancel|stop|abort|halt)\b/.test(normalized) &&
    /\b(?:download|model|local|inference)\b/.test(normalized)
  ) {
    return "cancel";
  }

  if (
    /\b(?:re download|redownload|download again|fresh download)\b/.test(
      normalized,
    )
  ) {
    return "redownload";
  }

  if (
    /\b(?:retry|try again|resume|continue|restart)\b/.test(normalized) &&
    /\b(?:download|model|local|inference)\b/.test(normalized)
  ) {
    return normalized.includes("resume") || normalized.includes("continue")
      ? "resume"
      : "retry";
  }

  if (
    /\b(?:download|install|get|fetch|pull)\b/.test(normalized) &&
    (options.localInferenceContext === true ||
      /\b(?:model|local|inference|gguf|eliza-1)\b/.test(normalized))
  ) {
    return "download";
  }

  return null;
}

export function isLocalInferenceError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /\b(?:local inference|local model|on-device|device bridge|llama|gguf|capacitor-llama|no local model|model download|enospc|no space left|disk full)\b/i.test(
    message,
  );
}

/**
 * Final text projection for chat-shaped API consumers (the trusted-local
 * `POST /api/agents/:id/message` mirror). These callers render plain chat —
 * the dashboard does NOT consume this endpoint (its chat uses the
 * session/chat routes and typed interaction payloads) — so interaction
 * grammar degrades to its text fallbacks and dashboard-only card markers
 * are stripped. Live leak this closes (matrix F2): [CONFIG:owner_finances]
 * and [FOLLOWUPS] blocks delivered verbatim in api replies
 * (tj-a5802a25580840, tj-a76213d5ae7164).
 */
export function renderChatSurfaceText(text: string): string {
  if (!text) return text;
  const { text: rendered } = renderInteractionsAsPlainText(text);
  return stripDashboardOnlyMarkers(rendered);
}

export function normalizeChatResponseText(
  text: string,
  logBuffer: LogEntry[],
  runtime?: AgentRuntime | null,
): string {
  // Both fallback strings can hit this path; either should be re-routed to
  // the insufficient-credits reply when a recent credits log explains why
  // generation produced nothing.
  const visibleText = extractAssistantReplyText(text) ?? text;
  const trimmed = visibleText.trim();
  if (
    (trimmed === PROVIDER_ISSUE_CHAT_REPLY ||
      trimmed === NO_RESPONSE_FALLBACK_REPLY) &&
    findRecentInsufficientCreditsLog(logBuffer)
  ) {
    return pickInsufficientCreditsChatReply();
  }
  if (!isClientVisibleNoResponse(visibleText)) return visibleText;
  return resolveNoResponseFallback(logBuffer, runtime);
}

function listResponseActions(
  responseContent: Content | null | undefined,
): string[] {
  if (!Array.isArray(responseContent?.actions)) {
    return [];
  }
  return responseContent.actions
    .map((action) =>
      typeof action === "string" ? action.trim().toUpperCase() : "",
    )
    .filter((action) => action.length > 0);
}

function isIntentionalNoResponseResult(
  result:
    | {
        didRespond?: boolean;
        responseContent?: Content | null;
      }
    | null
    | undefined,
  candidateText: string,
): boolean {
  if (!result) return false;

  const actions = listResponseActions(result.responseContent);
  const hasSilentTerminalAction =
    actions.length === 1 && (actions[0] === "IGNORE" || actions[0] === "STOP");
  const hasNoVisibleText =
    candidateText.trim().length === 0 ||
    isClientVisibleNoResponse(candidateText);

  return (
    hasNoVisibleText && (result.didRespond === false || hasSilentTerminalAction)
  );
}

function buildUnexecutedActionPayloadReply(actionNames: string[]): string {
  const uniqueNames = [
    ...new Set(
      actionNames.map((name) => normalizeActionName(name)).filter(Boolean),
    ),
  ];
  const actionsLabel =
    uniqueNames.length > 0 ? uniqueNames.join(", ") : "unknown";
  return [
    "I could not complete that request because the model returned actions that were not executed.",
    `Unexecuted actions: ${actionsLabel}.`,
    "No side effects were applied.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

export function initSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export function writeSse(
  res: http.ServerResponse,
  payload: Record<string, unknown>,
): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeChatTokenSse(
  res: http.ServerResponse,
  text: string,
  fullText: string,
  options?: ChatTokenWriteOptions,
): void {
  writeSse(res, {
    type: "token",
    text,
    fullText,
    ...(options?.provisional ? { provisional: true } : {}),
  });
}

export { DELTA_STREAM_PROTOCOL };

export type ChatTokenStreamProtocol = "legacy" | typeof DELTA_STREAM_PROTOCOL;

/**
 * The two write functions a token-stream writer needs, injected so a caller can
 * pass its OWN (test-mockable) imports. `conversation-routes` imports
 * `writeChatTokenSse`/`writeSse` from this module; several route tests
 * `vi.mock` those exports to capture frames, so the writer must dispatch
 * through the caller's references, not this module's closure-bound originals.
 */
export interface ChatTokenStreamWriterDeps {
  writeChatTokenSse: typeof writeChatTokenSse;
  writeSse: typeof writeSse;
}

/**
 * Framing-agnostic front for the streaming chat token wire. `legacy` reproduces
 * the historical per-token `{text, fullText}` frame byte-for-byte; `delta-v2`
 * ships bare `{text}` deltas and re-sends the accumulated `fullText` only on a
 * geometric byte budget, so an M-chunk reply carries O(N) bytes instead of the
 * legacy O(N²) (every token re-serialized its whole prefix). The protocol is
 * negotiated per request (see `readChatRequestPayload`).
 */
/**
 * Per-write options for the token wire. `provisional: true` marks the carried
 * text as an in-flight action-callback delivery the turn's final reply may
 * replace — voice clients must not synthesize it until the terminal `done`
 * frame (or a later non-provisional frame) confirms it, because speech cannot
 * be retracted the way a re-rendered chat bubble can (the "double-speak"
 * defect). Text bubbles may render it exactly as before.
 */
export interface ChatTokenWriteOptions {
  provisional?: boolean;
}

export interface ChatTokenStreamWriter {
  /** An incremental streamed chunk. `fullText` is the accumulated text so far. */
  writeChunk(
    res: http.ServerResponse,
    chunk: string,
    fullText: string,
    options?: ChatTokenWriteOptions,
  ): void;
  /** An authoritative full-text replace (structured-field rewrite, single-frame
   *  reply). The client treats the carried `fullText` as the new buffer. */
  writeSnapshot(
    res: http.ServerResponse,
    fullText: string,
    options?: ChatTokenWriteOptions,
  ): void;
}

export function createChatTokenStreamWriter(
  protocol: ChatTokenStreamProtocol,
  deps: ChatTokenStreamWriterDeps,
): ChatTokenStreamWriter {
  const provisionalField = (options?: ChatTokenWriteOptions) =>
    options?.provisional ? { provisional: true as const } : {};
  if (protocol === "legacy") {
    return {
      writeChunk(res, chunk, fullText, options) {
        deps.writeChatTokenSse(res, chunk, fullText, options);
      },
      writeSnapshot(res, fullText, options) {
        deps.writeChatTokenSse(res, fullText, fullText, options);
      },
    };
  }

  // delta-v2. Snapshot cost is amortized geometrically: a full-text frame is
  // re-sent only after at least as many delta bytes have streamed as the
  // previous snapshot's length (floor 2048 so short replies still self-heal on
  // a dropped/reordered delta). Snapshots therefore land at ~2048, 4096, 8192,
  // … bytes — genuinely periodic — and their bytes sum to ~2N, keeping the
  // total wire (deltas N + snapshots 2N) linear in reply length. A fixed
  // every-K-tokens cadence would still be O(N²/K) and is intentionally avoided.
  let bytesSinceSnapshot = 0;
  let lengthAtLastSnapshot = 0;
  return {
    writeChunk(res, chunk, fullText, options) {
      bytesSinceSnapshot += chunk.length;
      if (bytesSinceSnapshot >= Math.max(2048, lengthAtLastSnapshot)) {
        deps.writeSse(res, {
          type: "token",
          text: chunk,
          fullText,
          ...provisionalField(options),
        });
        bytesSinceSnapshot = 0;
        lengthAtLastSnapshot = fullText.length;
      } else {
        deps.writeSse(res, {
          type: "token",
          text: chunk,
          ...provisionalField(options),
        });
      }
    },
    writeSnapshot(res, fullText, options) {
      // No `text` field: the client reads `fullText` as an authoritative
      // replace rather than an append.
      deps.writeSse(res, {
        type: "token",
        fullText,
        ...provisionalField(options),
      });
      bytesSinceSnapshot = 0;
      lengthAtLastSnapshot = fullText.length;
    },
  };
}

export function writeChatStatusSse(
  res: http.ServerResponse,
  status: ChatTurnStatus,
): void {
  writeSse(res, { type: "status", ...status });
}

export function writeChatToolSse(
  res: http.ServerResponse,
  event: ChatToolCallEvent,
): void {
  writeSse(res, { type: "tool", ...event });
}

export function writeSseData(
  res: http.ServerResponse,
  data: string,
  event?: string,
): void {
  if (res.writableEnded || res.destroyed) return;
  const safeEvent =
    typeof event === "string" && /^[A-Za-z0-9_.-]+$/.test(event) ? event : null;
  if (safeEvent) res.write(`event: ${safeEvent}\n`);
  for (const line of data.split(/\r\n|\r|\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
}

export function writeSseJson(
  res: http.ServerResponse,
  payload: unknown,
  event?: string,
): void {
  writeSseData(res, JSON.stringify(payload), event);
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function stampAppConversationProvenance(
  runtime: AgentRuntime,
  memory: ReturnType<typeof createMessageMemory>,
): ReturnType<typeof createMessageMemory> {
  if (!memory.id) {
    throw new ElizaError("Conversation memory is missing its durable id", {
      code: "CONVERSATION_MEMORY_ID_MISSING",
      context: { roomId: memory.roomId },
    });
  }
  const metadataRecord =
    memory.metadata &&
    typeof memory.metadata === "object" &&
    !Array.isArray(memory.metadata)
      ? (memory.metadata as Record<string, unknown>)
      : {};
  const readMetadataString = (key: string): string | undefined => {
    const value = metadataRecord[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const provider = readMetadataString("provider") ?? MESSAGE_SOURCE_CLIENT_CHAT;
  const accountId = readMetadataString("accountId") ?? runtime.agentId;
  const platformMessageId =
    readMetadataString("platformMessageId") ?? memory.id;
  memory.metadata = {
    ...metadataRecord,
    type: "message",
    provider,
    accountId,
    platformMessageId,
    sourceId: readMetadataString("sourceId") ?? platformMessageId,
  } satisfies MessageMetadata;
  return memory;
}

function isDuplicateMemoryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("duplicate") ||
    msg.includes("already exists") ||
    msg.includes("unique constraint")
  );
}

export async function persistConversationMemory(
  runtime: AgentRuntime,
  memory: ReturnType<typeof createMessageMemory>,
  roomHandlerLease?: RoomHandlerLease,
): Promise<ReturnType<typeof createMessageMemory>> {
  memory.id ??= crypto.randomUUID() as UUID;
  const stampedMemory = stampAppConversationProvenance(runtime, memory);
  try {
    const write = () => runtime.createMemory(stampedMemory, "messages");
    await (roomHandlerLease
      ? runtime.roomHandlerQueue.runInLease(
          stampedMemory.roomId,
          roomHandlerLease,
          write,
        )
      : write());
  } catch (err) {
    if (isDuplicateMemoryError(err)) return stampedMemory;
    throw err;
  }
  return stampedMemory;
}

export async function persistExactConversationMemory(
  runtime: AgentRuntime,
  memory: ReturnType<typeof createMessageMemory>,
  roomHandlerLease?: RoomHandlerLease,
): Promise<ReturnType<typeof createMessageMemory>> {
  return (
    await persistExactConversationMemoryResult(
      runtime,
      memory,
      roomHandlerLease,
    )
  ).memory;
}

export async function persistExactConversationMemoryResult(
  runtime: AgentRuntime,
  memory: ReturnType<typeof createMessageMemory>,
  roomHandlerLease?: RoomHandlerLease,
): Promise<{
  created: boolean;
  memory: ReturnType<typeof createMessageMemory>;
}> {
  if (!memory.id) {
    throw new ElizaError(
      "Exact conversation memory is missing its durable id",
      {
        code: "CONVERSATION_MEMORY_ID_MISSING",
        context: { roomId: memory.roomId },
      },
    );
  }
  const stampedMemory = stampAppConversationProvenance(runtime, memory);

  const loadExisting = async (): Promise<Memory | null> => {
    const [existing] = await runtime.getMemoriesByIds(
      [stampedMemory.id as UUID],
      "messages",
    );
    return existing ?? null;
  };
  const assertExact = (
    existing: Memory,
  ): ReturnType<typeof createMessageMemory> => {
    if (
      existing.id === stampedMemory.id &&
      existing.roomId === stampedMemory.roomId &&
      existing.agentId === stampedMemory.agentId &&
      existing.entityId === stampedMemory.entityId &&
      isDeepStrictEqual(existing.content, stampedMemory.content)
    ) {
      return existing as ReturnType<typeof createMessageMemory>;
    }
    throw new ElizaError(
      "Conversation memory id is already bound to different content",
      {
        code: "CONVERSATION_MEMORY_ID_CONFLICT",
        context: {
          memoryId: stampedMemory.id,
          roomId: stampedMemory.roomId,
          agentId: stampedMemory.agentId,
          entityId: stampedMemory.entityId,
        },
      },
    );
  };

  const existing = await loadExisting();
  if (existing) return { created: false, memory: assertExact(existing) };

  try {
    const write = () => runtime.createMemory(stampedMemory, "messages");
    await (roomHandlerLease
      ? runtime.roomHandlerQueue.runInLease(
          stampedMemory.roomId,
          roomHandlerLease,
          write,
        )
      : write());
    return { created: true, memory: stampedMemory };
  } catch (cause) {
    const raced = await loadExisting();
    if (raced) return { created: false, memory: assertExact(raced) };
    throw new ElizaError("Failed to store exact conversation memory", {
      code: "CONVERSATION_MEMORY_WRITE_FAILED",
      cause,
      context: {
        memoryId: stampedMemory.id,
        roomId: stampedMemory.roomId,
      },
    });
  }
}

async function hasRecentAssistantMemory(
  runtime: AgentRuntime,
  roomId: UUID,
  text: string,
  sinceMs: number,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;

  try {
    const recent = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: 12,
    });

    return recent.some((memory) => {
      const contentText = (memory.content as { text?: string })?.text?.trim();
      const createdAt = memory.createdAt ?? 0;
      return (
        memory.entityId === runtime.agentId &&
        contentText === trimmed &&
        createdAt >= sinceMs - 2000
      );
    });
  } catch {
    return false;
  }
}

export async function hasRecentVisibleAssistantMemorySince(
  runtime: AgentRuntime,
  roomId: UUID,
  sinceMs: number,
): Promise<boolean> {
  return Boolean(
    await getRecentVisibleAssistantMemoryTextSince(runtime, roomId, sinceMs),
  );
}

export async function getRecentVisibleAssistantMemoryTextSince(
  runtime: AgentRuntime,
  roomId: UUID,
  sinceMs: number,
  // Pre-arrival slack. The boolean suppression callers keep the conservative
  // 2s default (over-matching is safe when the answer is only "suppress").
  // The dupe-RETURN callers pass 0: `sinceMs` (dedupe first-seen) and memory
  // `createdAt` come from the same process clock, so any reply persisted
  // before arrival belongs to a PREVIOUS turn — returning it would ship the
  // prior turn's answer to a rapid-fire retry.
  slackMs: number = 2000,
): Promise<string | null> {
  return (
    (
      await getRecentVisibleAssistantMemorySince(
        runtime,
        roomId,
        sinceMs,
        slackMs,
      )
    )?.text ?? null
  );
}

export async function getRecentVisibleAssistantMemorySince(
  runtime: AgentRuntime,
  roomId: UUID,
  sinceMs: number,
  slackMs: number = 2000,
): Promise<{ id: UUID; text: string } | null> {
  try {
    const recent = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: 12,
    });

    const persistedAssistantTurn = recent
      .filter((memory) => {
        const content = memory.content as {
          text?: string;
          transcriptVisibility?: "internal";
        };
        const contentText = content.text?.trim();
        const createdAt = memory.createdAt ?? 0;
        return (
          memory.entityId === runtime.agentId &&
          content.transcriptVisibility !== "internal" &&
          Boolean(contentText) &&
          createdAt >= sinceMs - slackMs
        );
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];

    const text = (
      persistedAssistantTurn?.content as { text?: string } | undefined
    )?.text?.trim();
    return persistedAssistantTurn?.id && text
      ? { id: persistedAssistantTurn.id as UUID, text }
      : null;
  } catch {
    return null;
  }
}

export async function persistAssistantConversationMemory(
  runtime: AgentRuntime,
  roomId: UUID,
  content: string | Content,
  channelType: ChannelType,
  dedupeSinceMs?: number,
  // Callers that need a deterministic retry key may supply the memory id. The
  // returned Memory remains the authority for terminal transport metadata:
  // callers emit `done` only after this write resolves and use its durable id
  // to reconcile optimistic and proactive-message copies.
  memoryId?: UUID,
  roomHandlerLease?: RoomHandlerLease,
): Promise<Memory | null> {
  const persistedContent = markSyntheticChatFailureContent(
    typeof content === "string"
      ? ({
          text: content,
          source: MESSAGE_SOURCE_CLIENT_CHAT,
          channelType,
        } satisfies Content)
      : ({
          ...content,
          text: extractCompatTextContent(content),
          source:
            typeof content.source === "string"
              ? content.source
              : MESSAGE_SOURCE_CLIENT_CHAT,
          channelType:
            typeof content.channelType === "string"
              ? content.channelType
              : channelType,
        } satisfies Content),
  );
  const trimmed = persistedContent.text.trim();
  if (!trimmed) return null;

  if (typeof dedupeSinceMs === "number" && !memoryId) {
    const alreadyPersisted = await hasRecentAssistantMemory(
      runtime,
      roomId,
      trimmed,
      dedupeSinceMs,
    );
    if (alreadyPersisted) return null;
  }

  const memory = createMessageMemory({
    id: memoryId ?? (crypto.randomUUID() as UUID),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId,
    content: persistedContent,
  });
  return memoryId
    ? await persistExactConversationMemory(runtime, memory, roomHandlerLease)
    : await persistConversationMemory(runtime, memory, roomHandlerLease);
}

/**
 * Persist the terminal receipt for an aborted (Stop/disconnect) turn before
 * the route releases it. Unlike `persistAssistantConversationMemory` this
 * MUST persist even when no token streamed — a zero-token Stop still owns a
 * durable `interrupted` assistant row, otherwise reload recovery finds a user
 * turn with no terminal receipt and the transport is free to regenerate
 * (#17216). The row carries `content.interrupted: true`, which the GET
 * /messages DTO round-trips so the renderer shows the interrupted state
 * instead of a healthy-looking reply.
 */
export async function persistInterruptedAssistantReceipt(
  runtime: AgentRuntime,
  roomId: UUID,
  partialText: string,
  channelType: ChannelType,
  inReplyTo: UUID | undefined,
  memoryId: UUID,
  roomHandlerLease?: RoomHandlerLease,
): Promise<Memory> {
  const memory = createMessageMemory({
    id: memoryId,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: partialText,
      interrupted: true,
      source: MESSAGE_SOURCE_CLIENT_CHAT,
      channelType,
      ...(inReplyTo ? { inReplyTo } : {}),
    } satisfies Content,
  });
  return persistExactConversationMemory(runtime, memory, roomHandlerLease);
}

// ---------------------------------------------------------------------------
// Chat request parsing
// ---------------------------------------------------------------------------

const VALID_CHANNEL_TYPES = new Set<string>(Object.values(ChannelType));

function parseRequestChannelType(
  value: unknown,
  fallback: ChannelType = ChannelType.DM,
): ChannelType | null {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (!VALID_CHANNEL_TYPES.has(normalized)) {
    return null;
  }
  return normalized as ChannelType;
}

function readUiLanguageHeader(
  req: http.IncomingMessage | undefined,
): string | undefined {
  if (!req) {
    return undefined;
  }
  const header = req.headers["x-eliza-ui-language"];
  if (Array.isArray(header)) {
    return header.find((value) => value.trim())?.trim();
  }
  return typeof header === "string" && header.trim()
    ? header.trim()
    : undefined;
}

export async function readChatRequestPayload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  helpers: {
    readJsonBody: <T extends object>(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      options?: ReadJsonBodyOptions,
    ) => Promise<T | null>;
    error: (res: http.ServerResponse, message: string, status?: number) => void;
  },
  /** Body size limit. Image-capable endpoints pass CHAT_MAX_BODY_BYTES (20 MB);
   *  legacy/cloud-proxy endpoints that don't process images pass MAX_BODY_BYTES (1 MB). */
  maxBytes = CHAT_MAX_BODY_BYTES,
): Promise<{
  prompt: string;
  channelType: ChannelType;
  images?: ChatImageAttachment[];
  preferredLanguage?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  /** Client-supplied idempotency key (see `isDuplicateChatMessage`); absent
   *  when the client did not stamp one. */
  clientMessageId?: string;
  /** Present only when the client advertised the exact delta-v2 wire protocol;
   *  drives `createChatTokenStreamWriter`. Unknown values are ignored so the
   *  server stays on legacy framing for un-negotiated clients. */
  streamProtocol?: typeof DELTA_STREAM_PROTOCOL;
} | null> {
  const body = await helpers.readJsonBody<{
    text?: string;
    channelType?: string;
    images?: ChatImageAttachment[];
    language?: string;
    source?: string;
    metadata?: Record<string, unknown>;
    clientMessageId?: string;
    streamProtocol?: string;
  }>(req, res, { maxBytes });
  if (!body) return null;
  const normalizedPrompt = normalizeIncomingChatPrompt(body.text, body.images);
  if (!normalizedPrompt) {
    helpers.error(res, "text is required");
    return null;
  }
  const channelType = parseRequestChannelType(body.channelType, ChannelType.DM);
  if (!channelType) {
    helpers.error(res, "channelType is invalid", 400);
    return null;
  }
  const imageValidationError = validateChatImages(body.images);
  if (imageValidationError) {
    helpers.error(res, imageValidationError, 400);
    return null;
  }
  const images = Array.isArray(body.images)
    ? (body.images as ChatImageAttachment[]).map((img) => ({
        ...img,
        mimeType: img.mimeType.toLowerCase(),
      }))
    : undefined;
  const rawPreferredLanguage =
    (typeof body.language === "string" && body.language.trim()
      ? body.language
      : undefined) ?? readUiLanguageHeader(req);
  const preferredLanguage = rawPreferredLanguage
    ? normalizeCharacterLanguage(rawPreferredLanguage)
    : undefined;
  const source =
    typeof body.source === "string" && body.source.trim().length > 0
      ? body.source.trim()
      : undefined;
  const metadata =
    body.metadata &&
    typeof body.metadata === "object" &&
    !Array.isArray(body.metadata)
      ? body.metadata
      : undefined;
  const clientMessageId = normalizeClientMessageId(body.clientMessageId);
  if (body.clientMessageId !== undefined && clientMessageId === null) {
    helpers.error(
      res,
      "clientMessageId must be a non-empty string of at most 128 characters",
      400,
    );
    return null;
  }
  const streamProtocol =
    body.streamProtocol === DELTA_STREAM_PROTOCOL
      ? DELTA_STREAM_PROTOCOL
      : undefined;
  return {
    prompt: normalizedPrompt,
    channelType,
    images,
    ...(preferredLanguage ? { preferredLanguage } : {}),
    ...(source ? { source } : {}),
    ...(metadata ? { metadata } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(streamProtocol ? { streamProtocol } : {}),
  };
}

function readMessageTrajectoryStepId(
  message: ReturnType<typeof createMessageMemory>,
): string | null {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const stepId = (metadata as Record<string, unknown>).trajectoryStepId;
  return typeof stepId === "string" && stepId.trim().length > 0
    ? stepId.trim()
    : null;
}

function readMessageTrajectoryGrouping(
  message: ReturnType<typeof createMessageMemory>,
): {
  scenarioId?: string;
  batchId?: string;
} {
  const contentMetadata = asRecord(message.content.metadata) ?? {};
  const evalMetadata = asRecord(contentMetadata.eval) ?? {};
  const messageMetadata = asRecord(message.metadata) ?? {};
  return resolveTrajectoryGrouping({
    ...contentMetadata,
    ...evalMetadata,
    ...messageMetadata,
  });
}

function scheduleMessageTrajectoryGroupingPersistence(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): void {
  const stepId = readMessageTrajectoryStepId(message);
  if (!stepId) return;

  const grouping = readMessageTrajectoryGrouping(message);
  if (!grouping.scenarioId && !grouping.batchId) return;

  void trackPostDeliveryTask(
    runtime,
    "chat:trajectory-grouping",
    async () => {
      await startTrajectoryStepInDatabase({
        runtime,
        stepId,
        source:
          typeof message.content.source === "string" &&
          message.content.source.trim().length > 0
            ? message.content.source
            : undefined,
        metadata: {
          ...(grouping.scenarioId ? { scenarioId: grouping.scenarioId } : {}),
          ...(grouping.batchId ? { batchId: grouping.batchId } : {}),
        },
      });
    },
    { kind: "diagnostic" },
  );
}

function buildChatUsage(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  finalText: string,
  capturedUsage: CapturedModelUsage | null,
): NonNullable<ChatGenerationResult["usage"]> {
  const model =
    capturedUsage?.model ?? detectRuntimeModel(runtime, undefined) ?? undefined;
  if (capturedUsage) {
    return {
      promptTokens: capturedUsage.promptTokens,
      completionTokens: capturedUsage.completionTokens,
      totalTokens: capturedUsage.totalTokens,
      ...(capturedUsage.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: capturedUsage.cacheReadInputTokens }
        : {}),
      ...(capturedUsage.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: capturedUsage.cacheCreationInputTokens }
        : {}),
      ...(capturedUsage.cachedInputTokens !== undefined
        ? { cachedInputTokens: capturedUsage.cachedInputTokens }
        : {}),
      ...(model ? { model } : {}),
      ...(capturedUsage.provider ? { provider: capturedUsage.provider } : {}),
      isEstimated: capturedUsage.isEstimated,
      llmCalls: capturedUsage.llmCalls,
    };
  }

  const promptText = extractCompatTextContent(message.content);
  const promptTokens = estimateTokenCount(promptText);
  const completionTokens = estimateTokenCount(finalText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(model ? { model } : {}),
    isEstimated: true,
    llmCalls: 0,
  };
}

// ---------------------------------------------------------------------------
// generateChatResponse
// ---------------------------------------------------------------------------

async function generateChatResponseWithTiming(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  agentName: string,
  opts?: ChatGenerateOptions,
): Promise<ChatGenerationResult> {
  const generationAbortController = new AbortController();
  const abortGeneration = (reason?: unknown): void => {
    if (!generationAbortController.signal.aborted) {
      generationAbortController.abort(reason);
    }
  };
  const onExternalAbort = (): void => {
    abortGeneration(opts?.abortSignal?.reason);
  };
  if (opts?.abortSignal?.aborted) {
    onExternalAbort();
  } else {
    opts?.abortSignal?.addEventListener("abort", onExternalAbort, {
      once: true,
    });
  }
  let closeResponseFinalization: (() => void) | undefined;
  try {
    generationAbortController.signal.throwIfAborted();
    const originalUserText = String(extractCompatTextContent(message.content));
    type StreamSource = "unset" | "callback" | "onStreamChunk";
    let responseText = "";
    // Snapshot consumers can replace prior text. Append-only transports need
    // their independently observed prefix so finalization can prove the
    // authoritative reply still matches bytes that have left the process.
    let appendOnlyText = "";
    let firstVisibleReplyMarked = false;
    let forcedWalletExecutionText = false;
    let blockedUnexecutedActionPayload = false;
    let activeStreamSource: StreamSource = "unset";
    let visibleCallbackDeliveries = 0;
    const deliveredActionCallbacks: Array<{
      actionName: string;
      text?: string;
    }> = [];
    // Snapshot of `responseText` at the moment the first action callback runs.
    // WHY: LLM streaming genuinely appends token deltas. Action handlers that
    // call HandlerCallback multiple times (Discord "progressive message" pattern)
    // send unrelated status strings — merging them with mergeStreamingText would
    // concatenate ("🔍…" + "✨…" + "Now playing…"). We preserve the streamed
    // prefix and replace only the callback suffix so the dashboard SSE client
    // gets snapshot fullText updates (same UX as editing one chat bubble).
    let preCallbackText: string | null = null;
    const messageSource =
      typeof message.content.source === "string" &&
      message.content.source.trim().length > 0
        ? message.content.source
        : "api";
    // De-duped status emitter for the rich indicator. Coalesces repeats of the
    // same phase (an action firing many callbacks should emit one
    // `running_action`, not one per chunk) by tracking the last signature.
    let lastStatusSignature = "";
    const emitStatus = (status: ChatTurnStatus): void => {
      if (!opts?.onStatus) return;
      const signature = `${status.kind}:${status.actionName ?? ""}:${status.toolName ?? ""}`;
      if (signature === lastStatusSignature) return;
      lastStatusSignature = signature;
      opts.onStatus(status);
    };
    // `thinking` is the opening phase: the turn started, the model is being
    // prompted, but no visible text has streamed yet.
    emitStatus({ kind: "thinking" });
    const markFirstVisibleReply = (): void => {
      if (firstVisibleReplyMarked) return;
      firstVisibleReplyMarked = true;
      markInference(INFERENCE_MARKS.firstVisibleReply);
    };
    const emitChunk = (
      chunk: string,
      origin: ChatStreamTextOrigin = "model",
    ): void => {
      if (!chunk) return;
      markFirstVisibleReply();
      responseText += chunk;
      if (opts?.onChunk) {
        opts.onChunk(chunk, origin);
        appendOnlyText += chunk;
      }
    };
    const emitSnapshot = (
      text: string,
      origin: ChatStreamTextOrigin = "model",
    ): void => {
      if (!text) return;
      // Skip when the snapshot matches the current responseText exactly:
      // re-emitting the same fullText forces clients to re-render an identical
      // bubble (and on-the-wire bytes for nothing).
      if (text === responseText) return;
      responseText = text;
      if (opts?.onSnapshot) {
        markFirstVisibleReply();
        opts.onSnapshot(text, origin);
      }
    };
    const claimStreamSource = (
      source: Exclude<StreamSource, "unset">,
    ): boolean => {
      if (activeStreamSource === "unset") {
        activeStreamSource = source;
        // The first claim is the thinking→producing transition. Raw LLM tokens
        // are `streaming`; an action handler producing the reply is
        // `running_action` (its name is stamped by recordActionCallback).
        if (source === "onStreamChunk") emitStatus({ kind: "streaming" });
        return true;
      }
      return activeStreamSource === source;
    };
    const appendIncomingText = (
      chunk: string,
      accumulated?: string,
      origin: ChatStreamTextOrigin = "model",
    ): void => {
      // StreamChunkCallback defines `chunk` as a delta. Structured extractors
      // additionally provide their authoritative accumulation, which lets this
      // boundary recover an actual upstream rewrite without guessing from text
      // overlap. Applying overlap deduplication to genuine deltas corrupts valid
      // boundaries such as "Fast " + "streaming " and repeated tokens.
      if (accumulated === undefined) {
        emitChunk(chunk, origin);
        return;
      }
      if (accumulated === responseText) return;
      if (accumulated.startsWith(responseText)) {
        emitChunk(accumulated.slice(responseText.length), origin);
        return;
      }
      emitSnapshot(accumulated, origin);
    };
    const captureCallbackBaseline = (): void => {
      if (preCallbackText === null) {
        preCallbackText = responseText;
      }
    };
    /** Latest action callback wins: replaces prior callback text, keeps LLM prefix. */
    const replaceCallbackText = (
      incoming: string,
      origin: ChatStreamTextOrigin = "action_callback",
    ): void => {
      captureCallbackBaseline();
      const baseline = preCallbackText ?? "";
      const separator = baseline.length > 0 ? "\n\n" : "";
      const nextText = `${baseline}${separator}${incoming}`;
      // Heuristic: if the new callback text is a true append on top of the
      // currently streamed responseText, emit a delta chunk (cheap on the wire,
      // lets modern SSE clients append without re-rendering the whole bubble)
      // AND a snapshot for legacy clients that only consume `fullText`.
      // Otherwise (structural rewrite — Discord-style "🔍 searching" → "✨ done"
      // or planner restart), snapshot only.
      if (nextText === responseText) return;
      if (
        nextText.startsWith(responseText) &&
        responseText.length > 0 &&
        (opts?.onSnapshot || appendOnlyText === responseText)
      ) {
        const delta = nextText.slice(responseText.length);
        emitChunk(delta, origin);
        // emitChunk already advanced responseText; re-emit snapshot for
        // legacy clients that only handle fullText updates.
        opts?.onSnapshot?.(nextText, origin);
        return;
      }
      emitSnapshot(nextText, origin);
    };
    const applyCallbackTextUpdate = (
      content: Content,
      incoming: string,
      origin: ChatStreamTextOrigin = "action_callback",
    ): void => {
      captureCallbackBaseline();
      if (resolveCallbackMergeMode(content) === "append") {
        appendIncomingText(incoming, undefined, origin);
        return;
      }
      replaceCallbackText(incoming, origin);
    };

    // Inbound event consumers may persist correlation state or apply
    // turn-shaping policy. Generation cannot safely continue when that
    // prerequisite fails.
    if (typeof runtime.emitEvent === "function") {
      await timeInferenceSpan("chat:ingress:received-event", () =>
        runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          message,
          source: messageSource,
        }),
      );
    }
    generationAbortController.signal.throwIfAborted();
    const trajectoryStepId = readMessageTrajectoryStepId(message);
    const trajectoryContext =
      typeof trajectoryStepId === "string" && trajectoryStepId.trim().length > 0
        ? { trajectoryStepId: trajectoryStepId.trim() }
        : undefined;

    const androidDirectResult = await runWithTrajectoryContext(
      trajectoryContext,
      () =>
        maybeGenerateAndroidLocalDirectChatResponse({
          runtime,
          message,
          agentName,
          signal: generationAbortController.signal,
          opts,
        }),
    );
    if (androidDirectResult) {
      // A successful model return commits the turn even when transport
      // cancellation races with that return. Discarding it here would release
      // the retry key and bill the same completed work a second time.
      try {
        if (
          androidDirectResult.responseContent &&
          !generationAbortController.signal.aborted &&
          typeof runtime.emitEvent === "function"
        ) {
          const memoryLike = createMessageMemory({
            id: crypto.randomUUID() as UUID,
            roomId: message.roomId,
            entityId: runtime.agentId,
            content: ensureMessageMemoryContent(
              androidDirectResult.responseContent,
            ),
          });
          memoryLike.metadata = message.metadata;
          await runtime.emitEvent(EventType.MESSAGE_SENT, {
            message: memoryLike,
            source: messageSource,
          });
        }
      } catch (err) {
        runtime.logger.warn(
          {
            err,
            src: "eliza-api",
            messageId: message.id,
            roomId: message.roomId,
          },
          "Failed to emit MESSAGE_SENT event",
        );
      }
      return androidDirectResult;
    }
    generationAbortController.signal.throwIfAborted();

    let result:
      | Awaited<
          ReturnType<
            NonNullable<AgentRuntime["messageService"]>["handleMessage"]
          >
        >
      | undefined;
    let trajectoryTerminalOwner: "run" | undefined;
    const settledActionResults: ActionResult[] = [];
    let capturedUsage: CapturedModelUsage | null = null;
    const recordActionCallback = (
      actionTag: string,
      hasText: boolean,
      text?: string,
    ): void => {
      const normalizedActionTag = normalizeActionName(actionTag);
      if (!normalizedActionTag) {
        return;
      }
      const normalizedText =
        hasText && text ? normalizeActionCallbackText(text) : "";
      if (
        normalizedText &&
        !deliveredActionCallbacks.some(
          (entry) =>
            entry.actionName === normalizedActionTag &&
            entry.text === normalizedText,
        )
      ) {
        deliveredActionCallbacks.push({
          actionName: normalizedActionTag,
          text: normalizedText,
        });
      }
      emitStatus({
        kind: "running_action",
        actionName: normalizedActionTag,
      });
      runtime.logger.info(
        {
          src: "eliza-api",
          action: normalizedActionTag,
          hasText,
        },
        `[eliza-api] Action callback fired: ${normalizedActionTag}`,
      );
    };
    const fallbackSuccessfulActionNames = new Set<string>();

    const generationCapture = await withModelUsageCapture(runtime, () =>
      Promise.resolve(
        runWithTrajectoryContext(trajectoryContext, async () => {
          generationAbortController.signal.throwIfAborted();
          // Plugin-registered chat pre-handlers (generic direct-dispatch
          // extension point): drained by priority before normal action
          // processing; the first non-null result resolves the turn.
          const preHandlerResult = await runtime.drainChatPreHandlers({
            runtime,
            message,
            abortSignal: generationAbortController.signal,
            appendText: replaceCallbackText,
            replaceText: emitSnapshot,
          });
          if (preHandlerResult) {
            // A handler that returns a terminal reply owns completion. A late
            // disconnect must not erase a completed direct dispatch and cause
            // the client retry to execute it again.
            const directText = preHandlerResult.responseText;
            const finalText = isClientVisibleNoResponse(directText)
              ? directText || "(no response)"
              : directText;
            result = {
              didRespond: true,
              responseContent: { text: finalText },
              responseMessages: [],
            } as typeof result;
            responseText = finalText;
            forcedWalletExecutionText = isClientVisibleNoResponse(directText);
            return;
          }
          generationAbortController.signal.throwIfAborted();

          // Direct dispatch for explicit task creation intent from UI
          const contentMetadata = message.content.metadata as
            | Record<string, unknown>
            | undefined;
          if (contentMetadata?.intent === "create_task") {
            const coordinator = getSwarmCoordinatorService(runtime);
            if (coordinator) {
              const createTaskAction =
                runtime.actions.find(
                  (a) => a.name.toUpperCase() === "START_CODING_TASK",
                ) ??
                runtime.actions.find(
                  (a) => a.name.toUpperCase() === "CREATE_TASK",
                );
              if (createTaskAction) {
                runtime.logger.info(
                  {
                    src: "eliza-api",
                    agentType: contentMetadata.agentType,
                    intent: "create_task",
                  },
                  "[eliza-api] Direct dispatch START_CODING_TASK from UI intent",
                );
                let actionResponseText = "";
                const declaredParameters = new Set(
                  createTaskAction.parameters?.map(
                    (parameter) => parameter.name,
                  ) ?? [],
                );
                const directTaskParameters: Record<string, unknown> = {};
                if (declaredParameters.has("action")) {
                  directTaskParameters.action = "create";
                } else if (declaredParameters.has("op")) {
                  directTaskParameters.op = "create";
                }
                if (
                  declaredParameters.has("task") &&
                  typeof message.content.text === "string"
                ) {
                  directTaskParameters.task = message.content.text;
                }
                if (
                  declaredParameters.has("agentType") &&
                  typeof contentMetadata.agentType === "string"
                ) {
                  directTaskParameters.agentType = contentMetadata.agentType;
                }
                const directActionResult = await executePlannedToolCall(
                  runtime,
                  {
                    message,
                    activeContexts: createTaskAction.contexts ?? [
                      "code",
                      "automation",
                    ],
                    callback: async (content: Content) => {
                      const chunk = extractCompatTextContent(content);
                      if (chunk) {
                        const voicedChunk =
                          await rewriteDirectActionCallbackText({
                            runtime,
                            actionName: createTaskAction.name,
                            text: chunk,
                            content,
                            abortSignal: generationAbortController.signal,
                          });
                        applyCallbackTextUpdate(content, voicedChunk);
                        actionResponseText = responseText;
                      }
                      return [];
                    },
                  },
                  {
                    name: createTaskAction.name,
                    params: directTaskParameters,
                  },
                  {
                    actions: [createTaskAction],
                    abortSignal: generationAbortController.signal,
                  },
                );
                // The action has already returned a committed result. Keep
                // finalizing it if the transport disappears at this boundary
                // so reconnect cannot repeat an external side effect.
                const finalText =
                  actionResponseText ||
                  directActionResult.text ||
                  responseText ||
                  "Task created.";
                result = {
                  didRespond: true,
                  responseContent: { text: finalText },
                  responseMessages: [],
                } as typeof result;
                responseText = finalText;
                return;
              }
            }
            // Fall through to normal LLM-based routing if coordinator not available
          }

          generationAbortController.signal.throwIfAborted();
          const localInferenceIntent = detectLocalInferenceCommandIntent(
            originalUserText,
            {
              localInferenceContext: hasLocalInferenceMetadata(message),
            },
          );
          if (localInferenceIntent) {
            const { handleLocalInferenceChatCommand } =
              await getLocalInferenceChatApi();
            generationAbortController.signal.throwIfAborted();
            const localResult = await handleLocalInferenceChatCommand(
              localInferenceIntent,
              originalUserText,
            );
            emitSnapshot(localResult.text);
            result = {
              didRespond: true,
              responseContent: {
                text: localResult.text,
                source: MESSAGE_SOURCE_CLIENT_CHAT,
                actions: ["REPLY"],
                localInference: localResult.localInference as
                  | Record<string, unknown>
                  | undefined,
                failureKind:
                  localResult.localInference.status === "failed" ||
                  localResult.localInference.status === "no_space"
                    ? "local_inference"
                    : undefined,
              } as Content,
              responseMessages: [],
            } as typeof result;
            responseText = localResult.text;
            return;
          }

          const languageAugmentedMessage = maybeAugmentChatMessageWithLanguage(
            message,
            opts?.preferredLanguage,
          );
          const walletAugmentedMessage =
            maybeAugmentChatMessageWithWalletContext(
              runtime,
              languageAugmentedMessage,
            );
          const generationMessage = await timeInferenceSpan(
            "chat:document-augmentation",
            () =>
              maybeAugmentChatMessageWithDocuments(
                runtime,
                walletAugmentedMessage,
                { signal: generationAbortController.signal },
              ),
            { phase: "pre-model" },
          );
          generationAbortController.signal.throwIfAborted();
          try {
            result = await timeInferenceSpan(
              "chat:message-service",
              async () =>
                runtime.messageService?.handleMessage(
                  runtime,
                  generationMessage,
                  async (content: Content, actionName?: string) => {
                    if (content.transcriptVisibility === "internal") {
                      return [];
                    }

                    const chunk = extractCompatTextContent(content);
                    const visibleChunk = isInternalStructuredStreamText(chunk)
                      ? ""
                      : chunk;
                    const attributedActionName =
                      normalizeActionName(actionName);
                    const progressCallback = isProgressActionCallback(content);
                    if (!visibleChunk) {
                      if (attributedActionName) {
                        recordActionCallback(attributedActionName, false);
                      }
                      return [];
                    }
                    if (!claimStreamSource("callback")) {
                      if (attributedActionName) {
                        recordActionCallback(attributedActionName, false);
                      }
                      return [];
                    }
                    if (!progressCallback) {
                      visibleCallbackDeliveries += 1;
                    }
                    // Origin discriminates the two deliveries that ride this
                    // one callback: an ACTION's own callback carries its
                    // actionName (provisional status text the final reply may
                    // replace), while the reply handler's terminal delivery
                    // carries none (it IS the turn's reply). Voice clients key
                    // single-utterance behavior off this (see
                    // ChatStreamTextOrigin).
                    applyCallbackTextUpdate(
                      content,
                      visibleChunk,
                      attributedActionName ? "action_callback" : "model",
                    );
                    if (attributedActionName) {
                      recordActionCallback(
                        attributedActionName,
                        !progressCallback,
                        progressCallback ? undefined : visibleChunk,
                      );
                    }
                    return [];
                  },
                  {
                    abortSignal: generationAbortController.signal,
                    roomHandlerLease: opts?.roomHandlerLease,
                    keepExistingResponses: true,
                    onSettledActionResult: (actionResult) => {
                      settledActionResults.push(actionResult);
                    },
                    onTrajectoryTerminalOwner: (owner) => {
                      trajectoryTerminalOwner = owner;
                    },
                    onStreamChunk: opts?.onChunk
                      ? async (
                          chunk: string,
                          _messageId?: string,
                          accumulated?: string,
                        ) => {
                          if (!chunk) return;
                          if (isInternalStructuredStreamText(chunk)) {
                            // A native planner/tool step, not visible reply text:
                            // fork it onto the working indicator + inline tool row
                            // instead of leaking JSON into the bubble.
                            const events =
                              chatEventsFromStructuredStreamText(chunk);
                            if (events?.status) emitStatus(events.status);
                            if (events?.toolEvent) {
                              opts?.onToolEvent?.(events.toolEvent);
                            }
                            return;
                          }
                          if (!claimStreamSource("onStreamChunk")) return;
                          appendIncomingText(chunk, accumulated);
                        }
                      : undefined,
                  },
                ),
              { phase: "message" },
            );
          } catch (error) {
            // error-policy:J1 this API boundary preserves a proven committed
            // effect while translating later turn failure into a durable reply.
            const recovery = recoverSettledMutatingActionTurn(
              runtime,
              settledActionResults,
            );
            if (!recovery) throw error;
            responseText = recovery.text;
            result = {
              didRespond: true,
              responseContent: {
                text: recovery.text,
                ...(recovery.actionNames.length > 0
                  ? { actions: recovery.actionNames }
                  : {}),
              },
              responseMessages: [],
              actionResults: recovery.actionResults,
              mode: "actions",
              ...(trajectoryTerminalOwner ? { trajectoryTerminalOwner } : {}),
            } as typeof result;
            runtime.logger.warn(
              {
                src: "eliza-api",
                messageId: message.id,
                roomId: message.roomId,
                actionNames: recovery.actionNames,
                error: getErrorMessage(error),
              },
              "Recovered a settled mutating action after message processing stopped",
            );
          }
          // A successful return preserves the completed model/message result,
          // but it is not permission to start optional post-processing after a
          // disconnect. The remaining path finalizes that result and only runs
          // new work while the owner signal is live.

          // Ensure MESSAGE_SENT hooks run for API chat flows.
          try {
            const responseMessages = Array.isArray(result?.responseMessages)
              ? (result.responseMessages as Array<{
                  id?: string;
                  content?: Content;
                }>)
              : [];
            const fallbackResponseContent =
              result?.responseContent &&
              typeof result.responseContent === "object"
                ? (result.responseContent as Content)
                : responseText
                  ? ({ text: responseText } as Content)
                  : null;
            // Safety net ONLY for flows where the message handler produced no
            // responseMessages of its own. When responseMessages exist the
            // handler already emitted MESSAGE_SENT for each (message.ts), so
            // re-emitting them here double-fires MESSAGE_SENT for one reply
            // (eliza#10313). Emit just the synthetic fallback in the
            // no-responseMessages case.
            const messagesToEmit =
              responseMessages.length > 0
                ? []
                : fallbackResponseContent
                  ? [
                      {
                        id: crypto.randomUUID(),
                        content: fallbackResponseContent,
                      },
                    ]
                  : [];
            if (
              messagesToEmit.length > 0 &&
              !generationAbortController.signal.aborted &&
              typeof runtime.emitEvent === "function"
            ) {
              for (const responseMessage of messagesToEmit) {
                const memoryLike = createMessageMemory({
                  id:
                    (responseMessage.id as UUID | undefined) ??
                    (crypto.randomUUID() as UUID),
                  roomId: message.roomId,
                  entityId: runtime.agentId,
                  content: markSyntheticChatFailureContent(
                    ensureMessageMemoryContent(
                      responseMessage.content ?? { text: "" },
                    ),
                  ),
                });
                memoryLike.metadata = message.metadata;
                await runtime.emitEvent(EventType.MESSAGE_SENT, {
                  message: memoryLike,
                  source: messageSource,
                  ...((result?.trajectoryTerminalOwner ??
                    trajectoryTerminalOwner) === "run"
                    ? { trajectoryTerminalOwner: "run" as const }
                    : {}),
                });
              }
            }
          } catch (err) {
            runtime.logger.warn(
              {
                err,
                src: "eliza-api",
                messageId: message.id,
                roomId: message.roomId,
              },
              "Failed to emit MESSAGE_SENT event",
            );
          }
          // Post-process fallback actions
          if (result) {
            const rc = result.responseContent as Record<string, unknown> | null;
            const resultRecord = asRecord(result);
            runtime.logger.info(
              {
                src: "eliza-api",
                mode: resultRecord?.mode,
                actions: rc?.actions,
                hasText: Boolean(rc?.text),
              },
              "[eliza-api] Chat response metadata",
            );

            const rawActionsPayload = rc?.actions ?? resultRecord?.actions;
            const modelText = String(
              extractCompatTextContent(result.responseContent),
            );
            const parsedFallbackActions = parseFallbackActionBlocks(
              rawActionsPayload,
              modelText,
            );
            const actionNameLookup = buildRuntimeActionNameLookup(runtime);
            const successfulActionNames = listSuccessfulActionNames(
              runtime,
              typeof message.id === "string" ? message.id : undefined,
              result.actionResults,
              actionNameLookup,
            );

            const executableFallbackActions = parsedFallbackActions.filter(
              (action) => {
                if (!isExecutableFallbackAction(action)) {
                  return false;
                }
                const canonicalName =
                  actionNameLookup.get(normalizeActionName(action.name)) ??
                  normalizeActionName(action.name);
                return !successfulActionNames.has(canonicalName);
              },
            );
            if (executableFallbackActions.length > 0) {
              const selfControlFallbackActions =
                executableFallbackActions.filter((action) => {
                  const canonicalName =
                    actionNameLookup.get(normalizeActionName(action.name)) ??
                    normalizeActionName(action.name);
                  return canonicalName === "BLOCK";
                });
              let successfulFallbackActions = new Set<string>();

              if (
                selfControlFallbackActions.length > 0 &&
                !generationAbortController.signal.aborted
              ) {
                const fallbackExecutions = await executeFallbackParsedActions(
                  runtime,
                  message,
                  selfControlFallbackActions,
                  (incoming: string) =>
                    appendIncomingText(incoming, undefined, "action_callback"),
                  recordActionCallback,
                  {
                    abortSignal: generationAbortController.signal,
                    getCurrentText: () => responseText || modelText,
                  },
                );
                successfulFallbackActions = new Set(
                  fallbackExecutions
                    .filter((execution) => execution.success)
                    .map((execution) => {
                      const normalizedName = normalizeActionName(
                        execution.actionName,
                      );
                      return (
                        actionNameLookup.get(normalizedName) ?? normalizedName
                      );
                    })
                    .filter((name) => name.length > 0),
                );
                for (const actionName of successfulFallbackActions) {
                  fallbackSuccessfulActionNames.add(actionName);
                }
              }

              const remainingExecutableFallbackActions =
                executableFallbackActions.filter((action) => {
                  const canonicalName =
                    actionNameLookup.get(normalizeActionName(action.name)) ??
                    normalizeActionName(action.name);
                  if (canonicalName === "BLOCK") {
                    return !successfulFallbackActions.has(canonicalName);
                  }
                  return true;
                });

              if (remainingExecutableFallbackActions.length > 0) {
                runtime.logger.error(
                  {
                    src: "eliza-api",
                    parsedActions: remainingExecutableFallbackActions.map(
                      (a) => a.name,
                    ),
                  },
                  "[eliza-api] Unexecuted action payload detected; failing closed",
                );
                const failureText = buildUnexecutedActionPayloadReply(
                  remainingExecutableFallbackActions.map(
                    (action) => action.name,
                  ),
                );
                if (opts?.onSnapshot) {
                  emitSnapshot(failureText);
                } else {
                  responseText = failureText;
                }
                blockedUnexecutedActionPayload = true;
              }
              if (
                remainingExecutableFallbackActions.some(
                  (action) =>
                    normalizeActionName(action.name) === "CHECK_BALANCE",
                )
              ) {
                forcedWalletExecutionText = true;
              }
            }
          }
        }),
      ),
    );
    capturedUsage = generationCapture.usage;
    closeResponseFinalization = getInferenceTimer()?.openSpan(
      "chat:response-finalization",
      {
        phase: "post-model",
      },
    );
    const actionNameLookup = buildRuntimeActionNameLookup(runtime);
    const successfulActionNames = listSuccessfulActionNames(
      runtime,
      typeof message.id === "string" ? message.id : undefined,
      result?.actionResults,
      actionNameLookup,
    );
    for (const actionName of fallbackSuccessfulActionNames) {
      successfulActionNames.add(actionName);
    }
    const successfulTurnActionResults = listSuccessfulActionResults(
      runtime,
      typeof message.id === "string" ? message.id : undefined,
      result?.actionResults,
    );

    const responseMessageText = getLatestVisibleResponseMessageText(
      result?.responseMessages,
    );
    const resultContentCandidates = [
      result?.responseContent,
      ...(result?.responseMessages ?? []).map((entry) => entry.content),
    ];
    const resultText =
      responseMessageText ||
      extractCompatTextContent(result?.responseContent) ||
      "";
    const resultTextVisibility = resolveFinalTranscriptVisibility(
      resultText,
      result?.actionResults,
      resultContentCandidates,
    );

    // Fallback: if callbacks weren't used for text, stream + return final text.
    if (!responseText && resultText && resultTextVisibility !== "internal") {
      if (opts?.onSnapshot) {
        emitSnapshot(resultText);
      } else {
        emitChunk(resultText);
      }
    } else if (
      visibleCallbackDeliveries === 0 &&
      resultText &&
      resultTextVisibility !== "internal" &&
      resultText !== responseText &&
      resultText.startsWith(responseText)
    ) {
      emitChunk(resultText.slice(responseText.length));
    } else if (
      visibleCallbackDeliveries === 0 &&
      resultText &&
      resultTextVisibility !== "internal" &&
      resultText !== responseText &&
      !forcedWalletExecutionText &&
      !blockedUnexecutedActionPayload
    ) {
      if (opts?.onSnapshot) {
        emitSnapshot(resultText);
      } else {
        responseText = resultText;
      }
    }

    if (
      isWalletActionRequiredIntent(originalUserText) &&
      !successfulTurnActionResults.some((actionResult) => {
        const normalizedName = readActionResultName(actionResult);
        const canonicalName =
          actionNameLookup.get(normalizedName) ?? normalizedName;
        return walletActionMatchesIntent(
          originalUserText,
          canonicalName,
          actionResult,
        );
      })
    ) {
      const failureText = buildWalletActionNotExecutedReply(
        runtime,
        originalUserText.trim(),
      );
      if (opts?.onSnapshot) {
        emitSnapshot(failureText);
      } else {
        responseText = failureText;
      }
    }

    const noResponseFallback = opts?.resolveNoResponseText?.();
    const exactDocumentValue = generationAbortController.signal.aborted
      ? null
      : await resolveExactDocumentValueForChat(runtime, message);
    const normalizedResponseText = trimWalletProgressPrefix(
      exactDocumentValue || responseText || resultText || "",
    );
    const intentionalNoResponse = isIntentionalNoResponseResult(
      result,
      normalizedResponseText,
    );
    const finalText = intentionalNoResponse
      ? ""
      : isClientVisibleNoResponse(normalizedResponseText)
        ? (noResponseFallback ??
          (normalizedResponseText || responseText || "(no response)"))
        : normalizedResponseText;
    // A visible action callback and its internal terminal receipt can carry the
    // same canonical text. The receipt stays out of the transcript, but it must
    // not retroactively hide the callback that already owns the turn's response.
    const transcriptVisibility =
      visibleCallbackDeliveries > 0
        ? undefined
        : resolveFinalTranscriptVisibility(
            finalText,
            result?.actionResults,
            resultContentCandidates,
          );

    if (opts?.onChunk && !opts.onSnapshot) {
      const authoritativeText =
        transcriptVisibility === "internal" ? "" : finalText;
      if (!authoritativeText.startsWith(appendOnlyText)) {
        throw new ElizaError(
          "Append-only chat stream diverged from the authoritative final reply",
          {
            code: CHAT_APPEND_ONLY_STREAM_DIVERGENCE,
            severity: "fatal",
            context: {
              emittedChars: appendOnlyText.length,
              finalChars: authoritativeText.length,
              messageId: message.id,
              roomId: message.roomId,
            },
          },
        );
      }
      const remainingText = authoritativeText.slice(appendOnlyText.length);
      if (remainingText) {
        markFirstVisibleReply();
        opts.onChunk(remainingText);
        appendOnlyText += remainingText;
      }
    }

    const responseMessages = Array.isArray(result?.responseMessages)
      ? result.responseMessages
      : [];
    const persistedResponseMessageIds = Array.isArray(
      result?.persistedResponseMessageIds,
    )
      ? result.persistedResponseMessageIds.filter(
          (id): id is UUID => typeof id === "string" && id.length > 0,
        )
      : [];
    const responseContent: Content | null =
      result?.responseContent && typeof result.responseContent === "object"
        ? (() => {
            const content = {
              ...result.responseContent,
              text: finalText,
            } satisfies Content;
            delete content.transcriptVisibility;
            if (transcriptVisibility) {
              content.transcriptVisibility = transcriptVisibility;
            }
            return content;
          })()
        : finalText
          ? ({
              text: finalText,
              ...(transcriptVisibility ? { transcriptVisibility } : {}),
            } satisfies Content)
          : null;
    const responseRecord = responseContent as
      | (Record<string, unknown> & {
          localInference?: LocalInferenceChatMetadata;
          failureKind?: ChatFailureKind;
          accountConnect?: unknown;
        })
      | null;
    const accountConnect = normalizeAccountConnectRequest(
      responseRecord?.accountConnect,
    );
    const localInference =
      responseRecord?.localInference &&
      typeof responseRecord.localInference === "object"
        ? responseRecord.localInference
        : undefined;
    const responseMetadata = asRecord(responseRecord?.metadata);
    const rawFailureKind =
      typeof responseRecord?.failureKind === "string"
        ? responseRecord.failureKind
        : typeof responseMetadata?.chatFailureKind === "string"
          ? responseMetadata.chatFailureKind
          : undefined;
    const failureKind = parseChatFailureKind(rawFailureKind);

    const thought =
      typeof responseContent?.thought === "string" &&
      responseContent.thought.trim()
        ? responseContent.thought
        : undefined;
    const actionResultSummaries = summarizeRuntimeActionResults(
      runtime,
      typeof message.id === "string" ? message.id : undefined,
      result?.actionResults,
    );
    const successfulDeliveredActionCallbacks = deliveredActionCallbacks.filter(
      (entry) => {
        const canonicalName =
          actionNameLookup.get(entry.actionName) ?? entry.actionName;
        return successfulActionNames.has(canonicalName);
      },
    );
    const actionCallbackHistory = successfulDeliveredActionCallbacks.reduce<
      string[]
    >((history, entry) => {
      if (entry.text && history.at(-1) !== entry.text) {
        history.push(entry.text);
      }
      return history;
    }, []);
    const declaredResultActionNames = new Set(
      (Array.isArray(result?.responseContent?.actions)
        ? result.responseContent.actions
        : []
      )
        .map((actionName) => {
          const normalizedName = normalizeActionName(actionName);
          return actionNameLookup.get(normalizedName) ?? normalizedName;
        })
        .filter((actionName) => actionName.length > 0),
    );
    const successfulActionMode =
      result?.mode === "actions" &&
      [...declaredResultActionNames].some((actionName) =>
        successfulActionNames.has(actionName),
      );
    const usedActionCallbacks =
      successfulDeliveredActionCallbacks.length > 0 || successfulActionMode;

    return {
      text: finalText,
      agentName,
      ...(transcriptVisibility ? { transcriptVisibility } : {}),
      ...(thought ? { thought } : {}),
      ...(intentionalNoResponse
        ? { noResponseReason: "ignored" as const }
        : {}),
      ...(failureKind ? { failureKind } : {}),
      ...(accountConnect ? { accountConnect } : {}),
      ...(localInference ? { localInference } : {}),
      ...(usedActionCallbacks ? { usedActionCallbacks: true } : {}),
      ...(actionCallbackHistory.length > 0
        ? { actionCallbackHistory: [...actionCallbackHistory] }
        : {}),
      ...(actionResultSummaries.length > 0
        ? { actionResults: actionResultSummaries }
        : {}),
      ...(responseContent ? { responseContent } : {}),
      ...(responseMessages.length > 0 ? { responseMessages } : {}),
      ...(persistedResponseMessageIds.length > 0
        ? { persistedResponseMessageIds }
        : {}),
      usage: buildChatUsage(runtime, message, finalText, capturedUsage),
    };
  } finally {
    opts?.abortSignal?.removeEventListener("abort", onExternalAbort);
    scheduleMessageTrajectoryGroupingPersistence(runtime, message);
    closeResponseFinalization?.();
  }
}

async function generateOwnedChatResponse(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  agentName: string,
  opts?: ChatGenerateOptions,
): Promise<ChatGenerationResult> {
  const timeoutMs = resolveChatGenerationTimeoutMs();
  const existingTimer = getInferenceTimer();
  if (existingTimer) {
    const result = await runWithGenerationTimeout(
      timeoutMs,
      () => createChatGenerationTimeoutError(timeoutMs),
      opts,
      (timedOpts) =>
        generateChatResponseWithTiming(runtime, message, agentName, timedOpts),
    );
    markInference(INFERENCE_MARKS.responseFinalized);
    return result;
  }

  const timer = new InferenceTurnTimer({
    turnId: nextInferenceTurnId(),
    label: "chat-request",
    roomId: message.roomId,
  });
  return runWithInferenceTiming(timer, async () => {
    try {
      const result = await runWithGenerationTimeout(
        timeoutMs,
        () => createChatGenerationTimeoutError(timeoutMs),
        opts,
        (timedOpts) =>
          generateChatResponseWithTiming(
            runtime,
            message,
            agentName,
            timedOpts,
          ),
      );
      markInference(INFERENCE_MARKS.responseFinalized);
      return result;
    } finally {
      const summary = emitInferenceTiming(timer);
      if (summary) {
        void persistInferenceTimingSummary(runtime, message, summary).catch(
          (error) => {
            // error-policy:J7 latency persistence must not turn a completed
            // chat response into a failed request.
            runtime.reportError(
              "ChatRoutes.persistInferenceTimingSummary",
              error,
              { messageId: message.id, roomId: message.roomId },
            );
          },
        );
      }
    }
  });
}

export async function generateChatResponse(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  agentName: string,
  opts?: ChatGenerateOptions,
): Promise<ChatGenerationResult> {
  const runOwned = async (
    roomHandlerLease: RoomHandlerLease,
  ): Promise<ChatGenerationResult> => {
    try {
      return await generateOwnedChatResponse(runtime, message, agentName, {
        ...opts,
        roomHandlerLease,
      });
    } finally {
      await drainRoomPostDeliveryTasks(runtime, message.roomId);
    }
  };

  const inheritedLease = runtime.roomHandlerQueue.currentLease(message.roomId);
  const requestedLease = opts?.roomHandlerLease ?? inheritedLease;
  if (requestedLease) {
    if (!runtime.roomHandlerQueue.ownsLease(message.roomId, requestedLease)) {
      throw new ElizaError("Chat generation has no live room ownership", {
        code: "CHAT_ROOM_LEASE_MISMATCH",
        context: { roomId: message.roomId, messageId: message.id },
      });
    }
    if (inheritedLease === requestedLease) {
      return runOwned(requestedLease);
    }
    return runtime.roomHandlerQueue.runInLease(
      message.roomId,
      requestedLease,
      () => runOwned(requestedLease),
    );
  }

  return runtime.roomHandlerQueue.withLease(message.roomId, runOwned, {
    signal: opts?.abortSignal,
  });
}

// ---------------------------------------------------------------------------
// generateConversationTitle
// ---------------------------------------------------------------------------

interface ConversationTitleGenerationOptions {
  signal?: AbortSignal;
}

export async function generateConversationTitle(
  runtime: AgentRuntime,
  userMessage: string,
  agentName: string,
  options?: ConversationTitleGenerationOptions,
): Promise<string | null> {
  const modelClass = ModelType.TEXT_SMALL;

  const prompt = `Based on the user's first message in a new chat, generate a very short, concise title (max 4-5 words) for the conversation.
The agent's name is "${agentName}". The title should reflect the topic or intent of the user.
Ideally, the title should fit the persona/vibe of the agent if possible, but clarity is more important.
Do not use quotes. Do not include "Title:" prefix.

User message: "${userMessage}"

Title:`;

  const title = await runtime.useModel(modelClass, {
    prompt,
    maxTokens: 20,
    temperature: 0.7,
    signal: options?.signal,
  });

  if (!title) return null;

  let cleanTitle = title.trim();
  if (
    (cleanTitle.startsWith('"') && cleanTitle.endsWith('"')) ||
    (cleanTitle.startsWith("'") && cleanTitle.endsWith("'"))
  ) {
    cleanTitle = cleanTitle.slice(1, -1);
  }

  if (!cleanTitle || cleanTitle.length > 50) return null;

  return cleanTitle;
}

// ---------------------------------------------------------------------------
// State interface required by chat routes
// ---------------------------------------------------------------------------

export interface ChatRouteState {
  runtime: AgentRuntime | null;
  config: ElizaConfig;
  agentName: string;
  logBuffer: LogEntry[];
  chatRoomId: UUID | null;
  chatUserId: UUID | null;
  chatConnectionReady: { userId: UUID; roomId: UUID; worldId: UUID } | null;
  chatConnectionPromise: Promise<void> | null;
  adminEntityId: UUID | null;
  /** Wallet trade permission mode for wallet-mode guidance replies. */
  tradePermissionMode?: string;
}

export interface ChatRouteContext extends RouteRequestContext {
  state: ChatRouteState;
  callerAuthorization?: AgentHttpRequestAuthorization;
}

export function resolveChatAdminEntityId(state: ChatRouteState): UUID {
  return resolveClientChatAdminEntityId(state);
}

async function ensureCompatChatConnection(
  state: ChatRouteState,
  runtime: AgentRuntime,
  agentName: string,
  channelIdPrefix: string,
  roomKey: string,
  principal: TrustedApiPrincipal,
): Promise<{ userId: UUID; roomId: UUID; worldId: UUID }> {
  const ownerPrincipal =
    principal.kind === "owner_session" || principal.kind === "owner_api_token";
  const userId = ownerPrincipal
    ? ensureAdminEntityIdForChat(state)
    : (stringToUuid(
        `${agentName}:${channelIdPrefix}:external:${principal.principalId}`,
      ) as UUID);
  const principalScopedRoomKey = ownerPrincipal
    ? roomKey
    : `${principal.kind}:${principal.principalId}:${roomKey}`;
  const roomId = stringToUuid(
    `${agentName}-${channelIdPrefix}-room-${principalScopedRoomKey}`,
  ) as UUID;
  const worldId = stringToUuid(`${agentName}-web-chat-world`) as UUID;
  const messageServerId = stringToUuid(`${agentName}-web-server`) as UUID;

  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: resolveAppUserName(state.config),
    source: MESSAGE_SOURCE_CLIENT_CHAT,
    channelId: `${channelIdPrefix}-${principalScopedRoomKey}`,
    type: ChannelType.API,
    messageServerId,
    metadata: ownerPrincipal ? { ownership: { ownerId: userId } } : {},
  });

  if (!ownerPrincipal) {
    return { userId, roomId, worldId };
  }

  // Ensure world ownership only for a directly authenticated owner principal.
  const world = await runtime.getWorld(worldId);
  if (world) {
    let needsUpdate = false;
    if (!world.metadata) {
      world.metadata = {};
      needsUpdate = true;
    }
    if (
      !world.metadata.ownership ||
      typeof world.metadata.ownership !== "object" ||
      (world.metadata.ownership as { ownerId?: string }).ownerId !== userId
    ) {
      world.metadata.ownership = { ownerId: userId };
      needsUpdate = true;
    }
    // Record the deployed-app owner as an explicit, auditable grant
    // (roles[ownerId]="OWNER" + roleSources[ownerId]="owner") rather than an
    // emergent inference — #9948.
    if (recordOwnerGrant(world.metadata as RolesWorldMetadata, userId)) {
      needsUpdate = true;
    }
    if (needsUpdate) {
      await runtime.updateWorld(world);
    }
  }

  return { userId, roomId, worldId };
}

function ensureAdminEntityIdForChat(state: ChatRouteState): UUID {
  return resolveChatAdminEntityId(state);
}

export function resolveTrustedApiPrincipal(
  req: http.IncomingMessage,
  authorization: AgentHttpRequestAuthorization | undefined,
): TrustedApiPrincipal {
  if (isServerTokenAuthorized(req)) {
    return {
      kind: "service_gateway",
      principalId: authorization?.principal ?? "shared-server-gateway",
    };
  }
  if (authorization?.ok && authorization.role === "OWNER") {
    return {
      kind: "owner_session",
      principalId:
        authorization.identityId ??
        authorization.principal ??
        "authenticated-owner-session",
    };
  }
  if (authorization?.ok) {
    return {
      kind: "service_gateway",
      principalId:
        authorization.identityId ??
        authorization.principal ??
        "authenticated-external-session",
    };
  }
  if (isAuthorized(req)) {
    return {
      kind: "owner_api_token",
      principalId: "direct-owner-api",
    };
  }
  return {
    kind: "service_gateway",
    principalId: "non-owner-api",
  };
}

function syncRuntimeCharacterToChatStateConfig(state: ChatRouteState): void {
  if (!state.runtime || !state.config) {
    return;
  }

  syncCharacterIntoConfig(
    state.config,
    state.runtime.character as Parameters<typeof syncCharacterIntoConfig>[1],
  );
}

// ---------------------------------------------------------------------------
// Main route handler
// ---------------------------------------------------------------------------

export async function handleChatRoutes(
  ctx: ChatRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, readJsonBody, json, state } = ctx;
  const trustedApiPrincipal = resolveTrustedApiPrincipal(
    req,
    ctx.callerAuthorization,
  );

  // ── GET /v1/models (OpenAI compatible) ─────────────────────────────────
  if (method === "GET" && pathname === "/v1/models") {
    const created = Math.floor(Date.now() / 1000);
    const ids = new Set<string>();
    ids.add("eliza");
    if (state.agentName.trim()) ids.add(state.agentName.trim());
    if (state.runtime?.character.name?.trim())
      ids.add(state.runtime.character.name.trim());

    json(res, {
      object: "list",
      data: Array.from(ids).map((id) => ({
        id,
        object: "model",
        created,
        owned_by: "eliza",
      })),
    });
    return true;
  }

  // ── GET /v1/models/:id (OpenAI compatible) ─────────────────────────────
  if (method === "GET" && /^\/v1\/models\/[^/]+$/.test(pathname)) {
    const created = Math.floor(Date.now() / 1000);
    const raw = pathname.split("/")[3] ?? "";
    const decoded = decodePathComponent(raw, res, "model id");
    if (!decoded) return true;
    const id = decoded.trim();
    if (!id) {
      json(
        res,
        {
          error: {
            message: "Model id is required",
            type: "invalid_request_error",
          },
        },
        400,
      );
      return true;
    }
    json(res, { id, object: "model", created, owned_by: "eliza" });
    return true;
  }

  // ── POST /v1/chat/completions (OpenAI compatible) ──────────────────────
  if (method === "POST" && pathname === "/v1/chat/completions") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    if (hasBlockedObjectKeyDeep(body)) {
      json(
        res,
        {
          error: {
            message: "Request body contains a blocked object key",
            type: "invalid_request_error",
          },
        },
        400,
      );
      return true;
    }
    const safeBody = cloneWithoutBlockedObjectKeys(body);

    const extracted = extractOpenAiSystemAndLastUser(safeBody.messages);
    if (!extracted) {
      json(
        res,
        {
          error: {
            message:
              "messages must be an array containing at least one user message",
            type: "invalid_request_error",
          },
        },
        400,
      );
      return true;
    }

    const roomKey = resolveCompatRoomKey(safeBody).slice(0, 120);
    const wantsStream =
      safeBody.stream === true ||
      (req.headers.accept ?? "").includes("text/event-stream");
    const requestedModel =
      typeof safeBody.model === "string" && safeBody.model.trim()
        ? safeBody.model.trim()
        : null;

    const prompt = extracted.system
      ? `${extracted.system}\n\n${extracted.user}`.trim()
      : extracted.user;

    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const model = requestedModel ?? state.agentName;

    if (wantsStream) {
      initSse(res);
      const disconnectTracker = createStreamingResponseAbortTracker(
        req,
        res,
        "OpenAI-compatible stream",
      );

      const sendChunk = (
        delta: Record<string, unknown>,
        finishReason: string | null,
      ) => {
        writeSseData(
          res,
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta,
                finish_reason: finishReason,
              },
            ],
          }),
        );
      };

      try {
        if (!state.runtime) {
          writeSseData(
            res,
            JSON.stringify({
              error: {
                message: "Agent is not running",
                type: "service_unavailable",
              },
            }),
          );
          writeSseData(res, "[DONE]");
          return true;
        }

        sendChunk({ role: "assistant" }, null);

        let fullText = "";
        let transcriptVisibility: "internal" | undefined;

        {
          const runtime = state.runtime;
          if (!runtime) throw new Error("Agent is not running");
          const agentName = runtime.character.name ?? "Eliza";
          const { userId, roomId } = await ensureCompatChatConnection(
            state,
            runtime,
            agentName,
            "openai-compat",
            roomKey,
            trustedApiPrincipal,
          );

          const message = createMessageMemory({
            id: crypto.randomUUID() as UUID,
            entityId: userId,
            agentId: runtime.agentId,
            roomId,
            content: {
              text: prompt,
              source: "compat_openai",
              channelType: ChannelType.API,
            },
          });
          await attestAuthenticatedApiDeliveryAudience(
            runtime,
            message,
            trustedApiPrincipal,
          );

          const result = await generateChatResponse(
            runtime,
            message,
            state.agentName,
            {
              abortSignal: disconnectTracker.signal,
              onChunk: (chunk) => {
                fullText += chunk;
                if (chunk) sendChunk({ content: chunk }, null);
              },
              resolveNoResponseText: () =>
                resolveNoResponseFallback(state.logBuffer, runtime),
            },
          );
          transcriptVisibility = result.transcriptVisibility;
          if (result.localInference && !fullText) {
            fullText =
              result.transcriptVisibility === "internal" ? "" : result.text;
            if (fullText) {
              sendChunk({ content: fullText }, null);
            }
          }
          syncRuntimeCharacterToChatStateConfig(state);
        }

        const resolved = normalizeChatResponseText(
          fullText,
          state.logBuffer,
          state.runtime,
        );
        if (
          (fullText.trim().length === 0 || isNoResponsePlaceholder(fullText)) &&
          resolved.trim() &&
          transcriptVisibility !== "internal"
        ) {
          sendChunk({ content: resolved }, null);
        }

        sendChunk({}, "stop");
        writeSseData(res, "[DONE]");
      } catch (err) {
        if (!disconnectTracker.signal.aborted) {
          if (isLocalInferenceError(err)) {
            const { getLocalInferenceChatStatus } =
              await getLocalInferenceChatApi();
            const localFailure = await getLocalInferenceChatStatus(
              "status",
              err,
            );
            writeSseData(
              res,
              JSON.stringify({
                error: {
                  message: localFailure.text,
                  type: "local_inference",
                  localInference: localFailure.localInference,
                },
              }),
            );
          } else if (isNoProviderError(err)) {
            writeSseData(
              res,
              JSON.stringify({
                error: {
                  message: NO_PROVIDER_CHAT_MESSAGE,
                  type: "no_provider",
                  code: "NO_PROVIDER_REGISTERED",
                },
              }),
            );
          } else {
            writeSseData(
              res,
              JSON.stringify({
                error: {
                  message: getErrorMessage(err),
                  type: isAppendOnlyStreamDivergenceError(err)
                    ? "stream_error"
                    : "server_error",
                  ...(isAppendOnlyStreamDivergenceError(err)
                    ? { code: err.code }
                    : {}),
                },
              }),
            );
          }
          if (!isAppendOnlyStreamDivergenceError(err)) {
            writeSseData(res, "[DONE]");
          }
        }
      } finally {
        disconnectTracker.markCompleted();
        disconnectTracker.dispose();
        res.end();
      }
      return true;
    }

    // Non-streaming
    try {
      let responseText: string;
      let localInference: LocalInferenceChatMetadata | undefined;
      let failureKind: ChatFailureKind | undefined;
      let transcriptVisibility: "internal" | undefined;

      {
        if (!state.runtime) {
          json(
            res,
            {
              error: {
                message: "Agent is not running",
                type: "service_unavailable",
              },
            },
            503,
          );
          return true;
        }
        const runtime = state.runtime;
        const agentName = runtime.character.name ?? "Eliza";
        const { userId, roomId } = await ensureCompatChatConnection(
          state,
          runtime,
          agentName,
          "openai-compat",
          roomKey,
          trustedApiPrincipal,
        );
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          agentId: runtime.agentId,
          roomId,
          content: {
            text: prompt,
            source: "compat_openai",
            channelType: ChannelType.API,
          },
        });
        await attestAuthenticatedApiDeliveryAudience(
          runtime,
          message,
          trustedApiPrincipal,
        );
        const result = await generateChatResponse(
          runtime,
          message,
          state.agentName,
          {
            resolveNoResponseText: () =>
              resolveNoResponseFallback(state.logBuffer, runtime),
          },
        );
        syncRuntimeCharacterToChatStateConfig(state);
        transcriptVisibility = result.transcriptVisibility;
        responseText =
          result.transcriptVisibility === "internal" ? "" : result.text;
        localInference = result.localInference;
        failureKind = result.failureKind;
      }

      if (failureKind === "no_provider") {
        json(
          res,
          {
            error: {
              message: NO_PROVIDER_CHAT_MESSAGE,
              type: "no_provider",
              code: "NO_PROVIDER_REGISTERED",
            },
          },
          503,
        );
        return true;
      }

      const resolvedText =
        transcriptVisibility === "internal"
          ? ""
          : normalizeChatResponseText(
              responseText,
              state.logBuffer,
              state.runtime,
            );
      json(res, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: resolvedText },
            finish_reason: "stop",
          },
        ],
        ...(failureKind ? { failureKind } : {}),
        ...(localInference ? { localInference } : {}),
      });
    } catch (err) {
      if (isLocalInferenceError(err)) {
        const { getLocalInferenceChatStatus } =
          await getLocalInferenceChatApi();
        const localFailure = await getLocalInferenceChatStatus("status", err);
        json(
          res,
          {
            error: {
              message: localFailure.text,
              type: "local_inference",
              localInference: localFailure.localInference,
            },
          },
          503,
        );
      } else if (isNoProviderError(err)) {
        json(
          res,
          {
            error: {
              message: NO_PROVIDER_CHAT_MESSAGE,
              type: "no_provider",
              code: "NO_PROVIDER_REGISTERED",
            },
          },
          503,
        );
      } else {
        json(
          res,
          { error: { message: getErrorMessage(err), type: "server_error" } },
          500,
        );
      }
    }
    return true;
  }

  // ── POST /v1/messages (Anthropic compatible) ───────────────────────────
  if (method === "POST" && pathname === "/v1/messages") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    if (hasBlockedObjectKeyDeep(body)) {
      json(
        res,
        {
          error: {
            type: "invalid_request_error",
            message: "Request body contains a blocked object key",
          },
        },
        400,
      );
      return true;
    }
    const safeBody = cloneWithoutBlockedObjectKeys(body);

    const extracted = extractAnthropicSystemAndLastUser({
      system: safeBody.system,
      messages: safeBody.messages,
    });
    if (!extracted) {
      json(
        res,
        {
          error: {
            type: "invalid_request_error",
            message:
              "messages must be an array containing at least one user message",
          },
        },
        400,
      );
      return true;
    }

    const roomKey = resolveCompatRoomKey(safeBody).slice(0, 120);
    const wantsStream =
      safeBody.stream === true ||
      (req.headers.accept ?? "").includes("text/event-stream");
    const requestedModel =
      typeof safeBody.model === "string" && safeBody.model.trim()
        ? safeBody.model.trim()
        : null;

    const prompt = extracted.system
      ? `${extracted.system}\n\n${extracted.user}`.trim()
      : extracted.user;

    const id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const model = requestedModel ?? state.agentName;

    if (wantsStream) {
      initSse(res);
      const disconnectTracker = createStreamingResponseAbortTracker(
        req,
        res,
        "Anthropic-compatible stream",
      );

      try {
        if (!state.runtime) {
          writeSseJson(
            res,
            {
              type: "error",
              error: {
                type: "service_unavailable",
                message: "Agent is not running",
              },
            },
            "error",
          );
          return true;
        }

        // Anthropic's wire format reports input_tokens on message_start (the
        // prompt is fully known here) and accumulates output_tokens on the
        // closing message_delta. We don't have a real model-side prompt count
        // before generation, so input_tokens is the same heuristic estimate the
        // rest of this file uses (estimateTokenCount); output_tokens is filled
        // from the real generation result below.
        const inputTokens = estimateTokenCount(prompt);
        writeSseJson(
          res,
          {
            type: "message_start",
            message: {
              id,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
          },
          "message_start",
        );
        writeSseJson(
          res,
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          "content_block_start",
        );

        let fullText = "";
        let outputTokens = 0;
        let transcriptVisibility: "internal" | undefined;

        const onDelta = (chunk: string) => {
          if (!chunk) return;
          fullText += chunk;
          writeSseJson(
            res,
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: chunk },
            },
            "content_block_delta",
          );
        };

        {
          const runtime = state.runtime;
          if (!runtime) throw new Error("Agent is not running");
          const agentName = runtime.character.name ?? "Eliza";
          const { userId, roomId } = await ensureCompatChatConnection(
            state,
            runtime,
            agentName,
            "anthropic-compat",
            roomKey,
            trustedApiPrincipal,
          );

          const message = createMessageMemory({
            id: crypto.randomUUID() as UUID,
            entityId: userId,
            agentId: runtime.agentId,
            roomId,
            content: {
              text: prompt,
              source: "compat_anthropic",
              channelType: ChannelType.API,
            },
          });
          await attestAuthenticatedApiDeliveryAudience(
            runtime,
            message,
            trustedApiPrincipal,
          );

          const generation = await generateChatResponse(
            runtime,
            message,
            state.agentName,
            {
              abortSignal: disconnectTracker.signal,
              onChunk: onDelta,
              resolveNoResponseText: () =>
                resolveNoResponseFallback(state.logBuffer, runtime),
            },
          );
          transcriptVisibility = generation.transcriptVisibility;
          outputTokens = generation.usage?.completionTokens ?? outputTokens;
          syncRuntimeCharacterToChatStateConfig(state);
        }

        const resolved = normalizeChatResponseText(
          fullText,
          state.logBuffer,
          state.runtime,
        );
        if (
          (fullText.trim().length === 0 || isNoResponsePlaceholder(fullText)) &&
          resolved.trim() &&
          transcriptVisibility !== "internal"
        ) {
          onDelta(resolved);
        }

        writeSseJson(
          res,
          { type: "content_block_stop", index: 0 },
          "content_block_stop",
        );
        writeSseJson(
          res,
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: {
              output_tokens:
                outputTokens > 0 ? outputTokens : estimateTokenCount(fullText),
            },
          },
          "message_delta",
        );
        writeSseJson(res, { type: "message_stop" }, "message_stop");
      } catch (err) {
        if (!disconnectTracker.signal.aborted) {
          if (isNoProviderError(err)) {
            writeSseJson(
              res,
              {
                type: "error",
                error: {
                  type: "no_provider",
                  code: "NO_PROVIDER_REGISTERED",
                  message: NO_PROVIDER_CHAT_MESSAGE,
                },
              },
              "error",
            );
          } else {
            writeSseJson(
              res,
              {
                type: "error",
                error: {
                  type: isAppendOnlyStreamDivergenceError(err)
                    ? "stream_error"
                    : "server_error",
                  message: getErrorMessage(err),
                  ...(isAppendOnlyStreamDivergenceError(err)
                    ? { code: err.code }
                    : {}),
                },
              },
              "error",
            );
          }
        }
      } finally {
        disconnectTracker.markCompleted();
        disconnectTracker.dispose();
        res.end();
      }
      return true;
    }

    // Non-streaming
    try {
      let responseText: string;
      let inputTokens = estimateTokenCount(prompt);
      let outputTokens = 0;
      let transcriptVisibility: "internal" | undefined;

      {
        if (!state.runtime) {
          json(
            res,
            {
              error: {
                type: "service_unavailable",
                message: "Agent is not running",
              },
            },
            503,
          );
          return true;
        }
        const runtime = state.runtime;
        const agentName = runtime.character.name ?? "Eliza";
        const { userId, roomId } = await ensureCompatChatConnection(
          state,
          runtime,
          agentName,
          "anthropic-compat",
          roomKey,
          trustedApiPrincipal,
        );
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          agentId: runtime.agentId,
          roomId,
          content: {
            text: prompt,
            source: "compat_anthropic",
            channelType: ChannelType.API,
          },
        });
        await attestAuthenticatedApiDeliveryAudience(
          runtime,
          message,
          trustedApiPrincipal,
        );
        const result = await generateChatResponse(
          runtime,
          message,
          state.agentName,
          {
            resolveNoResponseText: () =>
              resolveNoResponseFallback(state.logBuffer, runtime),
          },
        );
        syncRuntimeCharacterToChatStateConfig(state);
        transcriptVisibility = result.transcriptVisibility;
        responseText =
          result.transcriptVisibility === "internal" ? "" : result.text;
        if (result.usage) {
          inputTokens = result.usage.promptTokens;
          outputTokens = result.usage.completionTokens;
        }
      }

      const resolvedText =
        transcriptVisibility === "internal"
          ? ""
          : normalizeChatResponseText(
              responseText,
              state.logBuffer,
              state.runtime,
            );
      json(res, {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: resolvedText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens:
            outputTokens > 0 ? outputTokens : estimateTokenCount(resolvedText),
        },
      });
    } catch (err) {
      if (isNoProviderError(err)) {
        json(
          res,
          {
            error: {
              type: "no_provider",
              code: "NO_PROVIDER_REGISTERED",
              message: NO_PROVIDER_CHAT_MESSAGE,
            },
          },
          503,
        );
      } else {
        json(
          res,
          { error: { type: "server_error", message: getErrorMessage(err) } },
          500,
        );
      }
    }
    return true;
  }

  // ── POST /api/agents/:id/message ───────────────────────────────────────
  // Local-mode mirror of the cloud agent-server's per-agent message
  // endpoint (`packages/cloud/services/agent-server/src/routes.ts`). Shares the
  // same `generateChatResponse` path as `/v1/chat/completions` so model
  // routing (incl. local-inference TEXT_LARGE handlers) is identical.
  if (method === "POST" && /^\/api\/agents\/[^/]+\/message$/.test(pathname)) {
    const rawId = pathname.split("/")[3] ?? "";
    const decoded = decodePathComponent(rawId, res, "agent id");
    if (!decoded) return true;
    const agentIdParam = decoded.trim();
    if (!agentIdParam) {
      json(res, { error: "agent id is required" }, 400);
      return true;
    }

    if (!state.runtime) {
      json(res, { error: "Agent is not running" }, 503);
      return true;
    }

    // Surface a 404 only when the caller targeted an agent that this
    // process doesn't actually run — distinct from "route missing", which
    // is what the original issue (#7680) was reporting.
    if (state.runtime.agentId !== agentIdParam) {
      json(res, { error: "Agent not found" }, 404);
      return true;
    }

    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    if (hasBlockedObjectKeyDeep(body)) {
      json(res, { error: "Request body contains a blocked object key" }, 400);
      return true;
    }
    const safeBody = cloneWithoutBlockedObjectKeys(body);

    const userId =
      typeof safeBody.userId === "string" && safeBody.userId.trim().length > 0
        ? safeBody.userId.trim()
        : null;
    const text =
      typeof safeBody.text === "string" && safeBody.text.trim().length > 0
        ? safeBody.text
        : null;
    if (!userId || !text) {
      json(res, { error: "userId and text are required" }, 400);
      return true;
    }

    try {
      const runtime = state.runtime;
      const agentName = runtime.character.name ?? "Eliza";
      const messagePrincipal: TrustedApiPrincipal =
        trustedApiPrincipal.kind === "service_gateway"
          ? {
              kind: "service_gateway",
              principalId: `${trustedApiPrincipal.principalId}:${userId}`,
            }
          : trustedApiPrincipal;
      // Per-user room key — matches cloud `handleMessage`'s
      // `stringToUuid(\`${agentId}:${userId}\`)` shape closely enough that
      // both surfaces produce stable, user-scoped conversation rooms.
      const { roomId, userId: connUserId } = await ensureCompatChatConnection(
        state,
        runtime,
        agentName,
        "agent-message",
        `${agentIdParam}:${userId}`.slice(0, 120),
        messagePrincipal,
      );

      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: connUserId,
        agentId: runtime.agentId,
        roomId,
        content: {
          text,
          source: "agent_message_api",
          channelType: ChannelType.API,
        },
      });
      await attestAuthenticatedApiDeliveryAudience(
        runtime,
        message,
        messagePrincipal,
      );

      const result = await generateChatResponse(
        runtime,
        message,
        state.agentName,
        {
          resolveNoResponseText: () =>
            resolveNoResponseFallback(state.logBuffer, runtime),
        },
      );
      syncRuntimeCharacterToChatStateConfig(state);

      const resolvedText =
        result.transcriptVisibility === "internal"
          ? ""
          : normalizeChatResponseText(
              result.text,
              state.logBuffer,
              state.runtime,
            );

      json(res, {
        response: renderChatSurfaceText(resolvedText),
        agentName: result.agentName,
        ...(result.failureKind ? { failureKind: result.failureKind } : {}),
        ...(result.localInference
          ? { localInference: result.localInference }
          : {}),
      });
    } catch (err) {
      if (isLocalInferenceError(err)) {
        const { getLocalInferenceChatStatus } =
          await getLocalInferenceChatApi();
        const localFailure = await getLocalInferenceChatStatus("status", err);
        json(
          res,
          {
            error: localFailure.text,
            type: "local_inference",
            localInference: localFailure.localInference,
          },
          503,
        );
      } else if (isNoProviderError(err)) {
        json(
          res,
          {
            error: NO_PROVIDER_CHAT_MESSAGE,
            type: "no_provider",
            code: "NO_PROVIDER_REGISTERED",
          },
          503,
        );
      } else {
        json(res, { error: getErrorMessage(err) }, 500);
      }
    }
    return true;
  }

  return false;
}
