/**
 * Scoring + rollup for the eliza-1 bench.
 *
 * One generation = one `CaseMetric`. The runner builds it by combining the
 * mode's `ModeResult` (timing + raw output) with the task-specific ground-truth
 * check (parse / schema / label).
 *
 * The rollup helpers convert a list of case metrics into per (task, mode)
 * `ModeSummary` entries with p50/p95 latency, mean tok/s, and the three rates.
 */
import type {
  CaseMetric,
  JsonValue,
  ModeName,
  ModeResult,
  ModeSummary,
  TaskName,
} from "./types.ts";

/**
 * Strip the model's preamble / suffix and parse the first balanced JSON
 * envelope. Returns null when no JSON object can be extracted.
 *
 * The bench is generous: it accepts JSON that's wrapped in code fences, has
 * leading prose, or has a trailing period. Anything stricter would
 * disadvantage unguided modes and obscure the parse-success signal.
 */
export function tryParseJson(raw: string): JsonValue | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences when present.
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  const body = fence ? fence[1] : trimmed;
  const start = body.indexOf("{");
  if (start < 0) return null;
  // Walk forward looking for the matching `}` accounting for quoted strings.
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (ch === "\\") {
      isEscaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = body.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as JsonValue;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** True when `value` is a plain object (not array, not null). */
export function isPlainObject(
  value: unknown,
): value is Record<string, JsonValue> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { constructor?: unknown }).constructor !== Date
  );
}

/**
 * Check a parsed value against the should-respond schema. The envelope must
 * be `{ shouldRespond: "RESPOND" | "IGNORE" | "STOP" }`.
 */
export function checkShouldRespondSchema(value: JsonValue): boolean {
  if (!isPlainObject(value)) return false;
  const v = value.shouldRespond;
  return v === "RESPOND" || v === "IGNORE" || v === "STOP";
}

/**
 * Check a parsed value against the planner schema:
 * `{ action: string, parameters: object }`. Extra fields are tolerated.
 */
export function checkPlannerSchema(value: JsonValue): boolean {
  if (!isPlainObject(value)) return false;
  if (typeof value.action !== "string") return false;
  if (!isPlainObject(value.parameters)) return false;
  return true;
}

/**
 * Sentinel for "any non-empty string of the same type" in fixture
 * `expected_params`. Use it for free-text reply bodies where the LLM
 * never produces a byte-identical string but the call shape is what
 * we're actually testing.
 */
export const ANY_VALUE_SENTINEL = "<<any>>";

/** Check that all keys in `expected` exist on `parameters` and match by deep-equal. */
export function checkParamsMatch(
  parameters: JsonValue,
  expected: Record<string, JsonValue>,
): boolean {
  if (!isPlainObject(parameters)) return false;
  for (const [key, want] of Object.entries(expected)) {
    const have = parameters[key];
    // Free-text wildcard: only require the field to be a non-empty string.
    // Lets fixtures focus on call-shape match for actions whose payload is
    // LLM-authored prose (REPLY.text, CREATE_REMINDER.text, …).
    if (want === ANY_VALUE_SENTINEL) {
      if (typeof have !== "string" || have.length === 0) return false;
      continue;
    }
    if (!deepEqual(have, want)) return false;
  }
  return true;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (
        !deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** Approximate token count when the mode doesn't report one. ~4 chars / token. */
export function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

/** Build a `CaseMetric` from a `ModeResult` and a (parse, schema, label) decision. */
export function buildMetric(args: {
  taskId: TaskName;
  modeId: ModeName;
  caseId: string;
  result: ModeResult;
  parse_success: boolean;
  schema_valid: boolean;
  label_match: boolean | null;
}): CaseMetric {
  const total = args.result.totalLatencyMs;
  const tokens =
    args.result.tokensGenerated > 0
      ? args.result.tokensGenerated
      : approxTokens(args.result.rawOutput);
  const tps = total > 0 ? (tokens / total) * 1000 : 0;
  return {
    taskId: args.taskId,
    modeId: args.modeId,
    caseId: args.caseId,
    parse_success: args.parse_success,
    schema_valid: args.schema_valid,
    label_match: args.label_match,
    first_token_latency_ms: args.result.firstTokenLatencyMs,
    total_latency_ms: total,
    tokens_generated: tokens,
    tokens_per_second: tps,
    raw_output: args.result.rawOutput,
    error: args.result.error,
  };
}

/**
 * Percentile helper. Returns null when the input is empty. `p` is between 0
 * and 100 inclusive. Uses linear interpolation between the two nearest ranks.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Group case metrics by (taskId, modeId) and roll them up. */
export function summarize(cases: CaseMetric[]): ModeSummary[] {
  const groups = new Map<string, CaseMetric[]>();
  for (const c of cases) {
    const key = `${c.taskId}__${c.modeId}`;
    const existing = groups.get(key);
    if (existing) existing.push(c);
    else groups.set(key, [c]);
  }
  const out: ModeSummary[] = [];
  for (const [key, list] of groups) {
    const [taskId, modeId] = key.split("__") as [TaskName, ModeName];
    const total = list.length;
    const parseOk = list.filter((c) => c.parse_success).length;
    const schemaOk = list.filter((c) => c.schema_valid).length;
    const labelEligible = list.filter((c) => c.label_match !== null);
    const labelOk = labelEligible.filter((c) => c.label_match === true).length;
    const totalLatencies = list.map((c) => c.total_latency_ms);
    const ftlList = list
      .map((c) => c.first_token_latency_ms)
      .filter((v): v is number => typeof v === "number");
    const tpsSum = list.reduce((acc, c) => acc + c.tokens_per_second, 0);
    out.push({
      taskId,
      modeId,
      cases: total,
      parse_success_rate: total === 0 ? 0 : parseOk / total,
      schema_valid_rate: total === 0 ? 0 : schemaOk / total,
      label_match_rate:
        labelEligible.length === 0 ? 0 : labelOk / labelEligible.length,
      first_token_latency_p50_ms: percentile(ftlList, 50),
      first_token_latency_p95_ms: percentile(ftlList, 95),
      total_latency_p50_ms: percentile(totalLatencies, 50) ?? 0,
      total_latency_p95_ms: percentile(totalLatencies, 95) ?? 0,
      mean_tokens_per_second: total === 0 ? 0 : tpsSum / total,
    });
  }
  out.sort((a, b) =>
    a.taskId === b.taskId
      ? a.modeId.localeCompare(b.modeId)
      : a.taskId.localeCompare(b.taskId),
  );
  return out;
}
