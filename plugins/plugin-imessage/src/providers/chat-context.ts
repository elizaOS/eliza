import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export const chatContextProvider: Provider = {
  name: "imessageChatContext",
  description: "Provides iMessage chat context for the current conversation.",
  descriptionCompressed: "Current iMessage chat handle, chat ID, type, and display name.",
  dynamic: true,
  contextGate: { anyOf: ["phone", "social", "connectors"] },
  cacheStable: false,
  cacheScope: "turn",
  contexts: ["phone", "social", "connectors"],

  get: async (_runtime: IAgentRuntime, message: Memory, state?: State): Promise<ProviderResult> => {
    const stateData = (state?.data ?? {}) as Record<string, unknown>;
    const metadata = (message.metadata ?? {}) as Record<string, unknown>;
    const imessageMetadata =
      metadata.imessage && typeof metadata.imessage === "object"
        ? (metadata.imessage as Record<string, unknown>)
        : {};

    const chatId = firstString(stateData.chatId, imessageMetadata.chatId);
    const handle = firstString(
      stateData.handle,
      metadata.imessageHandle,
      imessageMetadata.userId,
      imessageMetadata.id
    );
    const chatType = firstString(stateData.chatType, metadata.chatType);
    const displayName = firstString(
      stateData.displayName,
      metadata.imessageContactName,
      metadata.entityName,
      imessageMetadata.name
    );

    if (!chatId && !handle && !chatType && !displayName) {
      return {
        data: { available: false },
        values: {},
        text: "",
      };
    }

    const lines = [
      "Current iMessage chat context:",
      chatId ? `- Chat ID: ${chatId}` : null,
      handle ? `- Handle: ${handle}` : null,
      chatType ? `- Chat type: ${chatType}` : null,
      displayName ? `- Display name: ${displayName}` : null,
    ].filter((line): line is string => Boolean(line));

    return {
      data: {
        available: true,
        chatId,
        handle,
        chatType,
        displayName,
      },
      values: {
        chatId,
        handle,
        chatType,
        displayName,
      },
      text: lines.join("\n"),
    };
  },
};
