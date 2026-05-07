/**
 * Google Chat spaces provider — JSON-encoded list of spaces the bot is in.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { validateActionKeywords, validateActionRegex } from "@elizaos/core";
import type { GoogleChatService } from "../service.js";
import { GOOGLE_CHAT_SERVICE_NAME, getSpaceDisplayName, isDirectMessage } from "../types.js";

const RELEVANCE_KEYWORDS = ["google", "chat", "space", "spaces", "room", "rooms"] as const;
const RELEVANCE_REGEX = /\b(?:google|chat|spaces?|rooms?)\b/i;

interface GoogleChatSpaceEntry {
  name: string;
  displayName: string;
  type: string;
  threaded: boolean;
}

export const googleChatSpacesProvider: Provider = {
  name: "googleChatSpaces",
  description:
    "Lists Google Chat spaces the bot is a member of with display name, type, and threaded flag.",
  descriptionCompressed: "Google Chat spaces (display name, type, threaded).",
  dynamic: true,
  contexts: ["social", "connectors"],
  relevanceKeywords: [...RELEVANCE_KEYWORDS],
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    const recentMessages = (state?.recentMessagesData as Memory[] | undefined) ?? [];
    const isRelevant =
      validateActionKeywords(message, recentMessages, [...RELEVANCE_KEYWORDS]) ||
      validateActionRegex(message, recentMessages, RELEVANCE_REGEX);
    if (!isRelevant) {
      return { text: "" };
    }

    if (message.content.source !== "google-chat") {
      return { data: {}, values: {}, text: "" };
    }

    const service = runtime.getService<GoogleChatService>(GOOGLE_CHAT_SERVICE_NAME);
    if (!service?.isConnected()) {
      return { data: {}, values: {}, text: "" };
    }

    const spaces = await service.getSpaces();
    const entries: GoogleChatSpaceEntry[] = spaces.map((s) => ({
      name: s.name,
      displayName: getSpaceDisplayName(s),
      type: isDirectMessage(s) ? "DM" : s.type || "SPACE",
      threaded: Boolean(s.threaded),
    }));

    return {
      data: {
        spaceCount: entries.length,
        spaces: entries,
      },
      values: {
        spaceCount: entries.length,
      },
      text: JSON.stringify({
        google_chat_spaces: {
          count: entries.length,
          items: entries,
        },
      }),
    };
  },
};

export default googleChatSpacesProvider;
