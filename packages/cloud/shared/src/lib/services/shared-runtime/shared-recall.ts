/**
 * Flag-gated semantic recall for the Shared edge runtime. Mirrors the merged
 * FACTS-provider embedding fallback (#20514): the lexical salience path in
 * shared-runtime-history-policy.ts stays primary, and an embedding search over
 * the tenant Postgres transcript runs ONLY when that keyword path missed.
 * Embeddings come from a sidecar exposing the OpenAI `/v1/embeddings` shape
 * with `bge-small-en-v1.5` (384 dimensions).
 *
 * `buildSharedRecallContext` is pure orchestration over injected
 * `embed`/`storeSearch` collaborators and owns no degrade policy: failures
 * propagate typed so the live turn boundary decides whether recall loss is
 * survivable. Sidecar calls are fail-fast with a single bounded attempt (5s
 * abort, no retries); the caller owns retry/backoff policy.
 */

import { ElizaError } from "@elizaos/core/edge";
import type { SharedTurnMessage } from "./run-shared-agent-turn";

export const SHARED_RECALL_EDGE_COMPATIBILITY = {
  target: "edge",
  state: "tenant-postgres",
  effects: ["tenant-postgres-read", "sidecar-embeddings"],
  requiredBindings: ["HYPERDRIVE"],
  requiredSecrets: [],
} as const;

export const SHARED_RECALL_EMBEDDING_MODEL = "bge-small-en-v1.5";
export const SHARED_RECALL_EMBEDDING_DIMENSIONS = 384;
export const SHARED_RECALL_EMBED_TIMEOUT_MS = 5_000;
const RECALL_BLOCK_HEADER =
  "Recalled from earlier in this conversation (matches beyond the recent window):";

/** One transcript row returned by the tenant-store vector search, best match first. */
export interface SharedRecallRow {
  /** Stable message id, when the store carries one; used to dedupe against the recent window. */
  id?: string;
  role?: SharedTurnMessage["role"];
  content: string;
  /** Epoch-ms timestamp rendered as a date label when present. */
  createdAt?: number;
}

export interface BuildSharedRecallContextInput {
  /** Rollout gate. When false this feature does not exist: no embed, no search, null. */
  flagEnabled: boolean;
  /**
   * True when the existing lexical salience path already surfaced a relevant
   * older turn. Embedding search is the MISS fallback (#20514 pattern), so a
   * keyword hit short-circuits to null without paying any embedding cost.
   */
  hadKeywordHit: boolean;
  /** Text of the incoming user turn the recall query embeds. */
  queryText: string;
  /** The already-projected recent window; recalled rows duplicated here are dropped. */
  history: readonly SharedTurnMessage[];
  /** Embeds the query text (normally `embedTextViaSidecar` partially applied). */
  embed: (text: string) => Promise<number[]>;
  /** Vector search over the tenant transcript store, ranked best match first. */
  storeSearch: (vector: number[]) => Promise<SharedRecallRow[]>;
  /** @deprecated Recall rendering is complete; this option is ignored. */
  topK?: number;
  /** @deprecated Recall rendering is complete; this option is ignored. */
  maxChars?: number;
}

function readSidecarEmbedding(payload: unknown): number[] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (!first || typeof first !== "object") return undefined;
  const embedding = (first as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) return undefined;
  if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return undefined;
  }
  return embedding as number[];
}

/**
 * Embeds one text through the platform embedding sidecar's OpenAI-shaped
 * `POST <baseUrl>/v1/embeddings` endpoint. Single attempt, 5s abort, typed
 * failures; never returns a partial or fabricated vector.
 */
/**
 * Batch variant of {@link embedTextViaSidecar}: one sidecar call for several
 * texts, vectors returned in input order. Used by the write path so a turn
 * pair costs a single embedding round-trip. Same 5s abort and typed failures;
 * a count mismatch is an invalid response, never a partial result.
 */
export async function embedTextsViaSidecar(
  baseUrl: string,
  apiKey: string | undefined,
  texts: string[],
): Promise<number[][]> {
  const cleaned = texts.map((text) => text.trim());
  if (cleaned.length === 0 || cleaned.some((text) => !text)) {
    throw new ElizaError("Embedding sidecar rejected blank input text", {
      code: "SHARED_RECALL_EMBEDDING_EMPTY_TEXT",
      severity: "fatal",
    });
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/embeddings`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ input: cleaned, model: SHARED_RECALL_EMBEDDING_MODEL }),
      signal: AbortSignal.timeout(SHARED_RECALL_EMBED_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ElizaError("Embedding sidecar was unreachable", {
      code: "SHARED_RECALL_EMBEDDING_UNREACHABLE",
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!response.ok) {
    throw new ElizaError(`Embedding sidecar returned HTTP ${response.status}`, {
      code: "SHARED_RECALL_EMBEDDING_HTTP_ERROR",
      context: { status: response.status },
    });
  }
  let payload: { data?: Array<{ embedding?: unknown }> };
  try {
    payload = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
  } catch (cause) {
    // error-policy:J3 a non-JSON 2xx body becomes an explicit invalid-response
    // failure so the memory store can degrade to vector-less rows.
    throw new ElizaError("Embedding sidecar returned a non-JSON batch body", {
      code: "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
      cause,
      context: { reason: "non-json-body" },
      severity: "ephemeral",
    });
  }
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const vectors = data.map((entry) => readSidecarEmbedding({ data: [entry] }));
  const wrongDimensionIndex = vectors.findIndex(
    (vector) => vector !== undefined && vector.length !== SHARED_RECALL_EMBEDDING_DIMENSIONS,
  );
  if (
    vectors.length !== cleaned.length ||
    vectors.some((vector) => vector === undefined) ||
    wrongDimensionIndex !== -1
  ) {
    throw new ElizaError("Embedding sidecar returned an invalid batch response", {
      code: "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
      context:
        wrongDimensionIndex === -1
          ? { reason: "invalid-vector-count", expected: cleaned.length, received: vectors.length }
          : {
              reason: "wrong-dimensions",
              index: wrongDimensionIndex,
              expected: SHARED_RECALL_EMBEDDING_DIMENSIONS,
              actual: vectors[wrongDimensionIndex]?.length,
            },
      severity: "ephemeral",
    });
  }
  return vectors as number[][];
}

export async function embedTextViaSidecar(
  baseUrl: string,
  apiKey: string | undefined,
  text: string,
): Promise<number[]> {
  if (!text.trim()) {
    throw new ElizaError("Embedding sidecar rejected blank input text", {
      code: "SHARED_RECALL_EMBEDDING_EMPTY_TEXT",
      severity: "fatal",
    });
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/embeddings`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ input: text, model: SHARED_RECALL_EMBEDDING_MODEL }),
      signal: AbortSignal.timeout(SHARED_RECALL_EMBED_TIMEOUT_MS),
    });
  } catch (cause) {
    // error-policy:J2 network/timeout failure gains the sidecar identity and
    // bounded-attempt context before the caller's retry policy classifies it.
    throw new ElizaError("Embedding sidecar request failed", {
      code: "SHARED_RECALL_EMBEDDING_UNREACHABLE",
      cause,
      context: { url, timeoutMs: SHARED_RECALL_EMBED_TIMEOUT_MS },
      severity: "ephemeral",
    });
  }
  if (!response.ok) {
    throw new ElizaError(`Embedding sidecar returned HTTP ${response.status}`, {
      code: "SHARED_RECALL_EMBEDDING_HTTP_ERROR",
      context: { url, status: response.status },
      severity: "ephemeral",
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    // error-policy:J3 a non-JSON 2xx body becomes an explicit invalid-response
    // failure, never an empty or fabricated vector.
    throw new ElizaError("Embedding sidecar returned a non-JSON body", {
      code: "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
      cause,
      context: { url, reason: "non-json-body" },
      severity: "ephemeral",
    });
  }
  const embedding = readSidecarEmbedding(payload);
  if (!embedding) {
    throw new ElizaError("Embedding sidecar response omitted a numeric embedding", {
      code: "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
      context: { url, reason: "missing-embedding" },
      severity: "ephemeral",
    });
  }
  if (embedding.length !== SHARED_RECALL_EMBEDDING_DIMENSIONS) {
    throw new ElizaError("Embedding sidecar returned the wrong vector dimensionality", {
      code: "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
      context: {
        url,
        reason: "wrong-dimensions",
        expected: SHARED_RECALL_EMBEDDING_DIMENSIONS,
        actual: embedding.length,
      },
      severity: "ephemeral",
    });
  }
  return embedding;
}

function formatRecallRow(row: SharedRecallRow): string {
  const date =
    typeof row.createdAt === "number" && Number.isFinite(row.createdAt) && row.createdAt > 0
      ? ` ${new Date(row.createdAt).toISOString().slice(0, 10)}`
      : "";
  const label = row.role ? `${row.role}${date}` : `message${date}`;
  return `- [${label}] ${row.content.trim()}`;
}

function isRenderableRow(row: SharedRecallRow): boolean {
  return typeof row.content === "string" && row.content.trim().length > 0;
}

/**
 * Builds the semantic-recall provider block for one Shared turn, or null when
 * recall contributes nothing: flag off, the lexical path already hit, a blank
 * query, no store matches, or every match already sits in the recent window.
 * Rows keep the store's ranking and complete content. Embed/search failures
 * propagate typed — the turn boundary owns whether recall loss degrades or
 * fails the turn.
 */
export async function buildSharedRecallContext(
  input: BuildSharedRecallContextInput,
): Promise<string | null> {
  if (!input.flagEnabled) return null;
  if (input.hadKeywordHit) return null;
  const queryText = input.queryText.trim();
  if (!queryText) return null;

  const vector = await input.embed(queryText);
  const rows = await input.storeSearch(vector);

  const seenIds = new Set<string>();
  const seenContents = new Set<string>();
  for (const message of input.history) {
    if (message.id) seenIds.add(message.id);
    seenContents.add(message.content.trim());
  }

  void input.topK;
  void input.maxChars;

  const fresh: SharedRecallRow[] = [];
  for (const row of rows) {
    if (!isRenderableRow(row)) continue;
    if (row.id && seenIds.has(row.id)) continue;
    const content = row.content.trim();
    if (seenContents.has(content)) continue;
    seenContents.add(content);
    fresh.push(row);
  }
  if (fresh.length === 0) return null;

  return `${RECALL_BLOCK_HEADER}\n${fresh.map(formatRecallRow).join("\n")}`;
}
