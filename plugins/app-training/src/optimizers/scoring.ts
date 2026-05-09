/**
 * Scoring utilities for native optimizers.
 *
 * The default scorer measures token-overlap agreement between the model's
 * actual output and the expected output recorded in the trajectory dataset.
 * It is deliberately cheap and deterministic — the optimizers run hundreds
 * of completions per round, so we cannot afford a model-graded scorer.
 *
 * Token-overlap agreement (Jaccard over normalized tokens) is the same primitive
 * that `replay-validator.ts` uses for `scoreSkill`-style success measurement,
 * just lifted to the (output vs reference) comparison instead of (skill vs
 * trajectory). When a richer signal becomes available, the scorer factory can
 * be swapped without changing any optimizer code.
 */

import type { LlmAdapter, OptimizationExample, PromptScorer } from "./types.js";

interface ScorerOptions {
  /** Cap on examples scored per call. Defaults to all examples. */
  maxExamples?: number;
  /** Temperature passed to the adapter. Defaults to 0 for determinism. */
  temperature?: number;
  /** Max tokens for each completion. Defaults to 512. */
  maxTokens?: number;
  /**
   * Per-example comparator. Defaults to Jaccard token overlap.
   * Returning 1.0 means a perfect match, 0.0 means no credit.
   */
  compare?: (actual: string, expected: string) => number;
}

/**
 * Build a `PromptScorer` backed by a real LLM adapter.
 *
 * For each example:
 *   1. Run `prompt` (as system) + `example.input.user` through the adapter.
 *   2. Compare the completion against `example.expectedOutput` via Jaccard
 *      similarity over normalized tokens.
 *   3. Return the mean score.
 *
 * Reuses the same normalization heuristic as the trajectory-task-datasets
 * exporter (lower-case, strip punctuation, drop empty tokens).
 */
export function createPromptScorer(
  adapter: LlmAdapter,
  options: ScorerOptions = {},
): PromptScorer {
  const temperature = options.temperature ?? 0;
  const maxTokens = options.maxTokens ?? 512;
  const compare = options.compare ?? scoreAgreement;
  return async (prompt, examples) => {
    if (examples.length === 0) return 0;
    const cap = options.maxExamples ?? examples.length;
    const limited = examples.slice(0, Math.max(1, cap));
    let total = 0;
    for (const example of limited) {
      const completion = await adapter.complete({
        system: prompt,
        user: example.input.user,
        temperature,
        maxTokens,
      });
      total += compare(completion, example.expectedOutput);
    }
    return total / limited.length;
  };
}

function stripOutputFences(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z0-9_-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = stripOutputFences(text);
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readLegacyField(
  text: string,
  fieldName: string,
): string | undefined {
  const lineMatch = new RegExp(`(^|\\n)${fieldName}:\\s*([^\\n]+)`, "i").exec(
    text,
  );
  const value = lineMatch?.[2]?.trim();
  return value ? value : undefined;
}

function parsePlannerObject(text: string): Record<string, unknown> {
  const parsed = parseJsonObject(text);
  if (parsed) {
    return parsed;
  }

  const legacyFields: Record<string, unknown> = {};
  for (const fieldName of ["action", "actionName", "name", "type", "actions"]) {
    const value = readLegacyField(text, fieldName);
    if (value) {
      legacyFields[fieldName] = value;
    }
  }
  return legacyFields;
}

/**
 * Extract the first action name from planner output. JSON is preferred; a
 * small line-based reader keeps older key/value rows comparable.
 */
export function extractPlannerAction(text: string): string | null {
  if (!text) return null;
  const parsed = parsePlannerObject(text);
  const raw =
    parsed?.action ??
    parsed?.actionName ??
    parsed?.name ??
    parsed?.type ??
    parsed?.actions;
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",")[0]?.trim().toUpperCase() ?? null;
  }
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (typeof first === "string") return first.trim().toUpperCase();
    if (first && typeof first === "object") {
      const record = first as Record<string, unknown>;
      const name =
        record.name ?? record.action ?? record.actionName ?? record.type;
      if (typeof name === "string") return name.trim().toUpperCase();
    }
  }
  const nameMatch = text.match(/\b([A-Z][A-Z0-9_]{2,})\b/);
  return nameMatch?.[1] ?? null;
}

/**
 * Action-name comparator: returns 1.0 when both outputs resolve to the same
 * planner action name, 0.0 otherwise. This is the right primitive for
 * optimizing the `action_planner` task because token overlap under-credits
 * correct choices when surrounding rationale varies stochastically.
 */
export function scorePlannerAction(actual: string, expected: string): number {
  const actualAction = extractPlannerAction(actual);
  const expectedAction = extractPlannerAction(expected);
  if (!expectedAction) return 0;
  if (!actualAction) return 0;
  return actualAction === expectedAction ? 1 : 0;
}

/**
 * Jaccard similarity over normalized token sets, in `[0, 1]`. Empty inputs
 * collapse to 0 (no overlap to measure).
 */
export function scoreAgreement(actual: string, expected: string): number {
  const actualTokens = tokenize(actual);
  const expectedTokens = tokenize(expected);
  if (expectedTokens.size === 0 && actualTokens.size === 0) return 1;
  if (expectedTokens.size === 0 || actualTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of actualTokens) {
    if (expectedTokens.has(token)) intersection += 1;
  }
  const union = actualTokens.size + expectedTokens.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return new Set(tokens);
}

/**
 * Random-without-replacement subsample, used by optimizer rounds to keep
 * scoring cheap on large datasets without sacrificing comparability across
 * rounds (deterministic when `rng` is supplied).
 */
export function subsample<T>(
  items: T[],
  count: number,
  rng: () => number = Math.random,
): T[] {
  if (count >= items.length) return [...items];
  const indices = new Set<number>();
  const out: T[] = [];
  while (out.length < count) {
    const idx = Math.floor(rng() * items.length);
    if (indices.has(idx)) continue;
    indices.add(idx);
    const item = items[idx];
    if (item !== undefined) out.push(item);
  }
  return out;
}

/**
 * Wraps `IAgentRuntime.useModel` into the `LlmAdapter` shape. We accept a
 * loose runtime type so this module stays free of `@elizaos/core` import
 * cycles — the native backend supplies the bound `useModel` directly.
 */
export type UseModelHandler = (input: {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}) => Promise<string | object | undefined>;

export function createRuntimeAdapter(useModel: UseModelHandler): LlmAdapter {
  return {
    async complete(input) {
      const composed = input.system
        ? `${input.system}\n\n${input.user}`
        : input.user;
      const response = await useModel({
        prompt: composed,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });
      if (typeof response === "string") return response;
      if (response === undefined || response === null) return "";
      return JSON.stringify(response);
    },
  };
}
