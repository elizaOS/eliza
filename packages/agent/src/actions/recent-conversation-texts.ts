import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { getRecentMessagesData } from "@elizaos/shared";

const STATE_SPEAKER_PREFIX_RE =
  /^[a-zA-Z\u00C0-\u024F\u0400-\u04FF\u3000-\u9FFF]{1,20}\s*:\s*/;

function normalizeConversationLine(value: string): string {
  return value.replace(STATE_SPEAKER_PREFIX_RE, "").trim();
}

function splitConversationText(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) => normalizeConversationLine(line))
    .filter((line) => line.length > 0);
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

export function recentConversationTextsFromState(
  state: State | undefined,
  limit = 6,
): string[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const stateRecord = state as Record<string, unknown>;
  const values =
    stateRecord.values && typeof stateRecord.values === "object"
      ? (stateRecord.values as Record<string, unknown>)
      : undefined;

  const collected: string[] = [];
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      collected.push(...splitConversationText(value));
    }
  };

  pushText(values?.recentMessages);
  pushText(stateRecord.text);

  for (const item of getRecentMessagesData(state)) {
    const content = item.content;
    if (!content || typeof content !== "object") {
      continue;
    }
    pushText(content.text);
  }

  return dedupePreservingOrder(collected.slice(-Math.max(1, limit)));
}

export async function recentConversationTexts(args: {
  runtime: IAgentRuntime;
  message?: Memory;
  state: State | undefined;
  limit?: number;
}): Promise<string[]> {
  const limit = Math.max(1, args.limit ?? 6);
  const stateTexts = recentConversationTextsFromState(args.state, limit);
  const roomId =
    typeof args.message?.roomId === "string" ? args.message.roomId : "";

  if (
    stateTexts.length >= limit ||
    !roomId ||
    typeof args.runtime.getMemories !== "function"
  ) {
    return stateTexts;
  }

  try {
    const memories = await args.runtime.getMemories({
      roomId,
      tableName: "messages",
      limit,
    });
    const memoryTexts = Array.isArray(memories)
      ? memories
          .map((memory) =>
            typeof memory?.content?.text === "string"
              ? normalizeConversationLine(memory.content.text)
              : "",
          )
          .filter((text) => text.length > 0)
      : [];
    return dedupePreservingOrder([...memoryTexts, ...stateTexts].slice(-limit));
  } catch {
    return stateTexts;
  }
}
