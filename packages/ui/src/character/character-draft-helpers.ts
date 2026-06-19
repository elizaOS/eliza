/** Character action helpers — CRUD and draft management. */

import type { CharacterData, ElizaClient } from "../api/client";
import { tokenizeNameOccurrences } from "../utils/name-tokens";

type MessageExampleGroup = {
  examples: Array<{ name: string; content: { text: string } }>;
};

export interface CharacterActionContext {
  client: ElizaClient;
  setCharacterData: (data: CharacterData | null) => void;
  setCharacterDraft: (
    fn: CharacterData | ((prev: CharacterData) => CharacterData),
  ) => void;
  setCharacterLoading: (loading: boolean) => void;
  setCharacterSaving: (saving: boolean) => void;
  setCharacterSaveError: (error: string | null) => void;
  setCharacterSaveSuccess: (message: string | null) => void;
}

export async function loadCharacter(
  ctx: CharacterActionContext,
): Promise<void> {
  ctx.setCharacterLoading(true);
  ctx.setCharacterSaveError(null);
  ctx.setCharacterSaveSuccess(null);
  try {
    const { character } = await ctx.client.getCharacter();
    ctx.setCharacterData(character);
    ctx.setCharacterDraft({
      name: character.name ?? "",
      username: character.username ?? "",
      bio: Array.isArray(character.bio)
        ? character.bio.join("\n")
        : (character.bio ?? ""),
      system: character.system ?? "",
      adjectives: character.adjectives ?? [],
      topics: character.topics ?? [],
      style: {
        all: character.style?.all ?? [],
        chat: character.style?.chat ?? [],
        post: character.style?.post ?? [],
      },
      messageExamples: character.messageExamples ?? [],
      postExamples: character.postExamples ?? [],
    });
  } catch {
    ctx.setCharacterData(null);
    ctx.setCharacterDraft({});
  }
  ctx.setCharacterLoading(false);
}

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

      return {
        name: normalizeSpeakerName(
          record.name ?? record.user ?? record.speaker ?? record.role,
          fallbackAgentName,
          options,
        ),
        content: { text },
      };
    })
    .filter((message): message is { name: string; content: { text: string } } =>
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

  if (draft.system) result.system = tokenize(draft.system);

  if (typeof draft.bio === "string") {
    const lines = draft.bio
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0)
      .map(tokenize);
    if (lines.length > 0) result.bio = lines;
  } else if (Array.isArray(draft.bio) && draft.bio.length > 0) {
    result.bio = draft.bio.map(tokenize);
  }

  const adjectives = (draft.adjectives ?? []).filter(
    (s) => s.trim().length > 0,
  );
  if (adjectives.length > 0) result.adjectives = adjectives;

  const topics = (draft.topics ?? [])
    .filter((s) => s.trim().length > 0)
    .map(tokenize);
  if (topics.length > 0) result.topics = topics;

  const postExamples = (draft.postExamples ?? [])
    .filter((s) => s.trim().length > 0)
    .map(tokenize);
  if (postExamples.length > 0) result.postExamples = postExamples;

  if (draft.messageExamples != null) {
    // Strip extra fields from content (schema is .strict() — only text + actions allowed)
    const cleaned = normalizeGeneratedMessageExamples(
      draft.messageExamples,
      draft.name?.trim() || "Agent",
      { fallbackMissingSpeaker: false },
    ).map((group, groupIndex) => ({
      examples: group.examples
        .map((msg) => {
          const originalGroup =
            Array.isArray(draft.messageExamples) &&
            draft.messageExamples[groupIndex] &&
            typeof draft.messageExamples[groupIndex] === "object"
              ? (draft.messageExamples[groupIndex] as {
                  examples?: Array<{
                    name?: string;
                    content?: { text?: string; actions?: string[] };
                  }>;
                })
              : null;
          const originalMessage = originalGroup?.examples?.find(
            (candidate) =>
              candidate?.name?.trim() === msg.name &&
              candidate?.content?.text?.trim() === msg.content.text,
          );
          return {
            name: msg.name.trim(),
            content: {
              text: tokenize(msg.content.text.trim()),
              ...(originalMessage?.content?.actions
                ? { actions: originalMessage.content.actions }
                : {}),
            },
          };
        })
        .filter((msg) => msg.name && msg.content.text),
    }));
    if (cleaned.length > 0) result.messageExamples = cleaned;
  }

  if (draft.style) {
    const style: Record<string, string[]> = {};
    if (draft.style.all?.length) style.all = draft.style.all.map(tokenize);
    if (draft.style.chat?.length) style.chat = draft.style.chat.map(tokenize);
    if (draft.style.post?.length) style.post = draft.style.post.map(tokenize);
    if (Object.keys(style).length > 0) result.style = style;
  }

  return result;
}

export function parseMessageExamplesInput(value: string): Array<{
  examples: Array<{ name: string; content: { text: string } }>;
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
