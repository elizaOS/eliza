/**
 * LLM-based priority scoring for the LifeOps inbox.
 *
 * This module replaces the v1 keyword/regex heuristic in
 * `service-mixin-inbox.ts:scoreSmallGroupThread`. The scorer asks a small,
 * fast model to rate each message on a 0–100 importance scale and to bucket
 * it into one of three categories (`important` / `planning` / `casual`).
 *
 * Behavior:
 * - Batches up to ~10 messages per call to keep prompts small.
 * - Caches results in-memory keyed by `(messageId, contentHash, model)` so
 *   re-fetches inside a single runtime are free.
 * - Concurrency-capped to 4 parallel batches.
 * - If the LLM call or parser fails, returns `null` per message so the caller
 *   can fall back to the v1 heuristic.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  logger,
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import type { LifeOpsInboxMessage } from "@elizaos/shared";

export type PriorityCategory = "important" | "planning" | "casual";

export interface PriorityScore {
  /** 0–100 score; higher = more important. */
  score: number;
  category: PriorityCategory;
  flags: string[];
}

export interface ScoreInboxMessagesOptions {
  /** Used as the user identity in the prompt. */
  ownerName?: string | null;
  /** Optional list of important relationships shown to the model as priors. */
  topRelationships?: string[];
  /**
   * Optional model id forwarded as the `model` parameter to `runtime.useModel`.
   * When omitted the runtime's default `TEXT_SMALL` model handles the call.
   */
  model?: string | null;
  /** Cap on parallel batches. Defaults to 4. */
  concurrency?: number;
}

const BATCH_SIZE = 10;
const DEFAULT_CONCURRENCY = 4;
const CACHE_MAX_ENTRIES = 5000;

// Bounded LRU-ish cache. Trims the oldest 20% on overflow.
const cache = new Map<string, PriorityScore>();

function cacheGet(key: string): PriorityScore | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    // Move-to-end: re-insert so this key is now the freshest.
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: PriorityScore): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const dropCount = Math.floor(CACHE_MAX_ENTRIES * 0.2);
    let dropped = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      dropped += 1;
      if (dropped >= dropCount) break;
    }
  }
  cache.set(key, value);
}

/**
 * djb2-style hash on the snippet/subject. Cheap, deterministic, and good
 * enough for cache keys — we are not using this for security or de-dup.
 */
function contentHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function cacheKey(message: LifeOpsInboxMessage, modelId: string): string {
  const text = `${message.subject ?? ""}|${message.snippet ?? ""}`;
  return `${modelId}::${message.id}::${contentHash(text)}`;
}

const VALID_CATEGORIES = new Set<PriorityCategory>([
  "important",
  "planning",
  "casual",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function promptValue(
  value: string | null | undefined,
  maxLength: number,
): string {
  const normalized = (value ?? "").slice(0, maxLength).replace(/\s+/g, " ");
  const trimmed = normalized.trim();
  return trimmed.length > 0 ? trimmed : "null";
}

function buildPrompt(
  batch: LifeOpsInboxMessage[],
  opts: ScoreInboxMessagesOptions,
): string {
  const lines: string[] = [];
  lines.push(
    "You are a priority scorer for a personal inbox. For each message decide:",
    "- score: integer 0–100 reflecting how much the user should care right now (100 = drop everything; 0 = ignorable).",
    "- category: one of:",
    "    - important: high signal, demands attention or action soon",
    "    - planning: schedules, dates, times, RSVPs, meeting coordination",
    "    - casual: chit-chat, social, low-stakes notifications",
    "- flags: zero or more short tags from { mention, question, deadline, meeting, money, urgent, group_call, ask }",
    "",
    "Calibration:",
    "- Direct DMs from real people > group chatter > newsletters/automation.",
    "- Mentions of the user, direct questions, or scheduling/dates push score above 70.",
    "- Pure social pleasantries with no ask and no time element belong in 'casual' with score < 35.",
  );
  if (opts.ownerName && opts.ownerName.trim().length > 0) {
    lines.push(
      "",
      "Owner TOON:",
      `ownerName: ${promptValue(opts.ownerName, 160)}`,
    );
  }
  if (opts.topRelationships && opts.topRelationships.length > 0) {
    lines.push(
      "",
      "Important contacts TOON (treat their messages as higher priority):",
      opts.topRelationships
        .slice(0, 12)
        .map(
          (name, index) =>
            `importantContacts[${index}]: ${promptValue(name, 160)}`,
        )
        .join("\n"),
    );
  }
  lines.push("", "Messages TOON:");
  for (const [index, message] of batch.entries()) {
    lines.push(
      `messages[${index}]:`,
      `  from: ${promptValue(message.sender?.displayName ?? "unknown", 160)}`,
      `  channel: ${promptValue(message.channel, 80)}`,
      `  chatType: ${promptValue(message.chatType ?? "dm", 40)}`,
      `  participantCount: ${
        typeof message.participantCount === "number"
          ? message.participantCount
          : "null"
      }`,
      `  subject: ${promptValue(message.subject, 200)}`,
      `  snippet: ${promptValue(message.snippet, 600)}`,
    );
  }
  lines.push(
    "",
    "Return TOON only. No prose, markdown, code fences, or hidden reasoning.",
    `Return exactly ${batch.length} zero-based scores records aligned to messages[0] through messages[${
      batch.length - 1
    }].`,
    "Use this row format:",
    "scores[0]{score,category,flags}: 82, important, question|deadline",
    "score: integer 0-100",
    "category: important | planning | casual",
    "flags: pipe-separated tags from mention|question|deadline|meeting|money|urgent|group_call|ask, or empty",
  );
  return lines.join("\n");
}

const STRUCTURED_CODE_FENCE_PATTERN =
  /^\s*```(?:toon|json|json5)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i;

function stripModelWrapper(raw: string): string {
  let candidate = raw.trim();
  if (candidate.length === 0) {
    throw new Error("priority scoring returned an empty response");
  }
  const thinkEnd = candidate.indexOf("</think>");
  if (candidate.startsWith("<think>") && thinkEnd !== -1) {
    candidate = candidate.slice(thinkEnd + "</think>".length).trim();
  }
  const fenced = candidate.match(STRUCTURED_CODE_FENCE_PATTERN);
  if (fenced) {
    candidate = (fenced[1] ?? "").trim();
  }
  return candidate;
}

function parseScoreNumber(value: unknown): number {
  const score =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(score)) {
    throw new Error("priority scoring score is not a finite number");
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function parseCategory(value: unknown): PriorityCategory {
  const category = typeof value === "string" ? value.trim() : "";
  if (!VALID_CATEGORIES.has(category as PriorityCategory)) {
    throw new Error("priority scoring category is not a valid enum");
  }
  return category as PriorityCategory;
}

function parseFlags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseFlags(entry));
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "[]" ||
    trimmed.toLowerCase() === "null" ||
    trimmed.toLowerCase() === "none"
  ) {
    return [];
  }
  return trimmed
    .split(/[|,]/)
    .map((flag) => flag.replace(/^["'`]+|["'`]+$/g, "").trim())
    .filter(Boolean);
}

function scoreFromRecord(item: Record<string, unknown>): PriorityScore {
  return {
    score: parseScoreNumber(item.score),
    category: parseCategory(item.category),
    flags: parseFlags(item.flags),
  };
}

function scoreFromDelimitedRow(row: string): PriorityScore {
  const [score, category, flags = ""] = row.split(/,(.*)/s);
  const categoryAndFlags = category.split(/,(.*)/s);
  return {
    score: parseScoreNumber(score),
    category: parseCategory(categoryAndFlags[0]),
    flags: parseFlags(categoryAndFlags[1] ?? flags),
  };
}

function parseScoresFromJsonObject(
  parsed: Record<string, unknown>,
  expectedLength: number,
): PriorityScore[] | null {
  if (parsed.scores === undefined) {
    return null;
  }
  if (!Array.isArray(parsed.scores)) {
    throw new Error(
      "priority scoring TOON response did not include scores records",
    );
  }
  const out: PriorityScore[] = [];
  for (let i = 0; i < expectedLength; i += 1) {
    const item = parsed.scores[i];
    if (isRecord(item)) {
      out.push(scoreFromRecord(item));
      continue;
    }
    if (typeof item === "string") {
      out.push(scoreFromDelimitedRow(item));
      continue;
    }
    throw new Error("priority scoring omitted one or more messages");
  }
  return out;
}

function parseLegacyJsonScores(
  candidate: string,
  expectedLength: number,
): PriorityScore[] {
  if (!candidate.startsWith("[")) {
    throw new Error(
      "priority scoring did not return TOON scores or a legacy JSON array",
    );
  }
  const parsed = JSON.parse(candidate) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("priority scoring did not return a JSON array");
  }
  const out: PriorityScore[] = [];
  for (let i = 0; i < expectedLength; i += 1) {
    const item = parsed[i];
    if (!isRecord(item)) {
      throw new Error("priority scoring omitted one or more messages");
    }
    out.push(scoreFromRecord(item));
  }
  return out;
}

function parseScores(raw: string, expectedLength: number): PriorityScore[] {
  const candidate = stripModelWrapper(raw);
  const parsedJson = parseJsonModelRecord<Record<string, unknown>>(candidate);
  if (parsedJson) {
    const scores = parseScoresFromJsonObject(parsedJson, expectedLength);
    if (scores) return scores;
  }
  return parseLegacyJsonScores(candidate, expectedLength);
}

async function scoreBatch(
  runtime: IAgentRuntime,
  batch: LifeOpsInboxMessage[],
  opts: ScoreInboxMessagesOptions,
): Promise<PriorityScore[]> {
  const prompt = buildPrompt(batch, opts);
  // We ask the runtime for TEXT_SMALL but pass the optional `model` override
  // so a configured model id (e.g. `claude-haiku-4-5`) is honored when the
  // active provider supports model selection. The runtime's GenerateTextParams
  // is typed as `prompt`-only at the public boundary; the optional `model`
  // override is read by providers via index access.
  const params = (
    opts.model && opts.model.trim().length > 0
      ? { prompt, model: opts.model.trim() }
      : { prompt }
  ) as { prompt: string };
  const raw = await runWithTrajectoryContext(
    { purpose: "lifeops-priority-scoring" },
    () => runtime.useModel(ModelType.TEXT_SMALL, params),
  );
  const text = typeof raw === "string" ? raw : "";
  return parseScores(text, batch.length);
}

/**
 * Score a batch of inbox messages with the LLM. Returns a parallel array of
 * scores; entries are `null` when the LLM call or parser fails for that
 * batch — callers should fall back to a heuristic for those messages.
 *
 * The scorer is cache-aware: messages whose `(id, content, model)` was
 * already scored within this process are returned from cache without
 * triggering a model call.
 */
export async function scoreInboxMessages(
  runtime: IAgentRuntime,
  messages: LifeOpsInboxMessage[],
  opts: ScoreInboxMessagesOptions = {},
): Promise<Array<PriorityScore | null>> {
  if (messages.length === 0) return [];
  if (typeof runtime.useModel !== "function") {
    return messages.map(() => null);
  }
  const modelId =
    opts.model && opts.model.trim().length > 0
      ? opts.model.trim()
      : "default-text-small";

  const results: Array<PriorityScore | null> = new Array(messages.length).fill(
    null,
  );
  const todoIndices: number[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    const cached = cacheGet(cacheKey(m, modelId));
    if (cached) {
      results[i] = cached;
    } else {
      todoIndices.push(i);
    }
  }
  if (todoIndices.length === 0) return results;

  // Build batches of indices.
  const batches: number[][] = [];
  for (let i = 0; i < todoIndices.length; i += BATCH_SIZE) {
    batches.push(todoIndices.slice(i, i + BATCH_SIZE));
  }

  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, batches.length),
  );

  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w += 1) {
    workers.push(
      (async () => {
        while (true) {
          const next = cursor;
          cursor += 1;
          if (next >= batches.length) return;
          const indices = batches[next];
          if (!indices) return;
          const batchMessages = indices.map((idx) => messages[idx]!);
          try {
            const scored = await scoreBatch(runtime, batchMessages, opts);
            for (let j = 0; j < indices.length; j += 1) {
              const idx = indices[j]!;
              const score = scored[j];
              if (!score) continue;
              results[idx] = score;
              cacheSet(cacheKey(batchMessages[j]!, modelId), score);
            }
          } catch (error) {
            logger.warn(
              {
                src: "lifeops.priority-scoring",
                count: indices.length,
                error: error instanceof Error ? error.message : String(error),
              },
              "[lifeops] priority scoring batch failed; leaving entries null",
            );
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/** Test seam — reset the in-process cache between unit tests. */
export function __resetPriorityScoringCacheForTests(): void {
  cache.clear();
}
