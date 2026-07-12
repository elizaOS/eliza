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
  parseJSONObjectFromText,
} from "@elizaos/core";
import { normalizeCharacterLanguage } from "@elizaos/shared";
import { extractCompatTextContent } from "./compat-utils.ts";
import {
  type DocumentSearchMode,
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
const CHAT_DOCUMENTS_SNIPPET_MAX_CHARS = 700;
const CHAT_DOCUMENTS_RECOVERY_QUERY_LIMIT = 3;
const DEFAULT_CHAT_DOCUMENTS_LOOKUP_TIMEOUT_MS = 4_000;
const DEFAULT_CHAT_DOCUMENTS_RECOVERY_TIMEOUT_MS = 5_000;
const MAX_CHAT_DOCUMENTS_LOOKUP_TIMEOUT_MS = 30_000;
const MAX_CHAT_DOCUMENTS_RECOVERY_TIMEOUT_MS = 30_000;
const CHAT_DOCUMENTS_RECOVERY_MODEL = "TEXT_LARGE";

// Upper bound on the documents-table probe that classifies the corpus as
// seed-only. The bundled seed set (default-documents.ts + the per-topic help
// FAQ) is ~14 documents; a corpus at or above this cap cannot be seed-only, so
// the probe treats hitting the cap as "user documents exist" without paging.
const CHAT_DOCUMENTS_SEED_PROBE_LIMIT = 32;
const SEED_DOCUMENT_ADDED_FROM = "default-seed";

// Sentinel requester id for an unresolved/unauthenticated chat turn. It is the
// nil UUID — guaranteed to be neither the agent nor any real owner — so the
// scope-read filter resolves it to a least-privileged USER and strips every
// non-global fragment rather than failing open.
const UNRESOLVED_REQUESTER_ENTITY_ID =
  "00000000-0000-0000-0000-000000000000" as UUID;

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

/**
 * True when every document in the corpus is a bundled seed document
 * (`metadata.addedFrom === "default-seed"` — the Eliza overview / Cloud basics
 * / help-FAQ set from default-documents.ts). Character knowledge
 * (`addedFrom: "character"`) and anything a user or the agent added count as a
 * real corpus. Fails open to `false` (the full retrieval path) on a probe
 * error or when the corpus is too large to be the seed set.
 */
async function corpusHasOnlySeedDocuments(
  documents: DocumentsServiceLike,
): Promise<boolean> {
  const docs = await documents.getMemories({
    tableName: "documents",
    count: CHAT_DOCUMENTS_SEED_PROBE_LIMIT,
  });
  if (docs.length === 0 || docs.length >= CHAT_DOCUMENTS_SEED_PROBE_LIMIT) {
    return false;
  }
  return docs.every(
    (doc) =>
      (doc.metadata as Record<string, unknown> | undefined)?.addedFrom ===
      SEED_DOCUMENT_ADDED_FROM,
  );
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

  // Hosts that run with an empty-vector embedding handler — e.g. Capacitor mobile
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

  // Skip the document search entirely when the agent has no searchable corpus.
  // `searchDocuments` embeds the user query, then searches `document_fragments`;
  // most cloud agents run with an empty corpus, so that embed round-trip costs
  // ~1.5s/turn (the dominant chat-latency tax) for guaranteed-zero matches — and
  // the LLM query-recovery fallback is already gated on having documents. A cheap
  // fragment count avoids the wasted embed. On a count error we fall through to
  // the normal path rather than skip augmentation.
  try {
    const fragmentCount = await documents.service.countMemories({
      tableName: "document_fragments",
    });
    if (fragmentCount === 0) return message;
  } catch {
    // Count failed — do not skip; let the normal search path run.
  }

  // Classify the corpus: bundled seed docs only, or a real (user/agent-added)
  // corpus. Agents whose only corpus is the default seed set — every default
  // cloud agent — otherwise pay the hybrid search's blocking embed round-trip
  // (~1.5-2.7s of gateway floor, the dominant pre-reply latency) on EVERY turn,
  // and because hybrid similarity is max-normalized over the candidate set the
  // top seed fragment almost always clears the relevance threshold, injecting
  // help-FAQ snippets into unrelated turns. Seed-only corpora therefore search
  // in keyword (BM25) mode: no embed round-trip, and the FAQ still surfaces on
  // real term overlap (BM25 scores zero-overlap queries 0 → no injection). A
  // probe failure falls open to the full hybrid path.
  let seedOnlyCorpus = false;
  try {
    seedOnlyCorpus = await corpusHasOnlySeedDocuments(documents.service);
  } catch (error) {
    // error-policy:J4 a failed probe degrades to the FULL hybrid retrieval
    // path (the pre-optimization behavior), never to a skipped or downgraded
    // lookup — retrieval richness is preserved, only the latency win is lost.
    runtime.logger.warn(
      {
        src: "api:chat-augmentation",
        error: error instanceof Error ? error.message : String(error),
      },
      "Seed-corpus probe failed; using the full hybrid document retrieval path",
    );
  }
  const searchMode: DocumentSearchMode | undefined = seedOnlyCorpus
    ? "keyword"
    : undefined;

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

  const lookupTimeoutMs = resolveLookupTimeoutMs(options.lookupTimeoutMs);
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
          searchMode,
          accessContext,
          { turnMessageId },
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
      const parsed = parseJSONObjectFromText(raw);
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
            .filter((value) => value.length > 0),
        ),
      ].slice(0, CHAT_DOCUMENTS_RECOVERY_QUERY_LIMIT);
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

    // Only spend an LLM round-trip recovering search queries when the corpus
    // actually returned candidates that merely fell below the relevance
    // threshold — i.e. there ARE documents and a better query might surface
    // them. When the initial search returns NOTHING at all (no documents
    // indexed, or — on hosts forced onto zero/low-dim embeddings, e.g. cloud
    // agents pinned to local gte-small — nothing ever clears retrieval), the
    // recovery call is guaranteed to match nothing too: it just burns one full
    // generate-text round-trip on every plain-chat turn. Skip it. Seed-only
    // corpora skip recovery outright: it exists to find user documents
    // referenced obliquely ("the uploaded file"); with no user documents the
    // rephrased queries can only re-match the same bundled FAQ the direct
    // search already scored.
    if (
      !seedOnlyCorpus &&
      relevantMatches.length === 0 &&
      initialMatches.matches.length > 0
    ) {
      const recoveredQueries = await recoverDocumentSearchQueriesWithLlm();
      // Run the recovered-query searches concurrently. Each is an independent
      // embedding round-trip (~1.5s); awaiting them one at a time was the bulk
      // of the pre-reply latency (this augmentation runs before the reply is
      // generated). Keep the original "first non-empty result wins" preference
      // by scanning the resolved results in query order.
      const recoveredResults = await Promise.all(
        recoveredQueries.map((query) => loadMatchesAcrossScopes(query)),
      );
      if (recoveredResults.some((recovered) => recovered.timedOut)) {
        return message;
      }
      for (const recovered of recoveredResults) {
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
  // clean-prompt embed (a cache hit when the hybrid search above already
  // embedded it; a fresh fire-and-forget round-trip on the keyword/seed-only
  // path, overlapping the turn instead of blocking it) and alias the envelope
  // text onto it, so the whole turn shares one embed of what the user actually
  // asked. `embedRecallQuery` registers its in-flight promise synchronously,
  // so the alias below always finds it.
  if (turnMessageId) {
    void embedRecallQuery(runtime, userPrompt, { messageId: turnMessageId });
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
