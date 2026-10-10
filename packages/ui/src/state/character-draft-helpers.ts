/** Character action helpers — CRUD and draft management. */

import { ElizaError, tokenizeNameOccurrences } from "@elizaos/core/protocol";
import type { CharacterData } from "../api/client-types-config";

type MessageExampleGroup = {
  examples: Array<{
    name: string;
    content: { text: string; actions?: string[] };
  }>;
};

function extractLikelyJson(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (withoutFences.startsWith("{") || withoutFences.startsWith("[")) {
    return withoutFences;
  }

  const firstBracket = withoutFences.indexOf("[");
  const firstBrace = withoutFences.indexOf("{");
  const starts = [firstBracket, firstBrace].filter((index) => index >= 0);
  if (starts.length === 0) return withoutFences;

  const start = Math.min(...starts);
  const opener = withoutFences[start];
  const closer = opener === "[" ? "]" : "}";
  const end = withoutFences.lastIndexOf(closer);
  if (end <= start) return withoutFences;

  return withoutFences.slice(start, end + 1);
}

function normalizeSpeakerName(
  rawName: unknown,
  fallbackAgentName: string,
  options: { fallbackMissingSpeaker?: boolean } = {},
): string {
  const fallbackMissingSpeaker = options.fallbackMissingSpeaker ?? true;
  if (typeof rawName === "string" && rawName.trim()) {
    const trimmed = rawName.trim();
    const normalized = trimmed.toLowerCase();
    if (
      normalized === "assistant" ||
      normalized === "agent" ||
      normalized === "ai" ||
      normalized === "model" ||
      normalized === "{{agentname}}"
    ) {
      return fallbackAgentName;
    }
    if (
      normalized === "user" ||
      normalized === "human" ||
      normalized === "{{user}}" ||
      normalized === "customer"
    ) {
      return "{{user1}}";
    }
    return trimmed;
  }
  return fallbackMissingSpeaker ? fallbackAgentName : "";
}

function normalizeMessageText(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  return "";
}

function normalizeConversation(
  conversation: unknown,
  fallbackAgentName: string,
  options: { fallbackMissingSpeaker?: boolean } = {},
): MessageExampleGroup | null {
  const rawExamples = Array.isArray(conversation)
    ? conversation
    : conversation &&
        typeof conversation === "object" &&
        Array.isArray((conversation as { examples?: unknown[] }).examples)
      ? (conversation as { examples: unknown[] }).examples
      : null;

  if (!rawExamples) return null;

  const examples = rawExamples
    .map((message) => {
      const record =
        message && typeof message === "object"
          ? (message as Record<string, unknown>)
          : null;
      if (!record) return null;

      const content =
        record.content && typeof record.content === "object"
          ? (record.content as Record<string, unknown>)
          : null;
      const text = normalizeMessageText(
        content?.text ?? record.text ?? record.message ?? record.content,
      );
      if (!text) return null;
      const actions = content?.actions;
      if (
        actions !== undefined &&
        (!Array.isArray(actions) ||
          !actions.every((action) => typeof action === "string"))
      ) {
        throw new ElizaError(
          "Message example actions must be an array of strings.",
          { code: "INVALID_MESSAGE_EXAMPLE_ACTIONS" },
        );
      }

      return {
        name: normalizeSpeakerName(
          record.name ?? record.user ?? record.speaker ?? record.role,
          fallbackAgentName,
          options,
        ),
        content: { text, ...(actions === undefined ? {} : { actions }) },
      };
    })
    .filter((message): message is MessageExampleGroup["examples"][number] =>
      Boolean(message?.name && message.content.text),
    );

  if (examples.length === 0) return null;
  return { examples };
}

export function normalizeGeneratedMessageExamples(
  input: unknown,
  fallbackAgentName = "Agent",
  options: { fallbackMissingSpeaker?: boolean } = {},
): MessageExampleGroup[] {
  let parsed = input;

  if (typeof input === "string") {
    const candidate = extractLikelyJson(input);
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // error-policy:J3 model output that is not parseable JSON yields no
      // example groups; the editor keeps its current examples.
      return [];
    }
  }

  const source =
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { messageExamples?: unknown[] }).messageExamples)
      ? (parsed as { messageExamples: unknown[] }).messageExamples
      : parsed;

  if (!Array.isArray(source)) return [];

  const groups =
    source.length > 0 &&
    source.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as { examples?: unknown[] }).examples),
    )
      ? source
      : source.every((entry) => Array.isArray(entry))
        ? source
        : [source];

  return groups
    .map((group) => normalizeConversation(group, fallbackAgentName, options))
    .filter((group): group is MessageExampleGroup => Boolean(group));
}

export function prepareDraftForSave(
  draft: CharacterData,
  previousName?: string,
): Record<string, unknown> {
  // Only pick fields the API schema accepts (.strict() rejects unknown keys)
  const result: Record<string, unknown> = {};

  if (draft.name?.trim()) {
    result.name = draft.name.trim();
  }

  if (draft.username?.trim()) {
    result.username = draft.username.trim();
  } else if (typeof result.name === "string") {
    result.username = result.name;
  }

  // Build a tokenizer that replaces whole-word occurrences of the
  // current *and* previous agent name with `{{name}}`. Load-side expansion
  // (useCharacterState.loadCharacter → replaceNameTokens) renders them back
  // against whatever the current name is, so renames now propagate through
  // every free-text field without manual edits.
  //
  // Both names are tokenized so a rename within the same save pass also
  // catches old-name literals that the user didn't hand-edit.
  const currentName = typeof result.name === "string" ? result.name : "";
  const previousNameTrimmed = previousName?.trim() ?? "";
  const tokenize = (value: string): string => {
    let out = value;
    if (currentName) out = tokenizeNameOccurrences(out, currentName);
    if (previousNameTrimmed && previousNameTrimmed !== currentName) {
      out = tokenizeNameOccurrences(out, previousNameTrimmed);
    }
    return out;
  };

  // `PUT /api/character` keeps every omitted field, so a field the user
  // emptied must be sent as empty — omitting it would restore the old value.
  if (typeof draft.system === "string") {
    result.system = tokenize(draft.system);
  }

  if (typeof draft.bio === "string") {
    const lines = draft.bio
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0)
      .map(tokenize);
    result.bio = lines;
  } else if (Array.isArray(draft.bio)) {
    result.bio = draft.bio.map(tokenize);
  }

  if (Array.isArray(draft.adjectives)) {
    result.adjectives = draft.adjectives.filter((s) => s.trim().length > 0);
  }

  if (Array.isArray(draft.topics)) {
    result.topics = draft.topics
      .filter((s) => s.trim().length > 0)
      .map(tokenize);
  }

  if (Array.isArray(draft.postExamples)) {
    result.postExamples = draft.postExamples
      .filter((s) => s.trim().length > 0)
      .map(tokenize);
  }

  if (draft.messageExamples != null) {
    // Strip extra fields from content (schema is .strict() — only text + actions allowed)
    const cleaned = normalizeGeneratedMessageExamples(
      draft.messageExamples,
      draft.name?.trim() || "Agent",
      { fallbackMissingSpeaker: false },
    ).map((group) => ({
      examples: group.examples.map((msg) => ({
        name: msg.name,
        content: { ...msg.content, text: tokenize(msg.content.text) },
      })),
    }));
    if (
      cleaned.length > 0 ||
      (Array.isArray(draft.messageExamples) &&
        draft.messageExamples.length === 0)
    ) {
      result.messageExamples = cleaned;
    }
  }

  if (draft.style) {
    const style: Record<string, string[]> = {};
    if (Array.isArray(draft.style.all)) {
      style.all = draft.style.all.map(tokenize);
    }
    if (Array.isArray(draft.style.chat)) {
      style.chat = draft.style.chat.map(tokenize);
    }
    if (Array.isArray(draft.style.post)) {
      style.post = draft.style.post.map(tokenize);
    }
    if (Object.keys(style).length > 0) result.style = style;
  }

  return result;
}

export function parseMessageExamplesInput(value: string): Array<{
  examples: Array<{
    name: string;
    content: { text: string; actions?: string[] };
  }>;
}> {
  if (!value.trim()) return [];
  const blocks = value.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  return blocks.map((block) => {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    const examples = lines.map((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        return {
          name: line.slice(0, colonIdx).trim(),
          content: { text: line.slice(colonIdx + 1).trim() },
        };
      }
      return { name: "User", content: { text: line.trim() } };
    });
    return { examples };
  });
}

export function parseArrayInput(value: string): string[] {
  return value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
