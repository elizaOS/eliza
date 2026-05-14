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

import {
  type AgentRuntime,
  type Content,
  createMessageMemory,
  ModelType,
  parseJSONObjectFromText,
  type UUID,
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

export async function maybeAugmentChatMessageWithDocuments(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
): Promise<ReturnType<typeof createMessageMemory>> {
  const userPrompt = extractCompatTextContent(message.content)?.trim();
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

  const loadMatches = async (scopeRoomId: UUID, queryText: string) =>
    documents.service?.searchDocuments(
      {
        ...searchMessage,
        content: {
          ...(searchMessage.content as Content),
          text: queryText,
        },
      },
      { roomId: scopeRoomId },
    ) ?? [];

  const loadMatchesAcrossScopes = async (
    queryText: string,
  ): Promise<DocumentMatches> => {
    let matches = await loadMatches(roomId, queryText);
    if (matches.length === 0 && roomId !== agentId) {
      matches = await loadMatches(agentId, queryText);
    }
    return matches;
  };

  const selectRelevantMatches = (matches: DocumentMatches): DocumentMatches =>
    matches.filter((match) => {
      const text = match.content?.text?.trim();
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

    try {
      const result = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
      const raw = typeof result === "string" ? result : "";
      const parsed = parseJSONObjectFromText(raw) as Record<
        string,
        unknown
      > | null;
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
      runtime.logger?.warn?.(
        {
          src: "api:chat-augmentation",
          error: error instanceof Error ? error.message : String(error),
        },
        "Document query recovery model call failed",
      );
      return [];
    }
  };

  let relevantMatches: DocumentMatches = [];
  try {
    relevantMatches = selectRelevantMatches(
      await loadMatchesAcrossScopes(userPrompt),
    )
      .sort((left, right) => (right.similarity ?? 0) - (left.similarity ?? 0))
      .slice(0, CHAT_DOCUMENTS_LIMIT);

    if (relevantMatches.length === 0) {
      const recoveredQueries = await recoverDocumentSearchQueriesWithLlm();
      for (const query of recoveredQueries) {
        const recoveredMatches = selectRelevantMatches(
          await loadMatchesAcrossScopes(query),
        )
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
    runtime.logger?.warn?.(
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
      const text = (match.content?.text ?? "").trim();
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
