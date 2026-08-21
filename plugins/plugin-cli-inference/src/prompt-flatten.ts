import { types as nodeUtilTypes } from "node:util";
import type { ChatMessage, ChatMessageContentPart } from "@elizaos/core";

/**
 * Flatten `GenerateTextParams` (system + messages/prompt) into the two strings
 * the sanctioned CLIs consume:
 *
 *   - `system`  → claude system-prompt file (full replace) / codex top instructions block.
 *   - `body`    → claude/codex stdin prompt file.
 *
 * HARD REQ: both `params.system` AND `params.messages`/`params.prompt` must be
 * forwarded. Dropping `messages` would strip skills/memory/recent-conversation/
 * the `<response>` grammar that the runtime composes into the message array, so
 * the model would answer blind. System/developer-role messages are re-routed to
 * the system slot (joined with an explicit `params.system`); every other role is
 * flattened, in order, into the body. Nothing is dropped.
 */

export interface FlattenedPrompt {
  /** Goes to Claude's system-prompt file / Codex's instructions block. */
  system: string;
  /** Goes to claude `-p` / codex `exec` positional prompt. */
  body: string;
}

/** Explicit failure for a payload that cannot be represented losslessly. */
export class PromptPayloadSerializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PromptPayloadSerializationError";
  }
}

interface PayloadTraversal {
  /** Path-local, not visit-global: honest DAGs serialize every occurrence. */
  ancestors: Set<object>;
}

function newPayloadTraversal(): PayloadTraversal {
  return { ancestors: new Set<object>() };
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

/** Reject direct or prototype-chain Proxies before reflective projection. */
function hasProxyInPrototypeChain(value: object): boolean {
  let current: object | null = value;
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "length"
)?.get;

/** Read Buffer width without consulting an overridable own `length`. */
function bufferLength(value: Uint8Array): number {
  if (!typedArrayLengthGetter) {
    throw new PromptPayloadSerializationError("TypedArray length getter is unavailable");
  }
  return typedArrayLengthGetter.call(value) as number;
}

/** Copy Buffer bytes without consulting the payload's `@@iterator`. */
function bufferBytes(value: Uint8Array, length: number): number[] {
  const bytes = new Array<number>(length);
  for (let index = 0; index < length; index += 1) bytes[index] = value[index];
  return bytes;
}

type JsonSafe = string | number | boolean | null | JsonSafe[] | { [key: string]: JsonSafe };

function dateProjection(value: object): { matched: boolean; value: string | null } {
  try {
    const time = Date.prototype.getTime.call(value);
    return {
      matched: true,
      value: Number.isNaN(time) ? null : Date.prototype.toISOString.call(value),
    };
  } catch {
    return { matched: false, value: null };
  }
}

function urlProjection(value: object): { matched: boolean; value: string } {
  try {
    return { matched: true, value: URL.prototype.toString.call(value) };
  } catch {
    return { matched: false, value: "" };
  }
}

/**
 * Descriptor-only projection to a JSON-safe value. Every representable value is
 * preserved. Cycles and accessors are rejected explicitly because invoking
 * attacker-controlled code or inventing an omission marker would both violate
 * the model-input contract.
 */
function toJsonValue(value: unknown, traversal: PayloadTraversal): JsonSafe | undefined {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string") return value as string;
  if (kind === "number") return Number.isFinite(value as number) ? (value as number) : null;
  if (kind === "boolean") return value as boolean;
  if (kind === "bigint") return (value as bigint).toString();
  if (kind !== "object") return undefined; // undefined / function / symbol: dropped, as today
  const object = value as object;
  if (hasProxyInPrototypeChain(object)) {
    throw new PromptPayloadSerializationError(
      "Tool payload contains a Proxy and cannot be read safely"
    );
  }
  // Brand check, not `instanceof`: a Date from another realm fails the
  // prototype test and used to fall through to the object branch, rendering
  // `{}` and losing the timestamp entirely. Dispatch through the builtins so an
  // attacker-supplied `getTime` / `toISOString` override on a Date-shaped
  // payload can neither run nor throw out of prompt flattening — the same
  // reason core's `flattenTextValues` uses `Date.prototype.getTime.call`.
  const date = dateProjection(object);
  if (date.matched) return date.value;
  // Buffer and URL both serialize to `{}` or an index map through the generic
  // object branch, dropping the bytes / the href. Reproduce what the
  // original `JSON.stringify` path produced for each.
  if (isBufferValue(object)) {
    const buffer = object as Uint8Array;
    const length = bufferLength(buffer);
    return { type: "Buffer", data: bufferBytes(buffer, length) };
  }
  const url = urlProjection(object);
  if (url.matched) return url.value;
  if (traversal.ancestors.has(object)) {
    throw new PromptPayloadSerializationError(
      "Tool payload contains a cycle and cannot be sent to the model losslessly"
    );
  }
  if (Array.isArray(object)) {
    traversal.ancestors.add(object);
    try {
      const items: JsonSafe[] = [];
      for (let index = 0; index < object.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (descriptor && !("value" in descriptor)) {
          throw new PromptPayloadSerializationError(
            `Tool payload array element ${index} is an accessor and cannot be read safely`
          );
        }
        items.push(toJsonValue(descriptor?.value, traversal) ?? null);
      }
      return items;
    } finally {
      traversal.ancestors.delete(object);
    }
  }
  // Own enumerable string keys, in insertion order — the exact set and order
  // `JSON.stringify` would serialize, read without invoking anything.
  const keys = Object.keys(object);
  traversal.ancestors.add(object);
  try {
    // Null-prototype staging: on a plain `{}` an assignment of a
    // `JSON.parse`-produced own `"__proto__"` key hits the `Object.prototype`
    // setter and the member vanishes silently. With no prototype there is no
    // setter to hit, so the key lands as an own data property.
    const projected = Object.create(null) as Record<string, JsonSafe>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new PromptPayloadSerializationError(
          `Tool payload property ${JSON.stringify(key)} is an accessor and cannot be read safely`
        );
      }
      const nested = toJsonValue(descriptor.value, traversal);
      if (nested === undefined) continue;
      projected[key] = nested;
    }
    return projected;
  } finally {
    traversal.ancestors.delete(object);
  }
}

/** Serialize every safe tool-payload value or fail before model dispatch. */
function stringifyToolPayload(value: unknown): string {
  try {
    const projected = toJsonValue(value, newPayloadTraversal());
    if (projected === undefined) return "";
    return JSON.stringify(projected) ?? "";
  } catch (error) {
    if (error instanceof PromptPayloadSerializationError) throw error;
    throw new PromptPayloadSerializationError(
      "Tool payload could not be serialized completely for model input",
      { cause: error }
    );
  }
}

/** Pull readable text out of a tool-result part's `output` (shape varies by
 * provider: `{type:"text",value}`, a bare string, or an array of such parts).
 * The payload is untrusted remote data, so unsafe shapes fail explicitly. */
function toolOutputToText(
  output: unknown,
  traversal: PayloadTraversal = newPayloadTraversal()
): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output !== "object") return String(output);
  if (hasProxyInPrototypeChain(output)) {
    throw new PromptPayloadSerializationError("Tool output contains a Proxy and cannot be read safely");
  }
  if (traversal.ancestors.has(output)) {
    throw new PromptPayloadSerializationError(
      "Tool output contains a cycle and cannot be sent to the model losslessly"
    );
  }
  if (Array.isArray(output)) {
    traversal.ancestors.add(output);
    try {
      const parts: string[] = [];
      for (let index = 0; index < output.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(output, String(index));
        if (descriptor && !("value" in descriptor)) {
          throw new PromptPayloadSerializationError(
            `Tool output array element ${index} is an accessor and cannot be read safely`
          );
        }
        const text = toolOutputToText(descriptor?.value, traversal);
        if (text) parts.push(text);
      }
      return parts.join("\n");
    } finally {
      traversal.ancestors.delete(output);
    }
  }
  traversal.ancestors.add(output);
  try {
    const value = ownDataProperty(output, "value");
    if (typeof value === "string") return value;
    const text = ownDataProperty(output, "text");
    if (typeof text === "string") return text;
    const content = ownDataProperty(output, "content");
    if (content != null) return toolOutputToText(content, traversal);
  } finally {
    traversal.ancestors.delete(output);
  }
  // Terminal serialization runs AFTER `output` leaves the ancestor path, so the
  // projection below treats it as a fresh root rather than as a back-edge onto
  // itself. This is exactly what "path-local" buys: an honest value is never
  // mistaken for a cycle.
  return stringifyToolPayload(output);
}

function serializeToolOutput(output: unknown): string {
  try {
    return toolOutputToText(output);
  } catch (error) {
    if (error instanceof PromptPayloadSerializationError) throw error;
    throw new PromptPayloadSerializationError(
      "Tool output could not be serialized completely for model input",
      { cause: error }
    );
  }
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
        const args = typeof p.input === "string" ? p.input : stringifyToolPayload(p.input ?? {});
        return `[tool_call ${p.toolName ?? "tool"} ${args}]`;
      }
      if (p.type === "tool-result" || p.type === "tool_result") {
        const out = serializeToolOutput(p.output);
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
              : stringifyToolPayload(call.arguments ?? {});
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
