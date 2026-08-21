import type { ChatMessage, ChatMessageContentPart } from "@elizaos/core";

/**
 * Flatten `GenerateTextParams` (system + messages/prompt) into the two strings
 * the sanctioned CLIs consume:
 *
 *   - `system`  → claude `--system-prompt` (full replace) / codex top instructions block.
 *   - `body`    → claude `-p <body>` / codex `exec <body>` positional prompt.
 *
 * HARD REQ: both `params.system` AND `params.messages`/`params.prompt` must be
 * forwarded. Dropping `messages` would strip skills/memory/recent-conversation/
 * the `<response>` grammar that the runtime composes into the message array, so
 * the model would answer blind. System/developer-role messages are re-routed to
 * the system slot (joined with an explicit `params.system`); every other role is
 * flattened, in order, into the body. Nothing is dropped.
 */

export interface FlattenedPrompt {
  /** Goes to claude `--system-prompt` / codex instructions block. */
  system: string;
  /** Goes to claude `-p` / codex `exec` positional prompt. */
  body: string;
}

/**
 * Bounded-walk budget for untrusted tool payloads.
 *
 * A tool part's `output`/`input` is raw remote data — a WEB_FETCH body, an MCP
 * tool result, model-authored tool arguments. The walk below used to be
 * unbounded and unguarded, so a deep or cyclic payload threw `RangeError:
 * Maximum call stack size exceeded` (deep array, deep `.content` chain,
 * self-referential `.content`) or `TypeError: Converting circular structure to
 * JSON` straight out of `flattenPrompt`. Because the planner's message array
 * grows append-only across iterations
 * (`packages/core/src/runtime/planner-loop.ts` "grows append-only across
 * planner iterations"), every later CLI-backed generation that replays the turn
 * re-walks the same part and throws again — one poisoned tool result is a
 * persistent failure, not a single failed call.
 *
 * The contract mirrors core's own bounded flatten (`flattenTextValues` in
 * `packages/core/src/utils/text-normalize.ts`):
 *  - a depth ceiling far above any honest payload;
 *  - node and character ceilings, so a wide graph is bounded too, not just a
 *    deep one, with container width charged BEFORE any element is allocated;
 *  - a PATH-LOCAL ancestor set (added on descent, removed in `finally`), so a
 *    real back-edge is cut while an honest DAG — the same cached object
 *    referenced twice in one result — still flattens in full;
 *  - descriptor-only reflection, so no attacker-supplied getter or `toJSON`
 *    ever executes while we render a prompt;
 *  - an explicit in-band marker rather than a throw. Throwing would preserve
 *    the exact failure this guards against: one bad part bricking every later
 *    replay of the turn. The marker is visible to the model and in the
 *    transcript, so nothing is silently dropped.
 *
 * Nothing inside the budget changes shape: every payload the old walk accepted
 * still flattens to byte-identical text.
 */
const MAX_TOOL_PAYLOAD_DEPTH = 64;
const MAX_TOOL_PAYLOAD_NODES = 100_000;
const MAX_TOOL_PAYLOAD_CHARS = 4 * 1024 * 1024;

/** Emitted in place of a subtree that is deeper than the ceiling. */
export const TOOL_PAYLOAD_DEPTH_MARKER = `[tool payload omitted: deeper than ${MAX_TOOL_PAYLOAD_DEPTH}]`;
/** Emitted in place of a back-edge (a value that is its own ancestor). */
export const TOOL_PAYLOAD_CYCLE_MARKER = "[tool payload omitted: cycle]";
/** Emitted once the node or character budget for one part is spent. */
export const TOOL_PAYLOAD_BUDGET_MARKER = "[tool payload omitted: over budget]";

interface PayloadBudget {
  nodes: number;
  chars: number;
  /** Path-local, NOT visit-global: honest DAGs keep flattening in full. */
  ancestors: Set<object>;
}

/** One budget per tool part, so a large part never starves its siblings. */
function newPayloadBudget(): PayloadBudget {
  return { nodes: 0, chars: 0, ancestors: new Set<object>() };
}

/**
 * Charge produced text against the character budget. The check runs before the
 * charge, so the first (possibly very large) string always comes back whole —
 * a single 10 MB WEB_FETCH body flattens exactly as it does today.
 */
function chargeChars(budget: PayloadBudget, text: string): string {
  if (budget.chars > MAX_TOOL_PAYLOAD_CHARS) return TOOL_PAYLOAD_BUDGET_MARKER;
  budget.chars += text.length;
  return text;
}

/**
 * Charge a property name against the character budget. Nested *values* are
 * charged as they are projected, but the serialized output also carries every
 * key, and #23891 removed the terminal charge that used to account for them —
 * so without this a payload made of megabyte-sized keys is free forever.
 * Same check-before-charge rule as `chargeChars`; false means the container
 * must collapse to the budget marker.
 */
function chargeKeyChars(budget: PayloadBudget, key: string): boolean {
  if (budget.chars > MAX_TOOL_PAYLOAD_CHARS) return false;
  budget.chars += key.length;
  return true;
}

/** Charge container width before allocating anything for its elements. */
function chargeWidth(budget: PayloadBudget, width: number): boolean {
  budget.nodes += width;
  return budget.nodes <= MAX_TOOL_PAYLOAD_NODES;
}

/** Realm-independent brand, read without invoking anything on the value. */
function brandOf(value: object): string {
  return Object.prototype.toString.call(value);
}

/** Buffer/Uint8Array brand check that does not depend on a `Buffer` global. */
function isBufferValue(value: object): boolean {
  return (
    typeof Buffer !== "undefined" && typeof Buffer.isBuffer === "function" && Buffer.isBuffer(value)
  );
}

/**
 * Own data property, or `undefined`. Accessors are reported as absent and are
 * never invoked — an attacker-supplied getter must not run during prompt
 * flattening. Inherited members are not consulted; every producer of these
 * shapes (`JSON.parse`, object literals in the provider normalizers) emits own
 * data properties.
 */
function ownDataProperty(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

type JsonSafe = string | number | boolean | null | JsonSafe[] | { [key: string]: JsonSafe };

/**
 * Bounded, descriptor-only projection to a JSON-safe value. Structurally
 * identical to the input for anything within budget — same keys, same insertion
 * order, same scalar rendering as `JSON.stringify` — so serializing the result
 * is byte-identical to serializing the original. Cycles, over-deep subtrees and
 * over-budget graphs become markers instead of throwing, and `bigint` becomes
 * its decimal string instead of throwing `TypeError`.
 */
function toBoundedJsonValue(
  value: unknown,
  budget: PayloadBudget,
  depth: number
): JsonSafe | undefined {
  if (value === null) return null;
  const kind = typeof value;
  // Charge nested strings too. `toolOutputToText` charges the strings it
  // produces, but the JSON projection used to hand back every string free, so
  // an object could carry unlimited 3 MiB fields past a 4 MiB declared cap
  // while the node budget saw only one node per field. The pre-charge check in
  // `chargeChars` still lets the first oversized body through unchanged.
  if (kind === "string") return chargeChars(budget, value as string);
  if (kind === "number") return Number.isFinite(value as number) ? (value as number) : null;
  if (kind === "boolean") return value as boolean;
  if (kind === "bigint") return (value as bigint).toString();
  if (kind !== "object") return undefined; // undefined / function / symbol: dropped, as today
  const object = value as object;
  // Brand check, not `instanceof`: a Date from another realm fails the
  // prototype test and used to fall through to the object branch, rendering
  // `{}` and losing the timestamp entirely. Dispatch through the builtins so an
  // attacker-supplied `getTime` / `toISOString` override on a Date-shaped
  // payload can neither run nor throw out of prompt flattening — the same
  // reason core's `flattenTextValues` uses `Date.prototype.getTime.call`.
  if (brandOf(object) === "[object Date]") {
    const time = Date.prototype.getTime.call(object as Date);
    return Number.isNaN(time) ? null : Date.prototype.toISOString.call(object as Date);
  }
  // Buffer and URL both serialize to `{}` or an index map through the generic
  // object branch, dropping the bytes / the href. Reproduce what the
  // pre-bounded `JSON.stringify` path produced for each.
  if (isBufferValue(object)) {
    // Charge the byte count before materializing: the generic object branch
    // used to charge one node per index key, so skipping straight to
    // `Array.from` would let a multi-megabyte buffer through the node bound.
    const bytes = object as Uint8Array;
    if (!chargeWidth(budget, bytes.length)) return TOOL_PAYLOAD_BUDGET_MARKER;
    return { type: "Buffer", data: Array.from(bytes) };
  }
  if (brandOf(object) === "[object URL]" || object instanceof URL) {
    return String(URL.prototype.toString.call(object as URL));
  }
  if (depth >= MAX_TOOL_PAYLOAD_DEPTH) return TOOL_PAYLOAD_DEPTH_MARKER;
  if (budget.ancestors.has(object)) return TOOL_PAYLOAD_CYCLE_MARKER;
  if (Array.isArray(object)) {
    if (!chargeWidth(budget, object.length)) return TOOL_PAYLOAD_BUDGET_MARKER;
    budget.ancestors.add(object);
    try {
      const items: JsonSafe[] = [];
      for (let index = 0; index < object.length; index += 1) {
        items.push(toBoundedJsonValue(object[index], budget, depth + 1) ?? null);
      }
      return items;
    } finally {
      budget.ancestors.delete(object);
    }
  }
  // Own enumerable string keys, in insertion order — the exact set and order
  // `JSON.stringify` would serialize, read without invoking anything.
  const keys = Object.keys(object);
  if (!chargeWidth(budget, keys.length)) return TOOL_PAYLOAD_BUDGET_MARKER;
  budget.ancestors.add(object);
  try {
    // Null-prototype staging: on a plain `{}` an assignment of a
    // `JSON.parse`-produced own `"__proto__"` key hits the `Object.prototype`
    // setter and the member vanishes with no marker — silent truncation, which
    // is exactly what the markers exist to prevent. With no prototype there is
    // no setter to hit, so the key lands as an own data property.
    const projected = Object.create(null) as Record<string, JsonSafe>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor)) continue;
      if (!chargeKeyChars(budget, key)) return TOOL_PAYLOAD_BUDGET_MARKER;
      const nested = toBoundedJsonValue(descriptor.value, budget, depth + 1);
      if (nested === undefined) continue;
      projected[key] = nested;
    }
    return projected;
  } finally {
    budget.ancestors.delete(object);
  }
}

/** `JSON.stringify` for untrusted tool payloads: bounded and fail-closed. */
function stringifyToolPayload(value: unknown, budget: PayloadBudget, depth: number): string {
  const bounded = toBoundedJsonValue(value, budget, depth);
  if (bounded === undefined) return "";
  return JSON.stringify(bounded) ?? "";
}

/** Pull readable text out of a tool-result part's `output` (shape varies by
 * provider: `{type:"text",value}`, a bare string, or an array of such parts).
 * Bounded per {@link newPayloadBudget}: the payload is untrusted remote data. */
function toolOutputToText(
  output: unknown,
  budget: PayloadBudget = newPayloadBudget(),
  depth = 0
): string {
  if (output == null) return "";
  if (typeof output === "string") return chargeChars(budget, output);
  if (typeof output !== "object") return chargeChars(budget, String(output));
  if (depth >= MAX_TOOL_PAYLOAD_DEPTH) return TOOL_PAYLOAD_DEPTH_MARKER;
  if (budget.ancestors.has(output)) return TOOL_PAYLOAD_CYCLE_MARKER;
  if (Array.isArray(output)) {
    if (!chargeWidth(budget, output.length)) return TOOL_PAYLOAD_BUDGET_MARKER;
    budget.ancestors.add(output);
    try {
      const parts: string[] = [];
      for (let index = 0; index < output.length; index += 1) {
        const text = toolOutputToText(output[index], budget, depth + 1);
        if (text) parts.push(text);
      }
      return parts.join("\n");
    } finally {
      budget.ancestors.delete(output);
    }
  }
  if (!chargeWidth(budget, 1)) return TOOL_PAYLOAD_BUDGET_MARKER;
  budget.ancestors.add(output);
  try {
    const value = ownDataProperty(output, "value");
    if (typeof value === "string") return chargeChars(budget, value);
    const text = ownDataProperty(output, "text");
    if (typeof text === "string") return chargeChars(budget, text);
    const content = ownDataProperty(output, "content");
    if (content != null) return toolOutputToText(content, budget, depth + 1);
  } finally {
    budget.ancestors.delete(output);
  }
  // Terminal serialization runs AFTER `output` leaves the ancestor path, so the
  // projection below treats it as a fresh root rather than as a back-edge onto
  // itself. This is exactly what "path-local" buys: an honest value is never
  // mistaken for a cycle.
  // The projection already charged every string it kept, so charging the
  // serialized result again would double-count a single large body and turn it
  // into the over-budget marker — the opposite of the documented "first
  // oversized body comes back whole" contract that the bare-string path at the
  // top of this function still honors.
  return stringifyToolPayload(output, budget, depth);
}

/**
 * Flatten a message's content into text, surfacing tool-call / tool-result parts
 * (not just plain text). Canonical implementation — the clean-routing planner
 * imports this so the two paths can't drift (a divergent copy that dropped tool
 * results once caused the planner to hallucinate live-info answers).
 */
export function contentToText(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: ChatMessageContentPart) => {
      // Plain text part.
      if (part.type === "text" && typeof part.text === "string") return part.text;
      // Tool call / result carried INSIDE the content array (not on
      // `message.toolCalls`). Eliza threads WEB_FETCH/etc. call+result this way;
      // dropping them (the old behavior) blinded the SDK synthesis to every tool
      // output, so the model fell back to its prior and hallucinated. Surface
      // both so the flattened transcript carries the actual fetched data.
      const p = part as {
        type?: string;
        toolName?: string;
        input?: unknown;
        output?: unknown;
      };
      if (p.type === "tool-call" || p.type === "tool_call") {
        const args =
          typeof p.input === "string"
            ? p.input
            : stringifyToolPayload(p.input ?? {}, newPayloadBudget(), 0);
        return `[tool_call ${p.toolName ?? "tool"} ${args}]`;
      }
      if (p.type === "tool-result" || p.type === "tool_result") {
        const out = toolOutputToText(p.output);
        return out ? `[tool_result ${p.toolName ?? "tool"}: ${out}]` : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Render one non-system message as a labeled transcript block. */
function renderMessage(message: ChatMessage): string {
  const text = contentToText(message.content);
  // Surface assistant tool calls so a multi-turn transcript keeps the call/
  // result pairing visible to the CLI model (it has no native tool-call slot
  // here — everything is flattened text).
  const toolCallLines =
    message.role === "assistant" && message.toolCalls?.length
      ? message.toolCalls.map((call) => {
          const args =
            typeof call.arguments === "string"
              ? call.arguments
              : stringifyToolPayload(call.arguments ?? {}, newPayloadBudget(), 0);
          return `[tool_call ${call.name} ${args}]`;
        })
      : [];

  const label =
    message.role === "assistant" ? "Assistant" : message.role === "tool" ? "Tool result" : "User";

  const lines = [text, ...toolCallLines].filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  return `${label}: ${lines.join("\n")}`;
}

export function flattenPrompt(params: {
  system?: string;
  prompt?: string;
  messages?: ChatMessage[];
}): FlattenedPrompt {
  const systemParts: string[] = [];
  if (params.system && params.system.trim().length > 0) {
    systemParts.push(params.system);
  }

  const bodyParts: string[] = [];
  let lastBodyText = "";

  for (const message of params.messages ?? []) {
    if (message.role === "system" || message.role === "developer") {
      const text = contentToText(message.content);
      if (text.trim().length > 0) systemParts.push(text);
      continue;
    }
    const rendered = renderMessage(message);
    if (rendered.length > 0) {
      bodyParts.push(rendered);
      lastBodyText = contentToText(message.content);
    }
  }

  // The legacy `prompt` string is appended only when it isn't already the tail
  // of the message transcript (callers that pass `messages` usually leave it
  // empty, but some still set both — avoid duplicating it).
  if (params.prompt && params.prompt.trim().length > 0 && params.prompt !== lastBodyText) {
    bodyParts.push(params.prompt);
  }

  return {
    system: systemParts.join("\n\n"),
    body: bodyParts.join("\n\n"),
  };
}
