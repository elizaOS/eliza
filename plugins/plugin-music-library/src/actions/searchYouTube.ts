import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { YouTubeSearchService } from "../services/youtubeSearch";

/**
 * Extract search query from message text
 * Handles various natural language patterns for searching
 */
const extractSearchQuery = (messageText: string): string | null => {
  if (!messageText) return null;

  // Patterns for search requests
  const patterns = [
    /(?:find|search|look up|get|show me)(?:\s+(?:the|a))?\s+(?:youtube|video|song|music)?\s*(?:link|url)?\s+for\s+(.+)/i,
    /(?:what's|what is|whats)\s+(?:the\s+)?(?:youtube|video|song)?\s*(?:link|url)?\s+for\s+(.+)/i,
    /(?:can you|could you|please)\s+(?:find|search|get|show me)\s+(?:the\s+)?(?:youtube|video|song)?\s*(?:link|url)?\s+(?:for\s+)?(.+)/i,
    /youtube\s+search\s+(?:for\s+)?(.+)/i,
    /search\s+youtube\s+(?:for\s+)?(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = messageText.match(pattern);
    if (match?.[1]) {
      const query = match[1].trim();
      // Require minimum 3 characters to avoid ambiguous searches
      if (query.length >= 3) {
        return query;
      }
    }
  }

  return null;
};

export const searchYouTube: Action = {
  name: "SEARCH_YOUTUBE",
  similes: [
    "FIND_YOUTUBE",
    "SEARCH_YOUTUBE_VIDEO",
    "FIND_SONG",
    "SEARCH_MUSIC",
    "GET_YOUTUBE_LINK",
    "LOOKUP_YOUTUBE",
  ],
  description:
    "Search YouTube for a song or video and return the link. Use this when a user asks to find or search for a YouTube video or song without providing a specific URL.",
  descriptionCompressed: "Search YouTube for song/video, return link.",
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    const messageText = message.content.text || "";
    const searchQuery = extractSearchQuery(messageText);
    return !!searchQuery;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const messageText = message.content.text || "";
    const searchQuery = extractSearchQuery(messageText);

    if (!searchQuery) {
      await callback({
        text: "I couldn't understand what you want me to search for. Please try asking like: 'Find the YouTube link for Surefire by Wilderado' (at least 3 characters)",
        source: message.content.source,
      });
      return { success: false, error: "Missing search query" };
    }

    try {
      const youtubeSearchService = runtime.getService(
        "youtubeSearch",
      ) as YouTubeSearchService | null;
      if (!youtubeSearchService) {
        throw new Error("YouTube search service is not available");
      }

      logger.debug(`Searching YouTube for: ${searchQuery}`);

      const searchResults = await youtubeSearchService.search(searchQuery, {
        limit: 5,
      });

      if (!searchResults || searchResults.length === 0) {
        await callback({
          text: `I couldn't find any YouTube videos for "${searchQuery}". Try rephrasing your search or being more specific.`,
          source: message.content.source,
        });
        return { success: false, error: "No YouTube results found" };
      }

      const topResult = searchResults[0];
      const url = topResult.url;
      const title = topResult.title;
      const channel = topResult.channel || "Unknown Channel";

      let responseText = `Found it. Here's "${title}" by ${channel}:\n${url}\n\n`;

      if (searchResults.length > 1) {
        responseText += "Other results:\n";
        for (let i = 1; i < Math.min(3, searchResults.length); i++) {
          const result = searchResults[i];
          const resultTitle = result.title;
          const resultChannel = result.channel || "Unknown";
          responseText += `${i + 1}. ${resultTitle} by ${resultChannel}\n   ${result.url}\n`;
        }
      }

      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: `Searched YouTube for: ${searchQuery}, found: ${title}`,
            actions: ["SEARCH_YOUTUBE"],
          },
          metadata: {
            type: "custom",
            actionName: "SEARCH_YOUTUBE",
            searchQuery,
            resultUrl: url,
            resultTitle: title,
            resultChannel: channel,
          },
        },
        "messages",
      );

      await callback({
        text: responseText,
        actions: ["SEARCH_YOUTUBE_RESPONSE"],
        source: message.content.source,
      });

      return {
        success: true,
        text: responseText,
        data: {
          searchQuery,
          resultUrl: url,
          resultTitle: title,
          resultChannel: channel,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Error searching YouTube:", errorMessage);
      await callback({
        text: `I encountered an error while searching YouTube: ${errorMessage}.`,
        source: message.content.source,
      });
      return { success: false, error: errorMessage };
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Find the YouTube link for Surefire by Wilderado",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll search for that on YouTube!",
          actions: ["SEARCH_YOUTUBE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you find the youtube link for Never Gonna Give You Up?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let me search YouTube for that song!",
          actions: ["SEARCH_YOUTUBE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "DJynAI, search youtube for bohemian rhapsody",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll find that for you on YouTube!",
          actions: ["SEARCH_YOUTUBE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What's the YouTube link for Blinding Lights by The Weeknd?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Searching YouTube for that track!",
          actions: ["SEARCH_YOUTUBE"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default searchYouTube;
