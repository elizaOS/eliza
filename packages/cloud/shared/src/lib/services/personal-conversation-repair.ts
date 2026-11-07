import type { SharedTurnMessage } from "./shared-runtime/run-shared-agent-turn";

type CanonicalMessage = {
  sourceId: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
};

/** Repair only from the complete selected source; an empty import cannot replace failed history. */
export async function repairPersonalConversation(
  history: SharedTurnMessage[],
  importConversation: (messages: CanonicalMessage[]) => Promise<{ complete: true } | null>,
): Promise<boolean> {
  const messages: CanonicalMessage[] = [];
  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!message.id) return false;
    messages.push({
      sourceId: message.id,
      role: message.role,
      text: message.content,
      ...(typeof message.createdAt === "number" ? { timestamp: message.createdAt } : {}),
    });
  }
  return Boolean(await importConversation(messages));
}
