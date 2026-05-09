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
  type AgentRuntime,
  ChannelType,
  type Content,
  composePrompt,
  createMessageMemory,
  logger,
  ModelType,
  mobileDirectReplyTemplate,
  type RouteRequestContext,
  runWithTrajectoryContext,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import { asRecord, normalizeCharacterLanguage } from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.js";
import {
  type CapturedModelUsage,
  estimateTokenCount,
  withModelUsageCapture,
} from "../runtime/prompt-optimization.js";
import { resolveTrajectoryGrouping } from "../runtime/trajectory-internals.js";
import { startTrajectoryStepInDatabase } from "../runtime/trajectory-storage.js";
import { syncCharacterIntoConfig } from "../services/character-persistence.js";
import { detectRuntimeModel } from "./agent-model.js";
import {
  executeFallbackParsedActions,
  maybeHandleDirectBinanceSkillRequest,
  parseFallbackActionBlocks,
} from "./binance-skill-helpers.js";
import {
  isClientVisibleNoResponse,
  isNoResponsePlaceholder,
} from "./chat-text-helpers.js";
import { resolveClientChatAdminEntityId } from "./client-chat-admin.js";
import {
  extractAnthropicSystemAndLastUser,
  extractCompatTextContent,
  extractOpenAiSystemAndLastUser,
  resolveCompatRoomKey,
} from "./compat-utils.js";
import {
  isInsufficientCreditsError,
  isInsufficientCreditsMessage,
} from "./credit-detection.js";
import {
  getLocalInferenceChatStatus,
  handleLocalInferenceChatCommand,
  type LocalInferenceChatMetadata,
  type LocalInferenceCommandIntent,
} from "./local-inference-routes.js";
import {
  buildWalletActionNotExecutedReply,
  cloneWithoutBlockedObjectKeys,
  decodePathComponent,
  getErrorMessage,
  hasBlockedObjectKeyDeep,
  isWalletActionRequiredIntent,
  maybeAugmentChatMessageWithDocuments,
  maybeAugmentChatMessageWithLanguage,
  maybeAugmentChatMessageWithWalletContext,
  normalizeIncomingChatPrompt,
  resolveAppUserName,
  trimWalletProgressPrefix,
  validateChatImages,
} from "./server-helpers.js";
import { resolveStreamingUpdate } from "@elizaos/plugin-streaming";

const CHAT_MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB (image-capable)

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ChatGenerationResult {
  text: string;
  agentName: string;
  noResponseReason?: "ignored";
  failureKind?: ChatFailureKind;
  localInference?: LocalInferenceChatMetadata;
  usedActionCallbacks?: boolean;
  actionCallbackHistory?: string[];
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

export interface ChatGenerateOptions {
  onChunk?: (chunk: string) => void;
  onSnapshot?: (text: string) => void;
  isAborted?: () => boolean;
  resolveNoResponseText?: () => string;
  preferredLanguage?: string;
  timeoutDuration?: number;
}

export interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
  tags: string[];
}

type CallbackMergeMode = "append" | "replace";

function resolveCallbackMergeMode(
  content: Content,
  fallback: CallbackMergeMode = "replace",
): CallbackMergeMode {
  return content.merge === "append" || content.merge === "replace"
    ? content.merge
    : fallback;
}

export interface ChatImageAttachment {
  /** Base64-encoded image data (no data URL prefix). */
  data: string;
  mimeType: string;
  name: string;
}

function normalizeActionCallbackText(text: string): string {
  return text.trim();
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

function isMobileLocalSimpleChat(
  message: ReturnType<typeof createMessageMemory>,
): boolean {
  const conversationMode = (message.content as { conversationMode?: unknown })
    .conversationMode;
  return (
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED === "1" &&
    conversationMode === "simple"
  );
}

function sanitizeMobileLocalSimpleReply(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const withoutRole = trimmed
    .replace(/^assistant\s*:\s*/i, "")
    .replace(/^eliza\s*:\s*/i, "")
    .trim();
  const firstLine = withoutRole.split(/\r?\n/).find((line) => line.trim());
  return (firstLine ?? withoutRole).trim();
}

function extractExactWordsReplyRequest(userText: string): string | null {
  const exactWords = /\bexact words?\s*:\s*["'“”‘’]?(.+?)["'“”‘’]?\s*$/i.exec(
    userText,
  );
  if (exactWords?.[1]?.trim()) {
    return exactWords[1].trim();
  }
  const replyWith =
    /\breply\s+(?:briefly\s+)?with\s+["'“”‘’]([^"'“”‘’]+)["'“”‘’]/i.exec(
      userText,
    );
  if (replyWith?.[1]?.trim()) {
    return replyWith[1].trim();
  }
  return null;
}

async function generateMobileLocalSimpleReply(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  agentName: string,
  opts?: ChatGenerateOptions,
): Promise<ChatGenerationResult | null> {
  const userText = String(
    extractCompatTextContent(message.content) ?? "",
  ).trim();
  if (!userText) return null;
  const exactReply = extractExactWordsReplyRequest(userText);
  if (exactReply) {
    opts?.onSnapshot?.(exactReply);
    return {
      text: exactReply,
      agentName,
      responseContent: {
        text: exactReply,
        simple: true,
        actions: ["REPLY"],
      },
      responseMessages: [],
    };
  }
  const system =
    typeof runtime.character.system === "string" &&
    runtime.character.system.trim().length > 0
      ? runtime.character.system.trim()
      : `You are ${agentName}. Reply briefly and directly.`;
  const prompt = composePrompt({
    state: { system, userText, agentName },
    template: mobileDirectReplyTemplate,
  });
  const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    maxTokens: 64,
    temperature: 0.4,
  });
  const text = sanitizeMobileLocalSimpleReply(String(raw ?? ""));
  if (!text) return null;
  opts?.onSnapshot?.(text);
  return {
    text,
    agentName,
    responseContent: {
      text,
      simple: true,
      actions: ["REPLY"],
    },
    responseMessages: [],
  };
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

  const documentsService = runtime.getService?.("documents") as
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
        match?.metadata && typeof match.metadata === "object"
          ? match.metadata
          : null;
      return metadata?.source === "upload";
    });
    const preferredMatches =
      uploadedMatches.length > 0 ? uploadedMatches : matches;
    const exactMatchCandidates = uniqueMatches(
      preferredMatches
        .map((match) =>
          typeof match?.content?.text === "string"
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
        typeof match?.content?.text === "string"
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
// IGNORE / empty-action / placeholder-text path as a provider failure.
const PROVIDER_ISSUE_CHAT_REPLY = "Sorry, I'm having a provider issue";
const INSUFFICIENT_CREDITS_CHAT_REPLY =
  "Eliza Cloud credits are depleted. Top up the cloud balance and try again.";
// Used by paths #1-#3: planner picked IGNORE/NONE/empty REPLY, action ran but
// emitted no text callback, or normalized text became a placeholder. None of
// these are provider failures, so the message must not blame the provider.
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
  "or pick Eliza Cloud from the runtime picker.";
const DEFAULT_CHAT_GENERATION_TIMEOUT_MS = 180_000;
const NON_EXECUTABLE_FALLBACK_ACTIONS = new Set(["REPLY", "NONE", "IGNORE"]);

function isExecutableFallbackAction(action: { name: string }): boolean {
  return !NON_EXECUTABLE_FALLBACK_ACTIONS.has(action.name);
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
    const canonicalName = normalizeActionName(action?.name);
    if (!canonicalName) {
      continue;
    }
    lookup.set(canonicalName, canonicalName);
    if (!Array.isArray(action?.similes)) {
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

function listExecutedRuntimeActions(
  runtime: AgentRuntime,
  messageId: UUID | undefined,
): Set<string> {
  if (!messageId) {
    return new Set();
  }

  const getActionResults = (
    runtime as {
      getActionResults?: (id: UUID) => unknown[];
    }
  ).getActionResults;
  if (typeof getActionResults !== "function") {
    return new Set();
  }

  try {
    return new Set(
      getActionResults(messageId)
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
  } catch {
    return new Set();
  }
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

  const fromEnv = process.env.ELIZA_CHAT_GENERATION_TIMEOUT_MS?.trim();
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
  return getProviderIssueChatReply();
}

/**
 * Discriminator the conversation route includes in its 200 response so the
 * renderer can distinguish "provider configured but throwing" from "no
 * provider configured at all" — the latter is a UX gate ("Connect a
 * provider"), not a chat reply.
 */
export type ChatFailureKind =
  | "insufficient_credits"
  | "no_provider"
  | "provider_issue"
  | "local_inference";

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
  const contentMetadata = asRecord(message.content.metadata) ?? {};
  const messageMetadata = asRecord(message.metadata) ?? {};
  const metadata = { ...contentMetadata, ...messageMetadata };
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
    /\b(?:status|progress|state|ready|loaded|loading|how far|what model)\b/.test(
      normalized,
    ) &&
    (options.localInferenceContext === true ||
      /\b(?:download|model|local|inference|gguf|llama|provider|runtime)\b/.test(
        normalized,
      ))
  ) {
    return "status";
  }

  if (
    /\b(?:download|install|get|fetch|pull)\b/.test(normalized) &&
    (options.localInferenceContext === true ||
      /\b(?:model|local|inference|gguf|llama|smollm)\b/.test(normalized))
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
  const trimmed = text.trim();
  if (
    (trimmed === PROVIDER_ISSUE_CHAT_REPLY ||
      trimmed === NO_RESPONSE_FALLBACK_REPLY) &&
    findRecentInsufficientCreditsLog(logBuffer)
  ) {
    return pickInsufficientCreditsChatReply();
  }
  if (!isClientVisibleNoResponse(text)) return text;
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

export function writeSseData(
  res: http.ServerResponse,
  data: string,
  event?: string,
): void {
  if (res.writableEnded || res.destroyed) return;
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${data}\n\n`);
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
        Boolean(contentText) &&
        createdAt >= sinceMs - 2000
      );
    });
  } catch {
    return false;
  }
}

export async function persistAssistantConversationMemory(
  runtime: AgentRuntime,
  roomId: UUID,
  content: string | Content,
  channelType: ChannelType,
  dedupeSinceMs?: number,
): Promise<void> {
  const persistedContent =
    typeof content === "string"
      ? ({
          text: content,
          source: "client_chat",
          channelType,
        } satisfies Content)
      : ({
          ...content,
          text: extractCompatTextContent(content) ?? "",
          source:
            typeof content.source === "string" ? content.source : "client_chat",
          channelType:
            typeof content.channelType === "string"
              ? content.channelType
              : channelType,
        } satisfies Content);
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
const VALID_CONVERSATION_MODES = new Set(["simple", "power"]);

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

function parseConversationMode(
  value: unknown,
): "simple" | "power" | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!VALID_CONVERSATION_MODES.has(normalized)) {
    return null;
  }
  return normalized as "simple" | "power";
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
  conversationMode?: "simple" | "power";
  preferredLanguage?: string;
  source?: string;
  metadata?: Record<string, unknown>;
} | null> {
  const body = await helpers.readJsonBody<{
    text?: string;
    channelType?: string;
    images?: ChatImageAttachment[];
    conversationMode?: string;
    language?: string;
    source?: string;
    metadata?: Record<string, unknown>;
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
  const conversationMode = parseConversationMode(body.conversationMode);
  if (conversationMode === null) {
    helpers.error(res, "conversationMode is invalid", 400);
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
  return {
    prompt: normalizedPrompt,
    channelType,
    images,
    ...(conversationMode ? { conversationMode } : {}),
    ...(preferredLanguage ? { preferredLanguage } : {}),
    ...(source ? { source } : {}),
    ...(metadata ? { metadata } : {}),
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

  const promptText = extractCompatTextContent(message.content) ?? "";
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
  try {
    const originalUserText = String(
      extractCompatTextContent(message.content) ?? "",
    );
    type StreamSource = "unset" | "callback" | "onStreamChunk";
    let responseText = "";
    let forcedWalletExecutionText = false;
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
    const emitChunk = (chunk: string): void => {
      if (!chunk) return;
      responseText += chunk;
      opts?.onChunk?.(chunk);
    };
    const emitSnapshot = (text: string): void => {
      if (!text) return;
      responseText = text;
      opts?.onSnapshot?.(text);
    };
    const claimStreamSource = (
      source: Exclude<StreamSource, "unset">,
    ): boolean => {
      if (activeStreamSource === "unset") {
        activeStreamSource = source;
        return true;
      }
      return activeStreamSource === source;
    };
    const appendIncomingText = (incoming: string): void => {
      const update = resolveStreamingUpdate(responseText, incoming);
      if (update.kind === "noop") return;
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
        await runtime.emitEvent("MESSAGE_RECEIVED", {
          message,
          source: messageSource,
        });
      }
    } catch (err) {
      runtime.logger?.warn(
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
      runtime.logger?.info(
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
            // Binance skill direct dispatch
            const directSkillText = await maybeHandleDirectBinanceSkillRequest(
              runtime,
              message,
              replaceCallbackText,
              emitSnapshot,
            );
            if (directSkillText) {
              const finalText = isClientVisibleNoResponse(directSkillText)
                ? directSkillText || "(no response)"
                : directSkillText;
              result = {
                didRespond: true,
                responseContent: { text: finalText },
                responseMessages: [],
              } as typeof result;
              responseText = finalText;
              forcedWalletExecutionText =
                isClientVisibleNoResponse(directSkillText);
              return;
            }

            // Direct dispatch for explicit task creation intent from UI
            const contentMetadata = message.content.metadata as
              | Record<string, unknown>
              | undefined;
            if (contentMetadata?.intent === "create_task") {
              const coordinator = runtime.getService("SWARM_COORDINATOR");
              if (coordinator) {
                const createTaskAction =
                  runtime.actions.find(
                    (a) => a?.name?.toUpperCase() === "START_CODING_TASK",
                  ) ??
                  runtime.actions.find(
                    (a) => a?.name?.toUpperCase() === "CREATE_TASK",
                  );
                if (createTaskAction) {
                  runtime.logger?.info(
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
                        applyCallbackTextUpdate(content, chunk);
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
              const localResult = await handleLocalInferenceChatCommand(
                localInferenceIntent,
                originalUserText,
              );
              emitSnapshot(localResult.text);
              result = {
                didRespond: true,
                responseContent: {
                  text: localResult.text,
                  source: "client_chat",
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

            if (isMobileLocalSimpleChat(message)) {
              const simpleResult = await generateMobileLocalSimpleReply(
                runtime,
                message,
                agentName,
                opts,
              );
              if (simpleResult) {
                result = {
                  didRespond: true,
                  responseContent: simpleResult.responseContent,
                  responseMessages: simpleResult.responseMessages ?? [],
                } as typeof result;
                responseText = simpleResult.text;
                return;
              }
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
                recordActionCallback(
                  extractCallbackActionTag(content),
                  Boolean(chunk),
                );
                if (!chunk) return [];
                if (!claimStreamSource("callback")) return [];
                applyCallbackTextUpdate(content, chunk);
                return [];
              },
              {
                timeoutDuration: generationTimeoutMs,
                keepExistingResponses: true,
                onStreamChunk: opts?.onChunk
                  ? async (chunk: string) => {
                      if (generationTimedOut || opts?.isAborted?.()) {
                        throw createChatGenerationTimeoutError(
                          generationTimeoutMs,
                        );
                      }
                      if (!chunk) return;
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
              const messagesToEmit =
                responseMessages.length > 0
                  ? responseMessages
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
                    content: ensureMessageMemoryContent(
                      responseMessage.content ?? { text: "" },
                    ),
                  });
                  memoryLike.metadata = message.metadata;
                  await runtime.emitEvent("MESSAGE_SENT", {
                    message: memoryLike,
                    source: messageSource,
                  });
                }
              }
            } catch (err) {
              runtime.logger?.warn(
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
              runtime.logger?.info(
                {
                  src: "eliza-api",
                  mode: resultRecord?.mode,
                  actions: rc?.actions,
                  simple: rc?.simple,
                  hasText: Boolean(rc?.text),
                },
                "[eliza-api] Chat response metadata",
              );

              const rawActionsPayload = rc?.actions ?? resultRecord?.actions;
              const modelText = String(
                extractCompatTextContent(result.responseContent) ?? "",
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
                  return !executedRuntimeActions.has(canonicalName);
                },
              );
              if (
                actionCallbacksSeen === 0 &&
                !coreHandledActions &&
                executableFallbackActions.length > 0
              ) {
                const selfControlFallbackActions =
                  executableFallbackActions.filter((action) => {
                    const canonicalName =
                      actionNameLookup.get(normalizeActionName(action.name)) ??
                      normalizeActionName(action.name);
                    return canonicalName === "WEBSITE_BLOCK";
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
                    if (canonicalName === "WEBSITE_BLOCK") {
                      return !selfControlFallbackExecuted;
                    }
                    return true;
                  });

                if (remainingExecutableFallbackActions.length > 0) {
                  runtime.logger?.error(
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
      !forcedWalletExecutionText
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
          ...(entry?.id ? { id: entry.id } : {}),
          ...(entry?.content ? { content: entry.content } : {}),
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
        })
      | null;
    const localInference =
      responseRecord?.localInference &&
      typeof responseRecord.localInference === "object"
        ? responseRecord.localInference
        : undefined;
    const failureKind =
      responseRecord?.failureKind === "local_inference"
        ? "local_inference"
        : undefined;

    return {
      text: finalText,
      agentName,
      ...(intentionalNoResponse
        ? { noResponseReason: "ignored" as const }
        : {}),
      ...(failureKind ? { failureKind } : {}),
      ...(localInference ? { localInference } : {}),
      ...(actionCallbacksSeen > 0 ? { usedActionCallbacks: true } : {}),
      ...(actionCallbackHistory.length > 0
        ? { actionCallbackHistory: [...actionCallbackHistory] }
        : {}),
      ...(responseContent ? { responseContent } : {}),
      ...(responseMessages.length > 0 ? { responseMessages } : {}),
      usage: buildChatUsage(runtime, message, finalText, capturedUsage),
    };
  } finally {
    try {
      await persistMessageTrajectoryGrouping(runtime, message);
    } catch (err) {
      runtime.logger?.warn(
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

export async function generateConversationTitle(
  runtime: AgentRuntime,
  userMessage: string,
  agentName: string,
): Promise<string | null> {
  const modelClass = ModelType.TEXT_SMALL;

  const prompt = `Based on the user's first message in a new chat, generate a very short, concise title (max 4-5 words) for the conversation.
The agent's name is "${agentName}". The title should reflect the topic or intent of the user.
Ideally, the title should fit the persona/vibe of the agent if possible, but clarity is more important.
Do not use quotes. Do not include "Title:" prefix.

User message: "${userMessage}"

Title:`;

  try {
    const title = await runtime.useModel(modelClass, {
      prompt,
      maxTokens: 20,
      temperature: 0.7,
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
    logger.warn(
      `[eliza] Failed to generate conversation title: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
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
    source: "client_chat",
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
    const metadataWithRoles = world.metadata as {
      roles?: Record<string, string>;
    };
    const roles = metadataWithRoles.roles ?? {};
    if (roles[userId] !== "OWNER") {
      roles[userId] = "OWNER";
      metadataWithRoles.roles = roles;
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
    if (state.agentName?.trim()) ids.add(state.agentName.trim());
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
    const model = requestedModel ?? state.agentName ?? "eliza";

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
    const model = requestedModel ?? state.agentName ?? "eliza";

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
              usage: { input_tokens: 0, output_tokens: 0 },
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

          await generateChatResponse(runtime, message, state.agentName, {
            isAborted: () => aborted,
            onChunk: onDelta,
            resolveNoResponseText: () =>
              resolveNoResponseFallback(state.logBuffer, runtime),
          });
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
            usage: { output_tokens: 0 },
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
        usage: { input_tokens: 0, output_tokens: 0 },
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

  return false;
}
