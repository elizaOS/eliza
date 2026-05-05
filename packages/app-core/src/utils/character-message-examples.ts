import type { Content, MessageExampleGroup } from "@elizaos/core";

type MessageRecord = {
  content?: Content | string;
  message?: string;
  name?: string;
  role?: string;
  speaker?: string;
  text?: string;
  user?: string;
};

interface NormalizeCharacterMessageExamplesOptions {
  fallbackMissingSpeaker?: boolean;
}

function extractLikelyJson(input: string): string {
  const safe = input.length > 200_000 ? input.slice(0, 200_000) : input;
  const trimmed = safe.trim();
  if (!trimmed) return trimmed;

  const withoutFences = trimmed
    .replace(/^```(?:json)?[ \t\r\n]{0,1024}/i, "")
    .replace(/[ \t\r\n]{0,1024}```$/i, "")
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
  options: NormalizeCharacterMessageExamplesOptions,
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

function normalizeConversation(
  conversation: unknown,
  fallbackAgentName: string,
  options: NormalizeCharacterMessageExamplesOptions,
): MessageExampleGroup | null {
  const rawExamples = Array.isArray(conversation)
    ? conversation
    : conversation &&
        typeof conversation === "object" &&
        "examples" in conversation &&
        Array.isArray(conversation.examples)
      ? conversation.examples
      : null;

  if (!rawExamples) return null;

  const examples: MessageExampleGroup["examples"] = [];
  for (const message of rawExamples) {
    const record =
      message && typeof message === "object"
        ? (message as MessageRecord)
        : null;
    if (!record) continue;

    const contentRecord =
      record.content && typeof record.content === "object"
        ? (record.content as Content)
        : null;
    const textSource =
      contentRecord?.text ?? record.text ?? record.message ?? record.content;
    const text = typeof textSource === "string" ? textSource.trim() : "";
    if (!text) continue;

    const actions = Array.isArray(contentRecord?.actions)
      ? contentRecord.actions.filter(
          (action): action is string =>
            typeof action === "string" && action.trim().length > 0,
        )
      : undefined;

    const name = normalizeSpeakerName(
      record.name ?? record.user ?? record.speaker ?? record.role,
      fallbackAgentName,
      options,
    );
    if (!name) continue;

    examples.push({
      name,
      content: {
        text,
        ...(actions && actions.length > 0 ? { actions } : {}),
      },
    });
  }

  if (examples.length === 0) return null;
  return { examples };
}

export function normalizeCharacterMessageExamples(
  input: unknown,
  fallbackAgentName = "Agent",
  options: NormalizeCharacterMessageExamplesOptions = {},
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
    "messageExamples" in parsed &&
    Array.isArray(parsed.messageExamples)
      ? parsed.messageExamples
      : parsed;

  if (!Array.isArray(source)) return [];

  const groups =
    source.length > 0 &&
    source.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        "examples" in entry &&
        Array.isArray(entry.examples),
    )
      ? source
      : source.every((entry) => Array.isArray(entry))
        ? source
        : [source];

  return groups
    .map((group) => normalizeConversation(group, fallbackAgentName, options))
    .filter((group): group is MessageExampleGroup => Boolean(group));
}
