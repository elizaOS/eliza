import { stripAssistantStageDirections } from "@elizaos/shared";
import type { ConversationMessage } from "../api/client-types-chat";

const MAX_DISPLAY_LEN = 200_000;
const HIDDEN_TAG_BLOCK_RE =
  /<(think|analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;
const TRAILING_PARTIAL_TAG_RE = /<\/?[a-zA-Z][^>]*$|<\/?$/s;
const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasOnlyKnownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBareEvaluatorDecision(value: Record<string, unknown>): boolean {
  const decision =
    typeof value.decision === "string" ? value.decision.toUpperCase() : "";
  return (
    typeof value.success === "boolean" &&
    ["CONTINUE", "FINISH", "RETRY", "STOP"].includes(decision) &&
    hasOnlyKnownKeys(value, ["success", "decision"])
  );
}

function isInternalJsonArtifact(
  value: unknown,
  options?: { allowBareEvaluatorDecision?: boolean },
): boolean {
  if (!isRecord(value)) return false;

  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (
    [
      "evaluation",
      "tool_call",
      "tool-call",
      "tool_result",
      "tool-result",
      "llm_call",
      "llm-call",
    ].includes(type)
  ) {
    return true;
  }

  if (
    "factMemory" in value &&
    "relationships" in value &&
    "identities" in value &&
    "success" in value
  ) {
    return true;
  }

  const decision =
    typeof value.decision === "string" ? value.decision.toUpperCase() : "";
  if (
    typeof value.success === "boolean" &&
    ["CONTINUE", "FINISH", "RETRY", "STOP"].includes(decision) &&
    (typeof value.thought === "string" ||
      "raw" in value ||
      (options?.allowBareEvaluatorDecision && isBareEvaluatorDecision(value)))
  ) {
    return true;
  }

  if ("toolCallId" in value || "toolCall" in value || "evaluation" in value) {
    return true;
  }

  if (
    typeof value.action === "string" &&
    isRecord(value.parameters) &&
    hasOnlyKnownKeys(value, ["action", "parameters"])
  ) {
    return true;
  }

  return false;
}

function findBalancedJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }

  return -1;
}

function stripInternalJsonObjects(text: string): string {
  let output = "";
  let index = 0;
  let previousRemovalWasInternal = false;

  while (index < text.length) {
    const next = text.indexOf("{", index);
    if (next === -1) {
      output += text.slice(index);
      break;
    }

    const between = text.slice(index, next);
    output += between;
    const end = findBalancedJsonEnd(text, next);
    if (end === -1) {
      output += text.slice(next);
      break;
    }

    const raw = text.slice(next, end);
    const parsed = parseJson(raw);
    const allowBareEvaluatorDecision =
      previousRemovalWasInternal && between.trim().length === 0;
    if (isInternalJsonArtifact(parsed, { allowBareEvaluatorDecision })) {
      output += " ";
      previousRemovalWasInternal = true;
    } else {
      output += raw;
      previousRemovalWasInternal = false;
    }
    index = end;
  }

  return output;
}

function stripInternalFencedJson(text: string): string {
  FENCED_JSON_RE.lastIndex = 0;
  return text.replace(FENCED_JSON_RE, (match, json: string) => {
    const parsed = parseJson(json.trim());
    return isInternalJsonArtifact(parsed) ? " " : match;
  });
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeAssistantDisplayText(text: string): string {
  let normalized =
    text.length > MAX_DISPLAY_LEN ? text.slice(0, MAX_DISPLAY_LEN) : text;

  normalized = normalized.replace(HIDDEN_TAG_BLOCK_RE, " ");
  normalized = normalized.replace(TRAILING_PARTIAL_TAG_RE, "");
  normalized = stripInternalFencedJson(normalized);
  normalized = stripInternalJsonObjects(normalized);
  normalized = stripAssistantStageDirections(normalized);
  return normalizeWhitespace(normalized);
}

export function shouldDisplayConversationMessage(
  message: ConversationMessage,
): boolean {
  if (message.role !== "assistant") return true;
  if (sanitizeAssistantDisplayText(message.text).length > 0) return true;
  return Boolean(message.blocks?.length);
}

export function filterRenderableConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.filter((message) =>
    shouldDisplayConversationMessage(message),
  );
}
