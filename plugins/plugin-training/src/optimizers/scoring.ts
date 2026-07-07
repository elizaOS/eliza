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

import type { LlmAdapter, PromptScorer } from "./types.js";

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
   * May be async: the judge-based comparator for the prose LifeOps tasks
   * (`createLifeOpsJudgeCompare`, #11384) grades with a live model.
   */
  compare?: (actual: string, expected: string) => number | Promise<number>;
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
      total += await compare(completion, example.expectedOutput);
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

function readLegacyField(text: string, fieldName: string): string | undefined {
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
 *
 * Schemas understood (in priority order):
 *   1. v5 planner: `{toolCalls:[{name:"OWNER_TODOS","args":{...}}]}` — handled directly.
 *   2. Legacy structured: top-level `action`/`actionName`/`name`/`type`/`actions` field.
 *   3. Legacy line-based: `action: OWNER_TODOS` or similar key:value rows.
 *   4. Last-resort: any uppercase identifier in the text.
 *
 * The regex fallback is intentionally last — it matches identifiers like
 * `OWNER`, `OPTIONAL`, `JSON`, etc. that show up in field names, so it can
 * mislabel non-action text. Prefer the JSON paths when the runtime emits
 * structured output (which is the common case post-v5).
 */
export function extractPlannerAction(text: string): string | null {
  if (!text) return null;
  const parsed = parsePlannerObject(text);
  // v5 toolCalls shape — most common in current trajectories
  if (parsed && Array.isArray(parsed.toolCalls)) {
    const first = parsed.toolCalls[0];
    if (first && typeof first === "object") {
      const record = first as Record<string, unknown>;
      // `toolName` is the shape emitted by harvested gpt-5.5 trajectories'
      // native-export rows; keep the older name/action/actionName aliases too.
      const name =
        record.toolName ?? record.name ?? record.action ?? record.actionName;
      if (typeof name === "string" && name.trim().length > 0) {
        return name.trim().toUpperCase();
      }
    }
  }
  const raw =
    parsed.action ??
    parsed.actionName ??
    parsed.name ??
    parsed.type ??
    parsed.actions;
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
 * Pull a target-view id out of a planner argument object. View navigation
 * carries the surface in one of a few alias keys (`view`/`viewId`/`id`/`target`)
 * — the VIEWS action declares all of them. `name` is intentionally excluded: at
 * tool-call top level `name` is the ACTION name, so reading it as a view would
 * mislabel every call.
 */
function readViewFromArgs(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Record<string, unknown>;
  const v = r.view ?? r.viewId ?? r.id ?? r.target;
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

/**
 * Extract the target view id from planner output when the chosen action is a
 * view navigation. Understands the same shapes as {@link extractPlannerAction}:
 *   1. tool-call: `{toolCalls:[{name:"VIEWS", args/arguments/parameters:{view}}]}`
 *   2. bare action: `{action:"VIEWS", parameters/args:{view}}`
 *   3. top-level alias: `{view}` / `{viewId}`
 * Returns the lower-cased view id, or `null` when none is present.
 */
export function extractPlannerView(text: string): string | null {
  if (!text) return null;
  const parsed = parsePlannerObject(text);
  if (!parsed) return null;
  if (Array.isArray(parsed.toolCalls)) {
    const first = parsed.toolCalls[0];
    if (first && typeof first === "object") {
      const record = first as Record<string, unknown>;
      const fromCall = readViewFromArgs(
        record.args ?? record.arguments ?? record.parameters,
      );
      if (fromCall) return fromCall;
    }
  }
  const fromParams = readViewFromArgs(
    parsed.parameters ?? parsed.args ?? parsed.arguments,
  );
  if (fromParams) return fromParams;
  return readViewFromArgs(parsed);
}

/**
 * Action-name comparator: returns 1.0 when both outputs resolve to the same
 * planner action name, 0.0 otherwise. This is the right primitive for
 * optimizing the `action_planner` task because token overlap under-credits
 * correct choices when surrounding rationale varies stochastically.
 *
 * View-aware refinement: when the expected output pins a specific view (a VIEWS
 * navigation target), a matching action alone is NOT full credit — the view has
 * to match too. Without this the optimizer can never learn correct view
 * selection, because every `VIEWS/<anything>` would score 1.0 against a
 * `VIEWS/calendar` reference (the exact gap that made entry-tier wrong-view
 * outputs look perfect). Partial credit (right action, wrong/missing view =
 * 0.5) keeps a usable gradient for the optimizer. Expected outputs without a
 * view (every non-navigation action) are scored action-only, unchanged.
 */
export function scorePlannerAction(actual: string, expected: string): number {
  const actualAction = extractPlannerAction(actual);
  const expectedAction = extractPlannerAction(expected);
  if (!expectedAction) return 0;
  if (!actualAction) return 0;
  if (actualAction !== expectedAction) return 0;
  const expectedView = extractPlannerView(expected);
  if (!expectedView) return 1;
  const actualView = extractPlannerView(actual);
  if (!actualView) return 0.5;
  return actualView === expectedView ? 1 : 0.5;
}

/**
 * View-selection comparator for the contextual view evaluator (`view_context`
 * task). Both outputs are `{viewId, reason}` (or "none"); credit is 1.0 when the
 * chosen view id matches the reference, 0.0 otherwise. Case-insensitive, and a
 * matching "none" (correctly declining to navigate) scores 1.0 — so it rewards
 * both opening the right surface AND staying put on non-navigational turns.
 */
export function scoreViewSelection(actual: string, expected: string): number {
  const expectedView = extractPlannerView(expected);
  const actualView = extractPlannerView(actual);
  if (expectedView === null && actualView === null) return 1;
  return expectedView === actualView ? 1 : 0;
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

// -----------------------------------------------------------------------------
// LifeOps per-capability scorers (#8795 item 4).
//
// The LifeOps optimization tasks split into two scoring shapes:
//   - Extraction tasks emit structured fields (JSON objects for most tasks,
//     line-based `key: value` fields for a few legacy planners). These are
//     graded on structured-field exact-match — the fraction of expected fields
//     the model reproduced. Date/time/recurrence/recipient are exactly the
//     fields that must be right, so partial-credit-by-field is the right signal.
//   - Chat-shaped tasks emit free text (the morning brief). These fall back to
//     token agreement here; the real optimization loop gates them on the
//     `responseJudge` rubric instead of this cheap proxy.
// Both shapes are deterministic and allocation-light, matching the optimizer's
// hundreds-of-completions-per-round budget.
// -----------------------------------------------------------------------------

/** LifeOps tasks with per-capability scorers (#8795). */
export const LIFEOPS_SCORER_TASKS = [
  "calendar_extract",
  "schedule_plan",
  "reminder_dispatch",
  "inbox_triage",
  "meeting_prep",
  "morning_brief",
  "health_checkin",
  "screentime_recap",
  "creative_draft",
] as const;

/** LifeOps tasks whose output is a structured JSON object (exact-field match). */
export const LIFEOPS_STRUCTURED_SCORER_TASKS = [
  "calendar_extract",
  "schedule_plan",
  "reminder_dispatch",
  "inbox_triage",
  "meeting_prep",
  "health_checkin",
  "screentime_recap",
] as const;

const LIFEOPS_EXTRACTION_TASKS: ReadonlySet<string> = new Set(
  LIFEOPS_STRUCTURED_SCORER_TASKS,
);

function stripFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
}

/** Parse a JSON object out of a completion, tolerating ```json fences/prose. */
function parseJsonLoose(text: string): Record<string, unknown> | null {
  const trimmed = stripFence(text);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Parse legacy line-based planner output: `field: value` per line. */
function parseLineFieldsLoose(text: string): Record<string, unknown> | null {
  const fields: Record<string, string> = {};
  let parsedLines = 0;
  for (const line of stripFence(text).split(/\r?\n/u)) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/u.exec(line.trim());
    if (!match) continue;
    const key = match[1]?.trim();
    if (!key) continue;
    fields[key] = match[2]?.trim() ?? "";
    parsedLines += 1;
  }
  return parsedLines > 0 ? fields : null;
}

function parseStructuredFieldsLoose(
  text: string,
): Record<string, unknown> | null {
  return parseJsonLoose(text) ?? parseLineFieldsLoose(text);
}

function normalizeScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim().toLowerCase();
}

/**
 * Structured-field exact-match score in `[0, 1]`: the fraction of expected
 * fields whose value the actual output reproduced. Both inputs are parsed as
 * JSON or line-based fields (tolerating fences/prose). When `fields` is supplied only those keys are
 * scored; otherwise every key in `expected` is scored. Returns 0 when expected
 * is unparseable (nothing to credit) and 1 when both parse to empty objects.
 */
export function scoreStructuredFields(
  actual: string,
  expected: string,
  fields?: readonly string[],
): number {
  const expectedObj = parseStructuredFieldsLoose(expected);
  if (!expectedObj) return 0;
  const actualObj = parseStructuredFieldsLoose(actual) ?? {};
  const keys =
    fields && fields.length > 0 ? [...fields] : Object.keys(expectedObj);
  if (keys.length === 0) {
    return Object.keys(actualObj).length === 0 ? 1 : 0;
  }
  let matched = 0;
  for (const key of keys) {
    if (normalizeScalar(actualObj[key]) === normalizeScalar(expectedObj[key])) {
      matched += 1;
    }
  }
  return matched / keys.length;
}

/** Tokenize an output into an action/label set (JSON fields or raw words). */
function actionTokens(text: string): Set<string> {
  const obj = parseStructuredFieldsLoose(text);
  const source = obj
    ? [
        obj.action,
        obj.subaction,
        obj.category,
        obj.priority,
        obj.channel,
        obj.suggestion,
      ]
        .map(normalizeScalar)
        .filter(Boolean)
        .join(" ")
    : text;
  return new Set(
    source
      .toLowerCase()
      .split(/[\s,|]+/)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

/**
 * Action/label set-overlap (Jaccard) in `[0, 1]`. For tasks whose target is
 * "did the agent pick the right action/category set" rather than exact text.
 * Two empty sets score 1.0 (both correctly produced nothing actionable).
 */
export function scoreActionSet(actual: string, expected: string): number {
  const actualSet = actionTokens(actual);
  const expectedSet = actionTokens(expected);
  if (actualSet.size === 0 && expectedSet.size === 0) return 1;
  if (actualSet.size === 0 || expectedSet.size === 0) return 0;
  let intersection = 0;
  for (const token of actualSet) {
    if (expectedSet.has(token)) intersection += 1;
  }
  const union = actualSet.size + expectedSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Authoritative per-task comparator for the LifeOps optimization tasks (the
 * GEPA Pareto scorer dispatches through here). Extraction tasks →
 * structured-field exact-match; the chat-shaped morning brief → token
 * agreement (proxy for the judge rubric); anything else → token agreement.
 */
export function scoreLifeOpsTask(
  task: string,
  actual: string,
  expected: string,
): number {
  if (LIFEOPS_EXTRACTION_TASKS.has(task)) {
    return scoreStructuredFields(actual, expected);
  }
  return scoreAgreement(actual, expected);
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
