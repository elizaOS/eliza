/**
 * Flag-gated semantic recall for the Shared edge runtime. Mirrors the merged
 * FACTS-provider embedding fallback (#20514): the lexical salience path in
 * shared-runtime-history-policy.ts stays primary, and an embedding search over
 * the tenant Postgres transcript runs ONLY when that keyword path missed.
 * Embeddings come from the native Cloudflare Workers AI binding with the
 * canonical BGE-small vector-space contract (384 dimensions, mean pooling,
 * explicit L2 normalization).
 *
 * `buildSharedRecallContext` is pure orchestration over injected
 * `embed`/`storeSearch` collaborators and owns no degrade policy: failures
 * propagate typed so the live turn boundary decides whether recall loss is
 * survivable. Workers AI calls are fail-fast with a single bounded attempt
 * (5s abort, no retries); the caller owns retry/backoff policy.
 */

import {
  CANONICAL_EMBEDDING_DIMENSION,
  CANONICAL_EMBEDDING_MAX_CONTEXT_TOKENS,
  CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS,
  CANONICAL_EMBEDDING_POOLING,
  CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
  ElizaError,
  normalizeCanonicalEmbedding,
  prepareCanonicalEmbeddingInput,
} from "@elizaos/core/edge";
import type { RuntimeWorkersAiBinding } from "../../../types/cloud-worker-env";
import type { SharedTurnMessage } from "./run-shared-agent-turn";

export const SHARED_RECALL_EDGE_COMPATIBILITY = {
  target: "edge",
  state: "tenant-postgres",
  effects: ["tenant-postgres-read", "workers-ai-embeddings"],
  requiredBindings: ["HYPERDRIVE", "AI"],
  requiredSecrets: [],
} as const;

/** Exact Workers AI catalog id. It is distinct from the persisted space fingerprint. */
export const SHARED_RECALL_WORKERS_AI_MODEL = "@cf/baai/bge-small-en-v1.5" as const;
/** Persisted in `embedding_model` so legacy same-width GTE/BGE vectors never mix. */
export const SHARED_RECALL_EMBEDDING_MODEL = CANONICAL_EMBEDDING_SPACE_FINGERPRINT;
export const SHARED_RECALL_EMBEDDING_DIMENSIONS = CANONICAL_EMBEDDING_DIMENSION;
export const SHARED_RECALL_EMBEDDING_POOLING = CANONICAL_EMBEDDING_POOLING;
/** BGE context size retained for diagnostics and compatibility. */
export const SHARED_RECALL_EMBED_MAX_INPUT_TOKENS = CANONICAL_EMBEDDING_MAX_CONTEXT_TOKENS;
/** Conservative core boundary enforced before Workers AI dispatch. */
export const SHARED_RECALL_EMBED_MAX_INPUT_CODE_UNITS = CANONICAL_EMBEDDING_MAX_INPUT_CODE_UNITS;
/** Workers AI synchronous text-array limit from the model schema. */
export const SHARED_RECALL_EMBED_MAX_BATCH_SIZE = 100;
export const SHARED_RECALL_EMBED_TIMEOUT_MS = 5_000;
export const SHARED_RECALL_DEFAULT_TOP_K = 5;
export const SHARED_RECALL_DEFAULT_MAX_CHARS = 1_200;

/**
 * Per-row content clip applied before block assembly so one pathological row
 * cannot consume the whole character budget and starve every later match.
 */
const ROW_CONTENT_CLIP_CHARS = 240;

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
  /** Embeds the query text (normally `embedTextViaWorkersAi` partially applied). */
  embed: (text: string) => Promise<number[]>;
  /** Vector search over the tenant transcript store, ranked best match first. */
  storeSearch: (vector: number[]) => Promise<SharedRecallRow[]>;
  /** Maximum recalled rows rendered; defaults to {@link SHARED_RECALL_DEFAULT_TOP_K}. */
  topK?: number;
  /** Character cap on the whole block; defaults to {@link SHARED_RECALL_DEFAULT_MAX_CHARS}. */
  maxChars?: number;
}

export interface RenderSharedRecallContextInput {
  /** Already-ranked semantic hits, normally from the exact-query warm cache. */
  rows: readonly SharedRecallRow[];
  /** The current recent window; duplicate cached rows are removed at render time. */
  history: readonly SharedTurnMessage[];
  topK?: number;
  maxChars?: number;
}

function invalidWorkersAiResponse(reason: string, context: Record<string, unknown> = {}): never {
  throw new ElizaError("Workers AI returned an invalid embedding response", {
    code: "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
    context: { reason, ...context },
    severity: "ephemeral",
  });
}

function validateWorkersAiEmbeddingResponse(payload: unknown, expectedCount: number): number[][] {
  if (!payload || typeof payload !== "object") {
    invalidWorkersAiResponse("missing-response-object");
  }
  const response = payload as { data?: unknown; pooling?: unknown; shape?: unknown };
  if (response.pooling !== undefined && response.pooling !== SHARED_RECALL_EMBEDDING_POOLING) {
    invalidWorkersAiResponse("wrong-pooling", {
      expected: SHARED_RECALL_EMBEDDING_POOLING,
      actual: response.pooling,
    });
  }
  if (response.shape !== undefined) {
    const validShape =
      Array.isArray(response.shape) &&
      response.shape.length === 2 &&
      response.shape[0] === expectedCount &&
      response.shape[1] === SHARED_RECALL_EMBEDDING_DIMENSIONS;
    if (!validShape) {
      invalidWorkersAiResponse("wrong-shape", {
        expected: [expectedCount, SHARED_RECALL_EMBEDDING_DIMENSIONS],
        actual: response.shape,
      });
    }
  }
  if (!Array.isArray(response.data) || response.data.length !== expectedCount) {
    invalidWorkersAiResponse("invalid-vector-count", {
      expected: expectedCount,
      actual: Array.isArray(response.data) ? response.data.length : undefined,
    });
  }

  return response.data.map((candidate, index) => {
    if (!Array.isArray(candidate)) {
      invalidWorkersAiResponse("missing-vector", { index });
    }
    if (candidate.length !== SHARED_RECALL_EMBEDDING_DIMENSIONS) {
      invalidWorkersAiResponse("wrong-dimensions", {
        index,
        expected: SHARED_RECALL_EMBEDDING_DIMENSIONS,
        actual: candidate.length,
      });
    }
    if (!candidate.every((value) => typeof value === "number" && Number.isFinite(value))) {
      invalidWorkersAiResponse("non-finite-vector", { index });
    }
    try {
      return normalizeCanonicalEmbedding(candidate as number[]);
    } catch (cause) {
      // error-policy:J3 malformed provider output must fail closed before it
      // can enter vector storage or similarity search.
      throw new ElizaError("Workers AI returned an unnormalizable embedding", {
        code: "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
        cause,
        context: { reason: "invalid-l2-norm", index },
        severity: "ephemeral",
      });
    }
  });
}

/**
 * Batch-embeds texts through the native Workers AI binding in input order.
 * The model and mean pooling are explicit, the binding's 100-text synchronous
 * limit and core's conservative 510-code-unit input boundary are enforced
 * locally. A single bounded attempt either returns validated, L2-normalized
 * canonical vectors or throws; partial/fabricated vectors are never returned.
 */
export async function embedTextsViaWorkersAi(
  ai: RuntimeWorkersAiBinding,
  texts: string[],
  options: { tags?: string[] } = {},
): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new ElizaError("Workers AI embedding rejected blank input text", {
      code: "SHARED_RECALL_EMBEDDING_EMPTY_TEXT",
      severity: "fatal",
    });
  }
  const cleaned = new Array<string>(texts.length);
  for (let index = 0; index < texts.length; index += 1) {
    try {
      cleaned[index] = prepareCanonicalEmbeddingInput(texts[index]);
    } catch (cause) {
      const blank = typeof texts[index] === "string" && texts[index].trim().length === 0;
      throw new ElizaError(
        blank
          ? "Workers AI embedding rejected blank input text"
          : "Workers AI embedding rejected invalid canonical input text",
        {
          code: blank
            ? "SHARED_RECALL_EMBEDDING_EMPTY_TEXT"
            : "SHARED_RECALL_EMBEDDING_INVALID_INPUT",
          cause,
          context: {
            index,
            maxInputCodeUnits: SHARED_RECALL_EMBED_MAX_INPUT_CODE_UNITS,
          },
          severity: "fatal",
        },
      );
    }
  }
  if (cleaned.length > SHARED_RECALL_EMBED_MAX_BATCH_SIZE) {
    throw new ElizaError("Workers AI embedding batch exceeds the synchronous model limit", {
      code: "SHARED_RECALL_EMBEDDING_BATCH_LIMIT",
      context: { actual: cleaned.length, max: SHARED_RECALL_EMBED_MAX_BATCH_SIZE },
      severity: "fatal",
    });
  }
  let payload: unknown;
  try {
    payload = await ai.run(
      SHARED_RECALL_WORKERS_AI_MODEL,
      {
        text: cleaned,
        pooling: SHARED_RECALL_EMBEDDING_POOLING,
      },
      {
        signal: AbortSignal.timeout(SHARED_RECALL_EMBED_TIMEOUT_MS),
        tags: options.tags ?? ["eliza:shared-recall"],
      },
    );
  } catch (cause) {
    // error-policy:J2 binding/provider/timeout failures gain the exact model
    // and bounded-attempt context before the turn boundary degrades recall.
    throw new ElizaError("Workers AI embedding request failed", {
      code: "SHARED_RECALL_EMBEDDING_UNREACHABLE",
      cause,
      context: {
        model: SHARED_RECALL_WORKERS_AI_MODEL,
        pooling: SHARED_RECALL_EMBEDDING_POOLING,
        maxInputTokens: SHARED_RECALL_EMBED_MAX_INPUT_TOKENS,
        timeoutMs: SHARED_RECALL_EMBED_TIMEOUT_MS,
      },
      severity: "ephemeral",
    });
  }
  return validateWorkersAiEmbeddingResponse(payload, cleaned.length);
}

export async function embedTextViaWorkersAi(
  ai: RuntimeWorkersAiBinding,
  text: string,
): Promise<number[]> {
  const vectors = await embedTextsViaWorkersAi(ai, [text]);
  const vector = vectors[0];
  if (!vector) {
    invalidWorkersAiResponse("missing-single-vector");
  }
  return vector;
}

function clipRowContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= ROW_CONTENT_CLIP_CHARS) return trimmed;
  return `${trimmed.slice(0, ROW_CONTENT_CLIP_CHARS - 1)}…`;
}

function formatRecallRow(row: SharedRecallRow): string {
  const date =
    typeof row.createdAt === "number" && Number.isFinite(row.createdAt) && row.createdAt > 0
      ? ` ${new Date(row.createdAt).toISOString().slice(0, 10)}`
      : "";
  const label = row.role ? `${row.role}${date}` : `message${date}`;
  return `- [${label}] ${clipRowContent(row.content)}`;
}

function isRenderableRow(row: SharedRecallRow): boolean {
  return typeof row.content === "string" && row.content.trim().length > 0;
}

/**
 * Builds the semantic-recall provider block for one Shared turn, or null when
 * recall contributes nothing: flag off, the lexical path already hit, a blank
 * query, no store matches, or every match already sits in the recent window.
 * Rows keep the store's ranking; output is bounded by `topK` rows and
 * `maxChars` characters. Embed/search failures propagate typed — the turn
 * boundary owns whether recall loss degrades or fails the turn.
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

  return renderSharedRecallContext({
    rows,
    history: input.history,
    ...(input.topK !== undefined ? { topK: input.topK } : {}),
    ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
  });
}

/**
 * Render already-ranked recall rows without provider or database I/O. This is
 * deliberately synchronous so a cache hit can enrich a prompt without adding
 * an embedding/search await before provider dispatch.
 */
export function renderSharedRecallContext(input: RenderSharedRecallContextInput): string | null {
  const rows = input.rows;

  const seenIds = new Set<string>();
  const seenContents = new Set<string>();
  for (const message of input.history) {
    if (message.id) seenIds.add(message.id);
    seenContents.add(message.content.trim());
  }

  const topK = Math.max(1, Math.floor(input.topK ?? SHARED_RECALL_DEFAULT_TOP_K));
  const maxChars = Math.max(
    RECALL_BLOCK_HEADER.length,
    Math.floor(input.maxChars ?? SHARED_RECALL_DEFAULT_MAX_CHARS),
  );

  const fresh: SharedRecallRow[] = [];
  for (const row of rows) {
    if (!isRenderableRow(row)) continue;
    if (row.id && seenIds.has(row.id)) continue;
    const content = row.content.trim();
    if (seenContents.has(content)) continue;
    seenContents.add(content);
    fresh.push(row);
    if (fresh.length >= topK) break;
  }
  if (fresh.length === 0) return null;

  let block = RECALL_BLOCK_HEADER;
  let rendered = 0;
  for (const row of fresh) {
    const candidate = `${block}\n${formatRecallRow(row)}`;
    if (candidate.length > maxChars) break;
    block = candidate;
    rendered += 1;
  }
  if (rendered === 0) return null;
  return block;
}
