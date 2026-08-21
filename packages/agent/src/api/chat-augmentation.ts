/**
 * Adds language guidance and relevant document excerpts to API chat messages
 * before the planner sees them. The serial request path performs only cheap
 * lexical matching; semantic recall remains in the DOCUMENTS provider, where
 * provider composition can run it concurrently. Requester-aware document
 * access controls apply to both paths.
 */

import crypto from "node:crypto";

import type {
  AccessContext,
  AgentRuntime,
  Content,
  createMessageMemory,
  Memory,
  UUID,
} from "@elizaos/core";
import {
  aliasRecallQuery,
  buildAccessContext,
  embedRecallQuery,
  toWellFormedUnicode,
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
  ja: "Reply in natural Japanese unless the user explicitly requests another language.",
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

// Keyword search max-normalizes BM25 within each result set, so the BEST
// positive match is always similarity 1.0 even when the lexical overlap is a
// single ubiquitous word — the similarity threshold above is a relative
// ranking cut, not an absolute relevance gate. Injecting on that signal let an
// unrelated navigation FAQ reach 1.0 on a workout query and its "Do not ...
// invoke tools/actions" envelope suppress the correct mutation path (#17028).
// This boundary therefore adds an ABSOLUTE gate: at least half of the query's
// meaningful (non-stopword) terms must literally appear in a fragment before
// it may be injected. Deliberately local to chat augmentation — the shared
// normalizer also feeds hybrid search's blend and must stay relative.
const CHAT_DOCUMENTS_MIN_QUERY_TERM_COVERAGE = 0.5;

const CHAT_DOCUMENT_QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "get",
  "has",
  "have",
  "he",
  "her",
  "his",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "please",
  "she",
  "should",
  "so",
  "some",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "whats",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/** Lowercase Unicode word tokens with conservative English plural folding. */
function coverageTokens(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(
    (token) => {
      // Preserve stopwords before folding: otherwise "this" became "thi" and
      // "does" became "doe", manufacturing lexical anchors for stopword-only
      // queries. Restrict the fold to Latin-looking plurals so non-English
      // scripts remain exact instead of passing through English morphology.
      if (CHAT_DOCUMENT_QUERY_STOPWORDS.has(token)) return token;
      return /^[a-z]+$/u.test(token) &&
        token.length > 3 &&
        token.endsWith("s") &&
        !token.endsWith("ss")
        ? token.slice(0, -1)
        : token;
    },
  );
}

function meaningfulQueryTerms(query: string): string[] {
  return [
    ...new Set(
      coverageTokens(query).filter(
        (token) =>
          token.length >= 2 && !CHAT_DOCUMENT_QUERY_STOPWORDS.has(token),
      ),
    ),
  ];
}

function queryTermCoverage(
  terms: readonly string[],
  fragmentText: string,
): number {
  if (terms.length === 0) return 0;
  const fragmentTokens = new Set(coverageTokens(fragmentText));
  const covered = terms.filter((term) => fragmentTokens.has(term)).length;
  return covered / terms.length;
}

// Sentinel requester id for an unresolved/unauthenticated chat turn. It is the
// nil UUID — guaranteed to be neither the agent nor any real owner — so the
// scope-read filter resolves it to a least-privileged USER and strips every
// non-global fragment rather than failing open.
const UNRESOLVED_REQUESTER_ENTITY_ID =
  "00000000-0000-0000-0000-000000000000" as UUID;

export interface ChatDocumentAugmentationOptions {
  signal?: AbortSignal;
}

export async function maybeAugmentChatMessageWithDocuments(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  options: ChatDocumentAugmentationOptions = {},
): Promise<ReturnType<typeof createMessageMemory>> {
  const userPrompt = extractCompatTextContent(message.content).trim();
  if (!userPrompt || !runtime.agentId) return message;

  // A slash/`!` command is an instruction to the command layer, never a
  // document question. Rewriting it into the contextual-documents envelope
  // breaks the deterministic command path: the pre-LLM shortcut gate matches
  // the ORIGINAL text, but the command action's validate() re-reads
  // message.content.text — which by then holds the envelope, so validate
  // silently fails and the turn falls through to LLM improvisation whenever
  // the command happens to be embedding-similar to a stored document (e.g.
  // "/help", "/model" on an agent with model-related docs).
  if (userPrompt.startsWith("/") || userPrompt.startsWith("!")) {
    return message;
  }

  // Mobile hosts can explicitly opt out when loading an embedding model beside
  // the chat model would exceed their memory budget.
  if (process.env.ELIZA_DOCUMENT_AUGMENTATION_DISABLED?.trim() === "1") {
    return message;
  }

  const documents = await getDocumentsService(runtime);
  if (!documents.service) return message;

  // Skip the document search entirely when the agent has no searchable corpus.
  // Most cloud agents have no fragments, so even the lexical query and
  // cross-scope retry are guaranteed work with no possible context result.
  // A count failure must preserve retrieval rather than misclassify a broken
  // store as an empty corpus.
  try {
    const fragmentCount = await documents.service.countMemories({
      tableName: "document_fragments",
    });
    if (fragmentCount === 0) return message;
  } catch (error) {
    // error-policy:J4 a failed optimization probe degrades to the complete
    // retrieval path, which remains distinguishable in diagnostics.
    runtime.logger.warn(
      {
        src: "api:chat-augmentation",
        error: getErrorMessage(error, "document fragment count failed"),
      },
      "Document fragment count failed; continuing with retrieval",
    );
  }

  const agentId = runtime.agentId as UUID;

  // Build the requester's AccessContext from the ORIGINAL message — who is
  // asking and with what role (resolved against the message's world) — BEFORE
  // the searchMessage below coerces an empty entityId to the agentId. The
  // worldId is carried only to resolve that role; the scope-read filter gates
  // on metadata.scope, NOT worldId, so cross-tenant isolation still comes from
  // filterScope / Postgres RLS, not from this gate. We ALWAYS thread a context into
  // searchDocuments so filterByAccessContext is the enforcement layer on this
  // path, not a redundant second copy of the service's per-document gate: the
  // service short-circuits its own gate to allow-all whenever the search runs
  // as the agent (which the empty-entityId coercion below forces), and the
  // scope-read filter is what keeps owner/agent/user-private fragments out of
  // that allow-all result. A failure to resolve a world leaves role/worldId
  // undefined, which the filter treats as least-privileged USER, not
  // unrestricted.
  let accessContext: AccessContext | undefined;
  const trimmedEntityId =
    typeof message.entityId === "string" ? message.entityId.trim() : "";
  if (trimmedEntityId.length > 0 && trimmedEntityId !== agentId) {
    // A real, non-agent requester: resolve their role within the message's
    // world so the filter can let an OWNER through and hold a USER back.
    const requesterEntityId = trimmedEntityId as UUID;
    try {
      accessContext = await buildAccessContext(runtime, message as Memory);
    } catch (error) {
      // Fail closed: when the requester can't be resolved we still pass a
      // minimal context pinned to their entity so the read runs as the
      // least-privileged USER rather than dropping the gate entirely.
      runtime.logger.warn(
        {
          src: "api:chat-augmentation",
          error: error instanceof Error ? error.message : String(error),
        },
        "Access-context resolution failed; falling back to requester-only scope",
      );
      accessContext = { requesterEntityId };
    }
  } else if (trimmedEntityId.length === 0) {
    // No requester at all (missing/blank entityId). The searchMessage below
    // coerces this to a self-read, which disables the service's per-document
    // gate (it allow-alls every agent self-read). Pin the context to the nil
    // UUID — never the agent — so actorFromAccessContext resolves to USER and
    // the scope-read filter still strips every non-global fragment. The gate
    // fails CLOSED here instead of surfacing private fragments to an
    // unauthenticated turn. A genuine agent self-read (entityId === agentId)
    // is left with no context, preserving the prior unfiltered self-read.
    accessContext = { requesterEntityId: UNRESOLVED_REQUESTER_ENTITY_ID };
  }

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

  // This augmentation embeds the recall query BEFORE the run starts (no runId
  // yet), so the per-turn embed cache keys off the turn's message id instead.
  // The in-run TTFT prefetch presents the same id and adopts this vector rather
  // than issuing a second identical embed round-trip (#15253). The turn key
  // travels via this option, NOT the search message (whose id is deliberately a
  // fresh UUID for the scope-read coercion above).
  const turnMessageId =
    typeof message.id === "string" ? (message.id as UUID) : undefined;
  const loadMatches = async (
    scopeRoomId: UUID,
    queryText: string,
  ): Promise<DocumentMatches> => {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const searchOptions = {
      turnMessageId,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    return (
      (await documents.service?.searchDocuments(
        {
          ...searchMessage,
          content: {
            ...(searchMessage.content as Content),
            text: queryText,
          },
        },
        { roomId: scopeRoomId },
        "keyword",
        accessContext,
        searchOptions,
      )) ?? []
    );
  };

  const loadMatchesAcrossScopes = async (
    queryText: string,
  ): Promise<DocumentMatches> => {
    let matches = await loadMatches(roomId, queryText);
    if (matches.length === 0 && roomId !== agentId) {
      matches = await loadMatches(agentId, queryText);
    }
    return matches;
  };

  // A query whose every token is a stopword has no lexical anchor at all —
  // any keyword "match" for it is noise, so nothing may be injected.
  const queryTerms = meaningfulQueryTerms(userPrompt);
  const selectRelevantMatches = (matches: DocumentMatches): DocumentMatches =>
    matches.filter((match) => {
      const text = match.content.text?.trim();
      return (
        typeof text === "string" &&
        text.length > 0 &&
        (match.similarity ?? 0) >= CHAT_DOCUMENTS_THRESHOLD &&
        queryTermCoverage(queryTerms, text) >=
          CHAT_DOCUMENTS_MIN_QUERY_TERM_COVERAGE
      );
    });

  let relevantMatches: DocumentMatches = [];
  try {
    // Pre-model augmentation is lexical-only by design. Semantic document
    // recall belongs to the DOCUMENTS provider, where it composes in parallel
    // with the rest of the selected context instead of serially delaying chat.
    const keywordMatches = await loadMatchesAcrossScopes(userPrompt);
    relevantMatches = selectRelevantMatches(keywordMatches)
      .sort((left, right) => (right.similarity ?? 0) - (left.similarity ?? 0))
      .slice(0, CHAT_DOCUMENTS_LIMIT);
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
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
      const text = toWellFormedUnicode((match.content.text ?? "").trim());
      return [
        `<source title=${JSON.stringify(title)} similarity=${JSON.stringify(
          (match.similarity ?? 0).toFixed(3),
        )}>`,
        text,
        "</source>",
      ].join("\n");
    })
    .join("\n\n");

  const augmentedText = [
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
  ].join("\n");

  // The rewrite changes the text every in-run recall caller (TTFT prefetch,
  // relevant-conversations, FACTS) presents to the shared per-turn embed cache,
  // which would miss and issue a second serial embed round-trip (~1.5-2.7s of
  // gateway floor) for a query polluted by the injected snippets. Warm the
  // clean-prompt embed as a detached warm that overlaps the turn instead of
  // blocking it, and alias the envelope text onto it so the whole turn shares
  // one embed of what the user actually asked. `embedRecallQuery` registers its
  // in-flight promise synchronously, so the alias below always finds it.
  if (turnMessageId) {
    void embedRecallQuery(runtime, userPrompt, {
      messageId: turnMessageId,
      signal: options.signal,
    }).catch((error) => {
      if (options.signal?.aborted) {
        // error-policy:J5 the owning chat request observes cancellation; this
        // detached speculative warm must not surface a second rejection.
        return;
      }
      // error-policy:J7 the compose-time recall consumer observes and reports
      // its own failure; this detached warm must not reject unobserved.
      runtime.reportError("ChatAugmentation.recallEmbedWarm", error, {
        messageId: turnMessageId,
        roomId,
      });
    });
    aliasRecallQuery(runtime, {
      messageId: turnMessageId,
      sourceText: userPrompt,
      aliasText: augmentedText,
    });
  }

  return {
    ...message,
    content: {
      ...(message.content as Content),
      text: augmentedText,
    },
  };
}
