/**
 * Chat message enhancement helpers.
 *
 * Two augmentations: language-instruction tagging and document-context
 * retrieval. Both wrap the user message with extra prompt text before it
 * reaches the planner.
 *
 * The image / attachment / `buildUserMessages` helpers and the
 * agent-awareness prompt builder used to live here too — they were
 * either duplicates of `server-helpers.ts` (no external callers) or
 * dead end-to-end (defined, never invoked). Removed in the same pass
 * that ripped out the `conversationMode` bypass.
 */

import crypto from "node:crypto";

import type {
  AgentRuntime,
  Content,
  createMessageMemory,
  UUID,
} from "@elizaos/core";
import { normalizeCharacterLanguage } from "@elizaos/shared";
import { extractCompatTextContent } from "./compat-utils.ts";
import {
  type DocumentsServiceLike,
  getDocumentsService,
} from "./documents-service-loader.ts";
import { getErrorMessage } from "./server-helpers.ts";

type DocumentMatch = Awaited<
  ReturnType<DocumentsServiceLike["searchDocuments"]>
>[number];
type DocumentMatches = DocumentMatch[];

// ---------------------------------------------------------------------------
// Language augmentation
// ---------------------------------------------------------------------------

const CHAT_LANGUAGE_INSTRUCTION: Record<string, string> = {
  en: "Reply in natural English unless the user explicitly requests another language.",
  "zh-CN":
    "Reply in natural Simplified Chinese unless the user explicitly requests another language.",
  ko: "Reply in natural Korean unless the user explicitly requests another language.",
  es: "Reply in natural Spanish unless the user explicitly requests another language.",
  pt: "Reply in natural Brazilian Portuguese unless the user explicitly requests another language.",
  vi: "Reply in natural Vietnamese unless the user explicitly requests another language.",
  tl: "Reply in natural Tagalog unless the user explicitly requests another language.",
};

export function maybeAugmentChatMessageWithLanguage(
  message: ReturnType<typeof createMessageMemory>,
  preferredLanguage?: string,
): ReturnType<typeof createMessageMemory> {
  if (!preferredLanguage) return message;
  const instruction =
    CHAT_LANGUAGE_INSTRUCTION[normalizeCharacterLanguage(preferredLanguage)];
  if (!instruction) return message;
  const originalText = extractCompatTextContent(message.content);
  if (!originalText) return message;

  return {
    ...message,
    content: {
      ...(message.content as Content),
      text: `${originalText}\n\n[Language instruction: ${instruction}]`,
    },
  };
}

// ---------------------------------------------------------------------------
// Document context augmentation
// ---------------------------------------------------------------------------

const CHAT_DOCUMENTS_THRESHOLD = 0.2;
const CHAT_DOCUMENTS_LIMIT = 4;
const CHAT_DOCUMENTS_SNIPPET_MAX_CHARS = 700;
const CHAT_DOCUMENTS_RECOVERY_QUERY_LIMIT = 3;
const DEFAULT_CHAT_DOCUMENTS_LOOKUP_TIMEOUT_MS = 4_000;
const DEFAULT_CHAT_DOCUMENTS_RECOVERY_TIMEOUT_MS = 5_000;
const MAX_CHAT_DOCUMENTS_LOOKUP_TIMEOUT_MS = 30_000;
const MAX_CHAT_DOCUMENTS_RECOVERY_TIMEOUT_MS = 30_000;
const CHAT_DOCUMENTS_RECOVERY_MODEL = "TEXT_LARGE";

export interface ChatDocumentAugmentationOptions {
  signal?: AbortSignal;
  lookupTimeoutMs?: number;
  recoveryTimeoutMs?: number;
}

function resolveTimeoutMs(
  explicit: number | undefined,
  envName: string,
  defaultMs: number,
  maxMs: number,
): number {
  if (
    typeof explicit === "number" &&
    Number.isFinite(explicit) &&
    explicit > 0
  ) {
    return Math.max(1, Math.floor(explicit));
  }

  const env = process.env[envName]?.trim();
  if (!env) return defaultMs;

  const parsed = Number.parseInt(env, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultMs;
  }

  return Math.min(parsed, maxMs);
}

function resolveLookupTimeoutMs(explicit?: number): number {
  return resolveTimeoutMs(
    explicit,
    "ELIZA_CHAT_DOCUMENT_LOOKUP_TIMEOUT_MS",
    DEFAULT_CHAT_DOCUMENTS_LOOKUP_TIMEOUT_MS,
    MAX_CHAT_DOCUMENTS_LOOKUP_TIMEOUT_MS,
  );
}

function resolveRecoveryTimeoutMs(explicit?: number): number {
  return resolveTimeoutMs(
    explicit,
    "ELIZA_CHAT_DOCUMENT_RECOVERY_TIMEOUT_MS",
    DEFAULT_CHAT_DOCUMENTS_RECOVERY_TIMEOUT_MS,
    MAX_CHAT_DOCUMENTS_RECOVERY_TIMEOUT_MS,
  );
}

function parseJsonObjectFromModelText(
  text: string,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parseCandidate = (
    candidate: string,
  ): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const direct = parseCandidate(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return parseCandidate(trimmed.slice(start, end + 1));
}

async function withOptionalTimeout<T>(
  runtime: AgentRuntime,
  label: string,
  timeoutMs: number,
  fallback: T,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<{ value: T; timedOut: boolean }> {
  if (signal?.aborted) {
    return { value: fallback, timedOut: false };
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation().then((value) => ({ value, timedOut: false })),
      new Promise<{ value: T; timedOut: boolean }>((resolve) => {
        timeoutHandle = setTimeout(() => {
          runtime.logger.warn(
            { src: "api:chat-augmentation", timeoutMs },
            `${label} timed out; skipping optional document context`,
          );
          resolve({ value: fallback, timedOut: true });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function maybeAugmentChatMessageWithDocuments(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  options: ChatDocumentAugmentationOptions = {},
): Promise<ReturnType<typeof createMessageMemory>> {
  const userPrompt = extractCompatTextContent(message.content).trim();
  if (!userPrompt || !runtime.agentId) return message;

  // Hosts that run with a no-op embedding handler — e.g. Capacitor mobile
  // where loading the bge GGUF on top of the chat GGUF would OOM the
  // process — get only zero-vector embeddings back. The retrieval branch
  // therefore never lands a match above `CHAT_DOCUMENTS_THRESHOLD`, and
  // the LLM-driven query-recovery fallback wastes one full generate-text
  // round-trip per turn (~60–90 s on a Snapdragon 4 Gen 1 CPU) producing
  // queries that will themselves match nothing. Skip the entire path
  // when the host has explicitly opted out.
  if (process.env.ELIZA_DOCUMENT_AUGMENTATION_DISABLED?.trim() === "1") {
    return message;
  }

  const documents = await getDocumentsService(runtime);
  if (!documents.service) return message;

  const agentId = runtime.agentId as UUID;
  const roomId =
    typeof message.roomId === "string" && message.roomId.trim().length > 0
      ? (message.roomId as UUID)
      : agentId;
  const searchMessage = {
    ...message,
    id: crypto.randomUUID() as UUID,
    agentId,
    entityId:
      typeof message.entityId === "string" && message.entityId.length > 0
        ? message.entityId
        : agentId,
    roomId,
    content: {
      ...(message.content as Content),
      text: userPrompt,
    },
    createdAt: Date.now(),
  };

  const lookupTimeoutMs = resolveLookupTimeoutMs(options.lookupTimeoutMs);
  const loadMatches = async (
    scopeRoomId: UUID,
    queryText: string,
  ): Promise<{ matches: DocumentMatches; timedOut: boolean }> => {
    const result = await withOptionalTimeout<DocumentMatches>(
      runtime,
      "Document lookup",
      lookupTimeoutMs,
      [],
      options.signal,
      async () =>
        (await documents.service?.searchDocuments(
          {
            ...searchMessage,
            content: {
              ...(searchMessage.content as Content),
              text: queryText,
            },
          },
          { roomId: scopeRoomId },
        )) ?? [],
    );
    return { matches: result.value, timedOut: result.timedOut };
  };

  const loadMatchesAcrossScopes = async (
    queryText: string,
  ): Promise<{ matches: DocumentMatches; timedOut: boolean }> => {
    const initial = await loadMatches(roomId, queryText);
    if (initial.timedOut) return initial;
    let matches = initial.matches;
    if (matches.length === 0 && roomId !== agentId) {
      const fallback = await loadMatches(agentId, queryText);
      if (fallback.timedOut) return fallback;
      matches = fallback.matches;
    }
    return { matches, timedOut: false };
  };

  const selectRelevantMatches = (matches: DocumentMatches): DocumentMatches =>
    matches.filter((match) => {
      const text = match.content.text?.trim();
      return (
        typeof text === "string" &&
        text.length > 0 &&
        (match.similarity ?? 0) >= CHAT_DOCUMENTS_THRESHOLD
      );
    });

  const recoverDocumentSearchQueriesWithLlm = async (): Promise<string[]> => {
    const prompt = [
      "Extract up to 3 short semantic-search queries for retrieving documents that answer the user's request.",
      "Return only JSON with this shape:",
      '  {"queries":["query one","query two"]}',
      "",
      "Rules:",
      "- Preserve named entities, topics, codewords, and filenames when present.",
      "- Remove meta instructions about reply format, such as 'answer with only the codeword'.",
      "- If the user refers to 'the uploaded file' or a prior document without naming it, focus the queries on the fact being requested, not the phrase 'uploaded file'.",
      "- Keep each query short and retrieval-oriented.",
      "",
      "Examples:",
      '  "what is the qa codeword from the uploaded file? answer with only the codeword" -> {"queries":["qa codeword","codeword"]}',
      '  "what is the deployment codeword? reply with only the codeword" -> {"queries":["deployment codeword","codeword"]}',
      '  "which document mentions denver?" -> {"queries":["denver"]}',
      "",
      `User request: ${JSON.stringify(userPrompt)}`,
    ].join("\n");

    const timeoutMs = resolveRecoveryTimeoutMs(options.recoveryTimeoutMs);
    const controller = new AbortController();
    const abortRecovery = (reason?: unknown): void => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    };
    const onAbort = (): void => abortRecovery(options.signal?.reason);
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    try {
      const modelPromise = runtime
        .useModel(CHAT_DOCUMENTS_RECOVERY_MODEL, {
          prompt,
          maxTokens: 96,
          temperature: 0,
          responseFormat: { type: "json_object" },
          signal: controller.signal,
        })
        .catch((error) => {
          if (timedOut || controller.signal.aborted) {
            return "";
          }
          throw error;
        });

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          abortRecovery(
            new Error(`Document query recovery timed out after ${timeoutMs}ms`),
          );
          reject(
            new Error(`Document query recovery timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      });

      const result = await Promise.race([modelPromise, timeoutPromise]);
      const raw = typeof result === "string" ? result : "";
      const parsed = parseJsonObjectFromModelText(raw);
      if (!parsed) {
        return [];
      }
      const rawQueries = Array.isArray(parsed.queries)
        ? parsed.queries
        : typeof parsed.queries === "string"
          ? parsed.queries.split(/\s*\|\|\s*|,|\n/)
          : [];
      return [
        ...new Set(
          rawQueries
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .slice(0, CHAT_DOCUMENTS_RECOVERY_QUERY_LIMIT),
        ),
      ];
    } catch (error) {
      runtime.logger.warn(
        {
          src: "api:chat-augmentation",
          error: error instanceof Error ? error.message : String(error),
        },
        "Document query recovery model call failed",
      );
      return [];
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      options.signal?.removeEventListener("abort", onAbort);
    }
  };

  let relevantMatches: DocumentMatches = [];
  try {
    const initialMatches = await loadMatchesAcrossScopes(userPrompt);
    if (initialMatches.timedOut) return message;

    relevantMatches = selectRelevantMatches(initialMatches.matches)
      .sort((left, right) => (right.similarity ?? 0) - (left.similarity ?? 0))
      .slice(0, CHAT_DOCUMENTS_LIMIT);

    if (relevantMatches.length === 0) {
      const recoveredQueries = await recoverDocumentSearchQueriesWithLlm();
      for (const query of recoveredQueries) {
        const recovered = await loadMatchesAcrossScopes(query);
        if (recovered.timedOut) return message;
        const recoveredMatches = selectRelevantMatches(recovered.matches)
          .sort(
            (left, right) => (right.similarity ?? 0) - (left.similarity ?? 0),
          )
          .slice(0, CHAT_DOCUMENTS_LIMIT);
        if (recoveredMatches.length > 0) {
          relevantMatches = recoveredMatches;
          break;
        }
      }
    }
  } catch (error) {
    runtime.logger.warn(
      {
        src: "api:chat-augmentation",
        agentId,
        roomId,
        error: getErrorMessage(error, "document lookup failed"),
      },
      "Document augmentation skipped after retrieval failure",
    );
    return message;
  }

  if (relevantMatches.length === 0) return message;

  const contextualDocuments = relevantMatches
    .map((match, index) => {
      const metadata = match.metadata as Record<string, unknown> | undefined;
      const title =
        typeof metadata?.filename === "string" &&
        metadata.filename.trim().length > 0
          ? metadata.filename.trim()
          : typeof metadata?.title === "string" &&
              metadata.title.trim().length > 0
            ? metadata.title.trim()
            : `source-${index + 1}`;
      const text = (match.content.text ?? "").trim();
      const snippet =
        text.length > CHAT_DOCUMENTS_SNIPPET_MAX_CHARS
          ? `${text.slice(0, CHAT_DOCUMENTS_SNIPPET_MAX_CHARS)}...`
          : text;
      return [
        `<source title=${JSON.stringify(title)} similarity=${JSON.stringify(
          (match.similarity ?? 0).toFixed(3),
        )}>`,
        snippet,
        "</source>",
      ].join("\n");
    })
    .join("\n\n");

  return {
    ...message,
    content: {
      ...(message.content as Content),
      text: [
        "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
        "If the answer appears verbatim in the contextual documents, repeat it exactly.",
        "Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
        "",
        "<contextual_documents>",
        contextualDocuments,
        "</contextual_documents>",
        "",
        "<user_request>",
        userPrompt,
        "</user_request>",
      ].join("\n"),
    },
  };
}
