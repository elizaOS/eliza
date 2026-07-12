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
import {
  type ActionResult,
  type AgentRuntime,
  ChannelType,
  type Content,
  createMessageMemory,
  EventType,
  getSwarmCoordinatorService,
  INSUFFICIENT_CREDITS_REPLY,
  isRateLimitError,
  logger,
  MESSAGE_SOURCE_CLIENT_CHAT,
  ModelType,
  type RolesWorldMetadata,
  type RouteRequestContext,
  recordOwnerGrant,
  runWithTrajectoryContext,
  stringToUuid,
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
  readAliasedEnv,
  resolveStreamingUpdate,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import {
  type CapturedModelUsage,
  estimateTokenCount,
  withModelUsageCapture,
} from "../runtime/prompt-optimization.ts";
import { resolveTrajectoryGrouping } from "../runtime/trajectory-internals.ts";
import { startTrajectoryStepInDatabase } from "../runtime/trajectory-storage.ts";
import { syncCharacterIntoConfig } from "../services/character-persistence.ts";
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
import type { ChatImageAttachment } from "./server-types.ts";

export type { ChatImageAttachment, LogEntry };

const DEFAULT_CONVERSATION_TITLE_TIMEOUT_MS = 5_000;

type LocalInferenceChatApi = Pick<
  LocalInferenceRouteApi,
  "getLocalInferenceChatStatus" | "handleLocalInferenceChatCommand"
>;

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

/** Max accepted client-supplied idempotency key length. Anything longer is a
 *  malformed/abusive client and is treated as absent (no dedupe). */
const CLIENT_MESSAGE_ID_MAX_LENGTH = 128;

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
 * the TTL, is NOT suppressed. The TTL must cover the full server generation
 * window plus the client's reconnect retry wait; otherwise a retry after a long
 * but successful turn can land after the arrival timestamp expires and start a
 * second billed LLM turn. The map stays bounded via an amortized sweep (at most
 * once per TTL window) — the same O(1)-check / amortized-eviction shape as the
 * WS cache.
 */
const chatSeenMessageIds = new Map<string, number>();
const DEFAULT_CHAT_GENERATION_TIMEOUT_MS = 180_000;
const CHAT_DEDUPE_RECONNECT_WAIT_MS = 30_000;
const CHAT_DEDUPE_SETTLE_BUFFER_MS = 30_000;
const CHAT_DEDUPE_TTL_MS =
  resolveChatGenerationTimeoutMs() +
  CHAT_DEDUPE_RECONNECT_WAIT_MS +
  CHAT_DEDUPE_SETTLE_BUFFER_MS;
let chatSeenLastSweepAt = 0;

/** Normalize a raw body value into a usable idempotency key, or `null` when
 *  absent/invalid. Exported for unit testing the dedupe decision in isolation. */
export function normalizeClientMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > CLIENT_MESSAGE_ID_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

/**
 * TTL-aware O(1) duplicate check for an HTTP chat send. Returns `true` when this
 * `(scope, clientMessageId)` pair was already seen within the TTL window. When
 * `clientMessageId` is absent/invalid the result is ALWAYS `false`, so requests
 * without an idempotency key behave exactly as before (no dedupe). The first
 * sighting records the timestamp and returns `false`; a repeat within the window
 * returns `true`. After the TTL elapses the id is treated as new again.
 *
 * `scope` is the conversation room id (dashboard chat) or the per-user room key
 * (agent-message API) so the key cannot collide across conversations/users.
 */
export function isDuplicateChatMessage(
  scope: string,
  clientMessageId: string | null,
  now: number = Date.now(),
): boolean {
  if (!clientMessageId) return false;
  const key = `${scope}:${clientMessageId}`;
  const seenAt = chatSeenMessageIds.get(key);
  if (seenAt !== undefined && now - seenAt <= CHAT_DEDUPE_TTL_MS) return true;
  chatSeenMessageIds.set(key, now);
  // Amortized eviction: sweep expired entries at most once per TTL window
  // rather than on every request, keeping the map bounded without a per-request
  // O(n) scan.
  if (now - chatSeenLastSweepAt > CHAT_DEDUPE_TTL_MS) {
    chatSeenLastSweepAt = now;
    for (const [seenKey, ts] of chatSeenMessageIds) {
      if (now - ts > CHAT_DEDUPE_TTL_MS) chatSeenMessageIds.delete(seenKey);
    }
  }
  return false;
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
): void {
  if (!clientMessageId) return;
  chatSeenMessageIds.delete(`${scope}:${clientMessageId}`);
}

/**
 * Original arrival timestamp recorded for a `(scope, clientMessageId)` pair,
 * or `null` when the pair is unknown (never seen, expired and swept, or
 * released). Consulted by the duplicate-suppression branches AFTER
 * {@link isDuplicateChatMessage} returns `true`: the recorded arrival bounds
 * the "since" window for looking up the FIRST attempt's persisted assistant
 * reply, so a retry that lands after delivery can return that reply instead
 * of an empty ignored turn. A duplicate sighting never refreshes the stored
 * timestamp, so this is always the first attempt's arrival.
 */
export function getChatMessageIdFirstSeenAt(
  scope: string,
  clientMessageId: string | null,
): number | null {
  if (!clientMessageId) return null;
  return chatSeenMessageIds.get(`${scope}:${clientMessageId}`) ?? null;
}

/** Test-only: clear the HTTP chat idempotency cache between cases. */
export function __resetChatDedupeForTests(): void {
  chatSeenMessageIds.clear();
  chatSeenLastSweepAt = 0;
}

/** Test-only: expose the configured dedupe window without freezing env policy
 *  into the unit fixtures. */
export function __getChatDedupeTtlMsForTests(): number {
  return CHAT_DEDUPE_TTL_MS;
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
  const optOut = readRuntimeStringSetting(
    runtime,
    "ELIZA_MOBILE_LOCAL_DIRECT_REPLY",
  );
  if (/^(0|false|no|off)$/i.test(optOut ?? "")) {
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

const ANDROID_LOCAL_HISTORY_LIMIT = 6;
const ANDROID_LOCAL_HISTORY_TEXT_LIMIT = 700;

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
      // Allow for the current message already being persisted before generation.
      limit: ANDROID_LOCAL_HISTORY_LIMIT + 1,
      includeEmbedding: false,
    });
    history = recent
      .filter((memory) => memory.id !== args.message.id)
      .sort(compareCreatedAtAscending)
      .slice(-ANDROID_LOCAL_HISTORY_LIMIT)
      .flatMap((memory) => {
        const text = extractCompatTextContent(memory.content).trim();
        if (!text) return [];
        const role =
          memory.entityId === args.runtime.agentId ? "Assistant" : "User";
        return [
          `${role}: ${escapeAndroidLocalChatTemplateTokens(text.slice(0, ANDROID_LOCAL_HISTORY_TEXT_LIMIT))}`,
        ];
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
  if (text.length <= 700) {
    return text;
  }
  const truncated = text.slice(0, 700);
  const sentenceEnd = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("!"),
    truncated.lastIndexOf("?"),
  );
  return (
    sentenceEnd >= 80 ? truncated.slice(0, sentenceEnd + 1) : truncated
  ).trim();
}

async function rewriteDirectActionCallbackText(args: {
  runtime: AgentRuntime;
  actionName: string;
  text: string;
  content?: Content;
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
  responseMessages?: Array<{
    id?: string;
    content?: Content;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
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

export interface ChatGenerateOptions {
  onChunk?: (chunk: string) => void;
  onSnapshot?: (text: string) => void;
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
  isAborted?: () => boolean;
  abortSignal?: AbortSignal;
  resolveNoResponseText?: () => string;
  preferredLanguage?: string;
  timeoutDuration?: number;
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
    if (failed) {
      return {
        toolEvent: {
          phase: "error",
          callId,
          toolName,
          error: firstNonEmptyString(result, statusText) ?? "tool failed",
        },
      };
    }
    return { toolEvent: { phase: "result", callId, toolName, result } };
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
function isNoProviderError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return NO_PROVIDER_ERROR_FRAGMENTS.some((frag) => msg.includes(frag));
}
const NO_PROVIDER_CHAT_MESSAGE =
  "Connect an LLM provider to start chatting. Open Settings → Providers, " +
  "or choose Eliza Cloud during first-run setup.";
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

function listExecutedRuntimeActions(
  runtime: AgentRuntime,
  messageId: UUID | undefined,
): Set<string> {
  return new Set(
    readRuntimeActionResults(runtime, messageId)
      .map((result) => {
        if (typeof result === "string") {
          return normalizeActionName(result);
        }
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
      })
      .filter((name) => name.length > 0),
  );
}

function sanitizeActionResultValue(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return value.length > 1000 ? `${value.slice(0, 997)}...` : value;
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
): ChatActionResultSummary[] {
  return readRuntimeActionResults(runtime, messageId)
    .map(summarizeActionResultForClient)
    .filter((entry): entry is ChatActionResultSummary => Boolean(entry))
    .slice(-8);
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

function resolveChatGenerationTimeoutMs(explicit?: number): number {
  if (
    typeof explicit === "number" &&
    Number.isFinite(explicit) &&
    explicit > 0
  ) {
    return Math.max(1, Math.floor(explicit));
  }

  const fromEnv = readAliasedEnv("ELIZA_CHAT_GENERATION_TIMEOUT_MS");
  if (!fromEnv) return DEFAULT_CHAT_GENERATION_TIMEOUT_MS;

  const parsed = Number.parseInt(fromEnv, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CHAT_GENERATION_TIMEOUT_MS;
  }

  return Math.max(1_000, parsed);
}

function createChatGenerationTimeoutError(timeoutMs: number): Error {
  return new Error(`Chat generation timed out after ${timeoutMs}ms`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          onTimeout?.();
          reject(createError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
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
): void {
  writeSse(res, { type: "token", text, fullText });
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
export interface ChatTokenStreamWriter {
  /** An incremental streamed chunk. `fullText` is the accumulated text so far. */
  writeChunk(res: http.ServerResponse, chunk: string, fullText: string): void;
  /** An authoritative full-text replace (structured-field rewrite, single-frame
   *  reply). The client treats the carried `fullText` as the new buffer. */
  writeSnapshot(res: http.ServerResponse, fullText: string): void;
}

export function createChatTokenStreamWriter(
  protocol: ChatTokenStreamProtocol,
  deps: ChatTokenStreamWriterDeps,
): ChatTokenStreamWriter {
  if (protocol === "legacy") {
    return {
      writeChunk(res, chunk, fullText) {
        deps.writeChatTokenSse(res, chunk, fullText);
      },
      writeSnapshot(res, fullText) {
        deps.writeChatTokenSse(res, fullText, fullText);
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
    writeChunk(res, chunk, fullText) {
      bytesSinceSnapshot += chunk.length;
      if (bytesSinceSnapshot >= Math.max(2048, lengthAtLastSnapshot)) {
        deps.writeSse(res, { type: "token", text: chunk, fullText });
        bytesSinceSnapshot = 0;
        lengthAtLastSnapshot = fullText.length;
      } else {
        deps.writeSse(res, { type: "token", text: chunk });
      }
    },
    writeSnapshot(res, fullText) {
      // No `text` field: the client reads `fullText` as an authoritative
      // replace rather than an append.
      deps.writeSse(res, { type: "token", fullText });
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
): Promise<void> {
  try {
    await runtime.createMemory(memory, "messages");
  } catch (err) {
    if (isDuplicateMemoryError(err)) return;
    throw err;
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
  try {
    const recent = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: 12,
    });

    const persistedAssistantTurn = recent
      .filter((memory) => {
        const contentText = (memory.content as { text?: string })?.text?.trim();
        const createdAt = memory.createdAt ?? 0;
        return (
          memory.entityId === runtime.agentId &&
          Boolean(contentText) &&
          createdAt >= sinceMs - slackMs
        );
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];

    return (
      (
        persistedAssistantTurn?.content as { text?: string } | undefined
      )?.text?.trim() ?? null
    );
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
): Promise<void> {
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
  if (!trimmed) return;

  if (typeof dedupeSinceMs === "number") {
    const alreadyPersisted = await hasRecentAssistantMemory(
      runtime,
      roomId,
      trimmed,
      dedupeSinceMs,
    );
    if (alreadyPersisted) return;
  }

  await persistConversationMemory(
    runtime,
    createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: persistedContent,
    }),
  );
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

async function persistMessageTrajectoryGrouping(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): Promise<void> {
  const stepId = readMessageTrajectoryStepId(message);
  if (!stepId) return;

  const grouping = readMessageTrajectoryGrouping(message);
  if (!grouping.scenarioId && !grouping.batchId) return;

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

export async function generateChatResponse(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  agentName: string,
  opts?: ChatGenerateOptions,
): Promise<ChatGenerationResult> {
  const generationTimeoutMs = resolveChatGenerationTimeoutMs(
    opts?.timeoutDuration,
  );
  let generationTimedOut = false;
  if (generationTimeoutMs <= 1) {
    generationTimedOut = true;
    throw createChatGenerationTimeoutError(generationTimeoutMs);
  }
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
  try {
    const originalUserText = String(extractCompatTextContent(message.content));
    type StreamSource = "unset" | "callback" | "onStreamChunk";
    let responseText = "";
    let forcedWalletExecutionText = false;
    let blockedUnexecutedActionPayload = false;
    let activeStreamSource: StreamSource = "unset";
    const actionCallbackHistory: string[] = [];
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
    const emitChunk = (chunk: string): void => {
      if (!chunk) return;
      responseText += chunk;
      opts?.onChunk?.(chunk);
    };
    const emitSnapshot = (text: string): void => {
      if (!text) return;
      // Skip when the snapshot matches the current responseText exactly:
      // re-emitting the same fullText forces clients to re-render an identical
      // bubble (and on-the-wire bytes for nothing).
      if (text === responseText) return;
      responseText = text;
      opts?.onSnapshot?.(text);
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
    const appendIncomingText = (incoming: string): void => {
      const update = resolveStreamingUpdate(responseText, incoming);
      if (update.kind === "unchanged") return;
      if (update.kind === "append") {
        emitChunk(update.emittedText);
        return;
      }
      emitSnapshot(update.nextText);
    };
    const captureCallbackBaseline = (): void => {
      if (preCallbackText === null) {
        preCallbackText = responseText;
      }
    };
    const recordActionCallbackText = (incoming: string): void => {
      const normalized = normalizeActionCallbackText(incoming);
      if (!normalized) return;
      if (actionCallbackHistory.at(-1) === normalized) return;
      actionCallbackHistory.push(normalized);
    };
    /** Latest action callback wins: replaces prior callback text, keeps LLM prefix. */
    const replaceCallbackText = (incoming: string): void => {
      recordActionCallbackText(incoming);
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
      if (nextText.startsWith(responseText) && responseText.length > 0) {
        const delta = nextText.slice(responseText.length);
        emitChunk(delta);
        // emitChunk already advanced responseText; re-emit snapshot for
        // legacy clients that only handle fullText updates.
        opts?.onSnapshot?.(nextText);
        return;
      }
      emitSnapshot(nextText);
    };
    const applyCallbackTextUpdate = (
      content: Content,
      incoming: string,
    ): void => {
      captureCallbackBaseline();
      if (resolveCallbackMergeMode(content) === "append") {
        recordActionCallbackText(incoming);
        appendIncomingText(incoming);
        return;
      }
      replaceCallbackText(incoming);
    };

    // Emit inbound events so trajectory/session hooks run for API chat.
    try {
      if (typeof runtime.emitEvent === "function") {
        await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
          message,
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
        "Failed to emit MESSAGE_RECEIVED event",
      );
    }
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
      try {
        if (
          androidDirectResult.responseContent &&
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

    let result:
      | Awaited<
          ReturnType<
            NonNullable<AgentRuntime["messageService"]>["handleMessage"]
          >
        >
      | undefined;
    let capturedUsage: CapturedModelUsage | null = null;
    let actionCallbacksSeen = 0;
    const seenActionTags = new Set<string>();
    const recordActionCallback = (
      actionTag: string,
      hasText: boolean,
    ): void => {
      actionCallbacksSeen += 1;
      const normalizedActionTag = normalizeActionName(actionTag);
      if (normalizedActionTag) {
        seenActionTags.add(normalizedActionTag);
      }
      // The reply is now coming from an action handler, not raw LLM streaming —
      // surface it as `running_action`, carrying the concrete action name (when
      // it is a real action rather than the generic VISIBLE_CALLBACK tag) so the
      // status reads e.g. "Running SEND_MESSAGE" instead of generic "Working".
      emitStatus({
        kind: "running_action",
        ...(normalizedActionTag && normalizedActionTag !== "VISIBLE_CALLBACK"
          ? { actionName: normalizedActionTag }
          : {}),
      });
      runtime.logger.info(
        {
          src: "eliza-api",
          action: normalizedActionTag || actionTag,
          hasText,
        },
        `[eliza-api] Action callback fired: ${normalizedActionTag || actionTag}`,
      );
    };
    const extractCallbackActionTag = (content: Content): string => {
      const record = content as Record<string, unknown>;
      if (typeof record.action === "string" && record.action.length > 0) {
        return record.action;
      }
      if (Array.isArray(record.actions)) {
        const firstAction = record.actions.find(
          (action): action is string =>
            typeof action === "string" && action.trim().length > 0,
        );
        if (firstAction) return firstAction;
      }
      return "VISIBLE_CALLBACK";
    };

    const generationCapture = await withModelUsageCapture(runtime, () =>
      withTimeout(
        Promise.resolve(
          runWithTrajectoryContext(trajectoryContext, async () => {
            // Plugin-registered chat pre-handlers (generic direct-dispatch
            // extension point): drained by priority before normal action
            // processing; the first non-null result resolves the turn.
            const preHandlerResult = await runtime.drainChatPreHandlers({
              runtime,
              message,
              appendText: replaceCallbackText,
              replaceText: emitSnapshot,
            });
            if (preHandlerResult) {
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
                  await createTaskAction.handler(
                    runtime,
                    message,
                    undefined,
                    {},
                    async (content: Content) => {
                      if (generationTimedOut || opts?.isAborted?.()) {
                        throw createChatGenerationTimeoutError(
                          generationTimeoutMs,
                        );
                      }

                      const chunk = extractCompatTextContent(content);
                      if (chunk) {
                        const voicedChunk =
                          await rewriteDirectActionCallbackText({
                            runtime,
                            actionName: createTaskAction.name,
                            text: chunk,
                            content,
                          });
                        applyCallbackTextUpdate(content, voicedChunk);
                        actionResponseText = responseText;
                      }
                      return [];
                    },
                  );
                  const finalText =
                    actionResponseText || responseText || "Task created.";
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

            const localInferenceIntent = detectLocalInferenceCommandIntent(
              originalUserText,
              {
                localInferenceContext: hasLocalInferenceMetadata(message),
              },
            );
            if (localInferenceIntent) {
              const { handleLocalInferenceChatCommand } =
                await getLocalInferenceChatApi();
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

            const languageAugmentedMessage =
              maybeAugmentChatMessageWithLanguage(
                message,
                opts?.preferredLanguage,
              );
            const walletAugmentedMessage =
              maybeAugmentChatMessageWithWalletContext(
                runtime,
                languageAugmentedMessage,
              );
            const generationMessage =
              await maybeAugmentChatMessageWithDocuments(
                runtime,
                walletAugmentedMessage,
              );
            result = await runtime.messageService?.handleMessage(
              runtime,
              generationMessage,
              async (content: Content) => {
                if (generationTimedOut || opts?.isAborted?.()) {
                  throw createChatGenerationTimeoutError(generationTimeoutMs);
                }

                const chunk = extractCompatTextContent(content);
                const visibleChunk = isInternalStructuredStreamText(chunk)
                  ? ""
                  : chunk;
                recordActionCallback(
                  extractCallbackActionTag(content),
                  Boolean(visibleChunk),
                );
                if (!visibleChunk) return [];
                if (!claimStreamSource("callback")) return [];
                applyCallbackTextUpdate(content, visibleChunk);
                return [];
              },
              {
                timeoutDuration: generationTimeoutMs,
                abortSignal: generationAbortController.signal,
                keepExistingResponses: true,
                onStreamChunk: opts?.onChunk
                  ? async (chunk: string) => {
                      if (generationTimedOut || opts?.isAborted?.()) {
                        throw createChatGenerationTimeoutError(
                          generationTimeoutMs,
                        );
                      }
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
                      appendIncomingText(chunk);
                    }
                  : undefined,
              },
            );

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
              const rc = result.responseContent as Record<
                string,
                unknown
              > | null;
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
              const executedRuntimeActions = listExecutedRuntimeActions(
                runtime,
                typeof message.id === "string" ? message.id : undefined,
              );
              const executedActionNames = new Set(
                [...executedRuntimeActions, ...seenActionTags]
                  .map((name) => actionNameLookup.get(name) ?? name)
                  .filter((name) => name.length > 0),
              );

              // Only run fallback execution when the core did NOT dispatch actions itself.
              const coreHandledActions = resultRecord?.mode === "actions";
              const executableFallbackActions = parsedFallbackActions.filter(
                (action) => {
                  if (!isExecutableFallbackAction(action)) {
                    return false;
                  }
                  const canonicalName =
                    actionNameLookup.get(normalizeActionName(action.name)) ??
                    normalizeActionName(action.name);
                  return !executedActionNames.has(canonicalName);
                },
              );
              if (!coreHandledActions && executableFallbackActions.length > 0) {
                const selfControlFallbackActions =
                  executableFallbackActions.filter((action) => {
                    const canonicalName =
                      actionNameLookup.get(normalizeActionName(action.name)) ??
                      normalizeActionName(action.name);
                    return canonicalName === "BLOCK";
                  });
                const callbacksBeforeFallback = actionCallbacksSeen;

                if (selfControlFallbackActions.length > 0) {
                  await executeFallbackParsedActions(
                    runtime,
                    message,
                    selfControlFallbackActions,
                    appendIncomingText,
                    recordActionCallback,
                    {
                      getCurrentText: () => responseText || modelText,
                    },
                  );
                }

                const selfControlFallbackExecuted =
                  actionCallbacksSeen > callbacksBeforeFallback;
                const remainingExecutableFallbackActions =
                  executableFallbackActions.filter((action) => {
                    const canonicalName =
                      actionNameLookup.get(normalizeActionName(action.name)) ??
                      normalizeActionName(action.name);
                    if (canonicalName === "BLOCK") {
                      return !selfControlFallbackExecuted;
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
        generationTimeoutMs,
        () => createChatGenerationTimeoutError(generationTimeoutMs),
        () => {
          generationTimedOut = true;
          abortGeneration(
            createChatGenerationTimeoutError(generationTimeoutMs),
          );
        },
      ),
    );
    capturedUsage = generationCapture.usage;

    const responseMessageText = getLatestVisibleResponseMessageText(
      result?.responseMessages,
    );
    const resultText =
      responseMessageText ||
      extractCompatTextContent(result?.responseContent) ||
      "";

    // Fallback: if callbacks weren't used for text, stream + return final text.
    if (!responseText && resultText) {
      if (opts?.onSnapshot) {
        emitSnapshot(resultText);
      } else {
        emitChunk(resultText);
      }
    } else if (
      actionCallbacksSeen === 0 &&
      resultText &&
      resultText !== responseText &&
      resultText.startsWith(responseText)
    ) {
      emitChunk(resultText.slice(responseText.length));
    } else if (
      actionCallbacksSeen === 0 &&
      resultText &&
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
      actionCallbacksSeen === 0 &&
      isWalletActionRequiredIntent(originalUserText)
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
    const exactDocumentValue = await resolveExactDocumentValueForChat(
      runtime,
      message,
    );
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

    const responseMessages = Array.isArray(result?.responseMessages)
      ? result.responseMessages.map((entry) => ({
          ...(entry.id ? { id: entry.id } : {}),
          ...(entry.content ? { content: entry.content } : {}),
        }))
      : [];
    const responseContent =
      result?.responseContent && typeof result.responseContent === "object"
        ? ({
            ...result.responseContent,
            text: finalText,
          } satisfies Content)
        : finalText
          ? ({ text: finalText } satisfies Content)
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
    const failureKind =
      rawFailureKind === "insufficient_credits" ||
      rawFailureKind === "local_inference" ||
      rawFailureKind === "no_provider" ||
      rawFailureKind === "provider_issue"
        ? rawFailureKind
        : undefined;

    const thought =
      typeof responseContent?.thought === "string" &&
      responseContent.thought.trim()
        ? responseContent.thought
        : undefined;
    const actionResultSummaries = summarizeRuntimeActionResults(
      runtime,
      typeof message.id === "string" ? message.id : undefined,
    );

    return {
      text: finalText,
      agentName,
      ...(thought ? { thought } : {}),
      ...(intentionalNoResponse
        ? { noResponseReason: "ignored" as const }
        : {}),
      ...(failureKind ? { failureKind } : {}),
      ...(accountConnect ? { accountConnect } : {}),
      ...(localInference ? { localInference } : {}),
      ...(actionCallbacksSeen > 0 ? { usedActionCallbacks: true } : {}),
      ...(actionCallbackHistory.length > 0
        ? { actionCallbackHistory: [...actionCallbackHistory] }
        : {}),
      ...(actionResultSummaries.length > 0
        ? { actionResults: actionResultSummaries }
        : {}),
      ...(responseContent ? { responseContent } : {}),
      ...(responseMessages.length > 0 ? { responseMessages } : {}),
      usage: buildChatUsage(runtime, message, finalText, capturedUsage),
    };
  } finally {
    opts?.abortSignal?.removeEventListener("abort", onExternalAbort);
    try {
      await persistMessageTrajectoryGrouping(runtime, message);
    } catch (err) {
      runtime.logger.warn(
        {
          err,
          src: "eliza-api",
          messageId: message.id,
          roomId: message.roomId,
        },
        "Failed to persist trajectory grouping metadata",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// generateConversationTitle
// ---------------------------------------------------------------------------

interface ConversationTitleGenerationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function createConversationTitleAbortSignal(
  options: ConversationTitleGenerationOptions = {},
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromCaller = () => {
    controller.abort(options.signal?.reason ?? new Error("Request aborted"));
  };
  if (options.signal?.aborted) {
    abortFromCaller();
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_CONVERSATION_TITLE_TIMEOUT_MS;
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        `Conversation title generation timed out after ${timeoutMs}ms`,
        "TimeoutError",
      ),
    );
  }, timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    err.message.toLowerCase().includes("aborted")
  );
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

  const abort = createConversationTitleAbortSignal(options);
  try {
    const title = await runtime.useModel(modelClass, {
      prompt,
      maxTokens: 20,
      temperature: 0.7,
      signal: abort.signal,
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAbortLikeError(err)) {
      logger.info(
        `[eliza] Conversation title generation cancelled: ${message}`,
      );
    } else {
      logger.warn(`[eliza] Failed to generate conversation title: ${message}`);
    }
    return null;
  } finally {
    abort.cleanup();
  }
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
): Promise<{ userId: UUID; roomId: UUID; worldId: UUID }> {
  const userId = ensureAdminEntityIdForChat(state);
  const roomId = stringToUuid(
    `${agentName}-${channelIdPrefix}-room-${roomKey}`,
  ) as UUID;
  const worldId = stringToUuid(`${agentName}-web-chat-world`) as UUID;
  const messageServerId = stringToUuid(`${agentName}-web-server`) as UUID;

  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: resolveAppUserName(state.config),
    source: MESSAGE_SOURCE_CLIENT_CHAT,
    channelId: `${channelIdPrefix}-${roomKey}`,
    type: ChannelType.DM,
    messageServerId,
    metadata: { ownership: { ownerId: userId } },
  });

  // Ensure world ownership
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
      let aborted = false;
      req.on("close", () => {
        aborted = true;
      });

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

          const result = await generateChatResponse(
            runtime,
            message,
            state.agentName,
            {
              isAborted: () => aborted,
              onChunk: (chunk) => {
                fullText += chunk;
                if (chunk) sendChunk({ content: chunk }, null);
              },
              resolveNoResponseText: () =>
                resolveNoResponseFallback(state.logBuffer, runtime),
            },
          );
          if (result.localInference && !fullText) {
            fullText = result.text;
            sendChunk({ content: result.text }, null);
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
          resolved.trim()
        ) {
          sendChunk({ content: resolved }, null);
        }

        sendChunk({}, "stop");
        writeSseData(res, "[DONE]");
      } catch (err) {
        if (!aborted) {
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
                  type: "server_error",
                },
              }),
            );
          }
          writeSseData(res, "[DONE]");
        }
      } finally {
        res.end();
      }
      return true;
    }

    // Non-streaming
    try {
      let responseText: string;
      let localInference: LocalInferenceChatMetadata | undefined;
      let failureKind: ChatFailureKind | undefined;

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
        );
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId,
          content: {
            text: prompt,
            source: "compat_openai",
            channelType: ChannelType.API,
          },
        });
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
        responseText = result.text;
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

      const resolvedText = normalizeChatResponseText(
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
      let aborted = false;
      req.on("close", () => {
        aborted = true;
      });

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
          );

          const message = createMessageMemory({
            id: crypto.randomUUID() as UUID,
            entityId: userId,
            roomId,
            content: {
              text: prompt,
              source: "compat_anthropic",
              channelType: ChannelType.API,
            },
          });

          const generation = await generateChatResponse(
            runtime,
            message,
            state.agentName,
            {
              isAborted: () => aborted,
              onChunk: onDelta,
              resolveNoResponseText: () =>
                resolveNoResponseFallback(state.logBuffer, runtime),
            },
          );
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
          resolved.trim()
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
        if (!aborted) {
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
                error: { type: "server_error", message: getErrorMessage(err) },
              },
              "error",
            );
          }
        }
      } finally {
        res.end();
      }
      return true;
    }

    // Non-streaming
    try {
      let responseText: string;
      let inputTokens = estimateTokenCount(prompt);
      let outputTokens = 0;

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
        );
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId,
          content: {
            text: prompt,
            source: "compat_anthropic",
            channelType: ChannelType.API,
          },
        });
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
        responseText = result.text;
        if (result.usage) {
          inputTokens = result.usage.promptTokens;
          outputTokens = result.usage.completionTokens;
        }
      }

      const resolvedText = normalizeChatResponseText(
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

    const platformName =
      typeof safeBody.platformName === "string" ? safeBody.platformName : null;
    const channelType =
      typeof safeBody.channelType === "string"
        ? (safeBody.channelType as ChannelType)
        : ChannelType.API;
    const source = platformName || "agent_message_api";

    try {
      const runtime = state.runtime;
      const agentName = runtime.character.name ?? "Eliza";
      // Per-user room key — matches cloud `handleMessage`'s
      // `stringToUuid(\`${agentId}:${userId}\`)` shape closely enough that
      // both surfaces produce stable, user-scoped conversation rooms.
      const { roomId, userId: connUserId } = await ensureCompatChatConnection(
        state,
        runtime,
        agentName,
        "agent-message",
        `${agentIdParam}:${userId}`.slice(0, 120),
      );

      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: connUserId,
        agentId: runtime.agentId,
        roomId,
        content: {
          text,
          source,
          channelType,
        },
      });

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

      const resolvedText = normalizeChatResponseText(
        result.text,
        state.logBuffer,
        state.runtime,
      );

      json(res, {
        response: resolvedText,
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
