/**
 * Extracts complete conversation values used to ground action replies from
 * provider state and room memories without splitting, trimming, or deduping them.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { getRecentMessagesData } from "@elizaos/shared";

export function recentConversationTextsFromState(
  state: State | undefined,
  /** @deprecated Complete state context is always returned. Retained for source compatibility. */
  _limit = 6,
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
    if (typeof value === "string") {
      collected.push(value);
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

  return collected;
}

export async function recentConversationTexts(args: {
  runtime: IAgentRuntime;
  message?: Memory;
  state: State | undefined;
  /** @deprecated Complete conversation context is always returned. Retained for source compatibility. */
  limit?: number;
}): Promise<string[]> {
  const stateTexts = recentConversationTextsFromState(args.state);
  const roomId =
    typeof args.message?.roomId === "string" ? args.message.roomId : "";

  if (!roomId || typeof args.runtime.getMemories !== "function") {
    return stateTexts;
  }

  const memories = await args.runtime.getMemories({
    roomId,
    tableName: "messages",
  });
  const memoryTexts = Array.isArray(memories)
    ? memories.flatMap((memory) =>
        memory.content && typeof memory.content.text === "string"
          ? [memory.content.text]
          : [],
      )
    : [];
  return [...memoryTexts, ...stateTexts];
}
