/**
 * Result and parameter helpers shared by the action handlers: the
 * `failureToActionResult`/`successActionResult` builders that produce the
 * `ActionResult` envelope, and the `readStringParam`/`readNumberParam` readers that
 * coerce loosely-typed handler options into validated values. Keeps every action's
 * success/failure shape identical.
 */
import {
  type ActionResult,
  type IAgentRuntime,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import {
  type ActionResultData,
  FAILURE_TEXT_PREFIX,
  type ToolFailure,
} from "../types.js";

/**
 * Wrap preformatted tool output (shell transcripts, grep matches, directory
 * listings) in a markdown code fence for the user-facing callback channel.
 * Chat connectors render callback text as markdown, so unfenced transcripts
 * get mangled — Discord eats `*` pairs as italics, turning `-name "*.md"`
 * into `-name ".md"` in the rendered message. The fence length adapts to the
 * longest backtick run in the payload so embedded fences cannot break out.
 * Planner-facing ActionResult text stays raw — fence only what users see.
 */
export function fencePreformatted(text: string): string {
  const longestRun =
    text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `${fence}\n${body}${fence}`;
}

/**
 * Bound a tool transcript for the USER-VISIBLE chat callback. Connectors split
 * anything over their message limit into a flood of follow-up messages (a bare
 * `ls -la` becomes 8+ Discord posts), so the visible copy keeps the head and
 * tail on line boundaries with an elision marker. The planner-facing
 * ActionResult text is never capped — the model always sees the full output.
 */
export function capTranscriptForChat(text: string, maxChars = 1500): string {
  if (text.length <= maxChars) return text;
  const headBudget = Math.floor(maxChars * 0.65);
  const tailBudget = maxChars - headBudget;
  const head = text.slice(0, headBudget);
  const tail = text.slice(-tailBudget);
  const headEnd = head.lastIndexOf("\n");
  const tailStart = tail.indexOf("\n");
  const headPart = headEnd > 0 ? head.slice(0, headEnd) : head;
  const tailPart = tailStart >= 0 ? tail.slice(tailStart + 1) : tail;
  const middle = text
    .slice(headPart.length, text.length - tailPart.length)
    .replace(/^\n/, "")
    .replace(/\n$/, "");
  const omitted = middle.split("\n").length;
  return `${headPart}\n… [${omitted} lines omitted — ask to see more] …\n${tailPart}`;
}

/**
 * Keep a model-facing tool result within a character budget without splitting
 * UTF-16 surrogate pairs. The omitted count describes the sanitized string so
 * malformed provider or process output cannot leak invalid Unicode downstream.
 */
export function truncate(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const sanitized = toWellFormedUnicode(text);
  if (sanitized.length <= maxChars) {
    return { text: sanitized, truncated: false };
  }
  const prefix = truncateWellFormed(sanitized, Math.max(0, maxChars));
  return {
    text: `${prefix}\n… [${sanitized.length - prefix.length} more chars omitted]`,
    truncated: true,
  };
}

export function failureToActionResult(
  failure: ToolFailure,
  data?: Record<string, unknown>,
): ActionResult {
  const text = `${FAILURE_TEXT_PREFIX} ${failure.reason}: ${failure.message}`;
  return {
    success: false,
    text,
    error: new Error(text),
    ...(data ? { data: data as ActionResultData } : {}),
  };
}

export function successActionResult(
  text: string,
  data?: Record<string, unknown>,
): ActionResult {
  return {
    success: true,
    text,
    ...(data ? { data: data as ActionResultData } : {}),
  };
}

/**
 * A success result whose `text` is ALSO marked user-facing. Use only for
 * mutation confirmations whose text is a clean, user-safe one-liner
 * ("Wrote N bytes to <path>", "Replaced N occurrences in <path>") — never for
 * log-shaped output (reads, grep, ls, shell). The planner-loop relays
 * `userFacingText` verbatim when the post-tool evaluator model call fails, so
 * the completed write is reported truthfully instead of as a generic failure;
 * it never guesses the diagnostic `text` of a log-emitting tool into that
 * channel. `verifiedUserFacing` is deliberately left unset so an explicit
 * evaluator `messageToUser` still outranks this on the happy path.
 */
export function userFacingSuccessResult(
  text: string,
  data?: Record<string, unknown>,
): ActionResult {
  return { ...successActionResult(text, data), userFacingText: text };
}

export function readParam<T = unknown>(
  options: unknown,
  name: string,
): T | undefined {
  if (!options || typeof options !== "object") return undefined;
  const opts = options as Record<string, unknown>;
  const params = opts.parameters as Record<string, unknown> | undefined;
  const value = (params?.[name] ?? opts[name]) as T | undefined;
  return value;
}

export function readStringParam(
  options: unknown,
  name: string,
): string | undefined {
  const v = readParam<unknown>(options, name);
  return typeof v === "string" ? v : undefined;
}

export function readNumberParam(
  options: unknown,
  name: string,
): number | undefined {
  const v = readParam<unknown>(options, name);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function readBoolParam(
  options: unknown,
  name: string,
): boolean | undefined {
  const v = readParam<unknown>(options, name);
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1" || v === 1) return true;
  if (v === "false" || v === "0" || v === 0) return false;
  return undefined;
}

export function readArrayParam(
  options: unknown,
  name: string,
): unknown[] | undefined {
  const v = readParam<unknown>(options, name);
  return Array.isArray(v) ? v : undefined;
}

/** Reads a numeric runtime setting; invalid or missing falls back to `fallback`. */
export function readPositiveIntSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: number,
): number {
  const v = runtime.getSetting(key);
  if (typeof v === "number" && Number.isFinite(v) && v > 0)
    return Math.floor(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return fallback;
}

/** Reads an operator setting that must be a bounded, canonical integer. */
export function readBoundedIntSetting(
  runtime: IAgentRuntime,
  key: string,
  min: number,
  max: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { value: number } | { error: string } | undefined {
  const runtimeValue = runtime.getSetting(key);
  // AgentRuntime normalizes a missing setting to null. A runtime value wins;
  // only a runtime miss consults the documented raw environment fallback.
  // Explicit strings (including "") from either source validate below.
  const raw = runtimeValue ?? env[key];
  if (raw == null) return undefined;

  const valid =
    (typeof raw === "number" && Number.isSafeInteger(raw)) ||
    (typeof raw === "string" && /^(?:0|[1-9]\d*)$/.test(raw));
  const value =
    typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  if (!valid || !Number.isSafeInteger(value) || value < min || value > max) {
    return {
      error: `${key} must be a canonical decimal integer between ${min} and ${max}.`,
    };
  }

  return { value };
}
