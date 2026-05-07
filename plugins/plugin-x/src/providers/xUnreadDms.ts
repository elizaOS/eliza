import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { resolveXFeedAdapter } from "../actions/x-feed-adapter.js";

const DEFAULT_LIMIT = 20;

function providerText(value: unknown): string {
  return JSON.stringify({ x_unread_dms: value }, null, 2);
}

export const xUnreadDmsProvider: Provider = {
  name: "xUnreadDms",
  description: "Unread Twitter/X direct messages.",
  descriptionCompressed: "Unread X direct messages list.",
  dynamic: true,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const adapter = resolveXFeedAdapter(runtime);
    if (!adapter) {
      return { text: providerText({ status: "not_configured" }) };
    }

    try {
      const messages = await adapter.listDirectMessages({
        onlyUnread: true,
        limit: DEFAULT_LIMIT,
      });
      const unread = messages.filter((m) => !m.read);
      logger.info(
        {
          provider: "xUnreadDms",
          total: messages.length,
          unread: unread.length,
        },
        "[xUnreadDms] listed X DMs",
      );
      return {
        text: providerText({
          status: "ready",
          total: messages.length,
          unread: unread.length,
          messages: unread.map((m) => ({
            id: m.id,
            senderId: m.senderId,
            senderUsername: m.senderUsername ?? "",
            text: m.text,
            createdAt: m.createdAt ?? "",
          })),
        }),
        data: { messages: unread, total: messages.length },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { provider: "xUnreadDms", error: message },
        "[xUnreadDms] failed to list DMs",
      );
      return { text: providerText({ status: "error", error: message }) };
    }
  },
};
