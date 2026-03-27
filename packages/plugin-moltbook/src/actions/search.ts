/**
 * Search Action
 *
 * Search for posts, users, and submolts on Moltbook.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { PLUGIN_NAME } from "../constants";
import type { MoltbookService } from "../service";
import type { MoltbookSearchResults } from "../types";

export const searchAction: Action = {
  name: "MOLTBOOK_SEARCH",
  similes: ["SEARCH_MOLTBOOK", "FIND_ON_MOLTBOOK", "LOOKUP_MOLTBOOK"],
  description: "Search for posts, users, or topics on Moltbook.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["moltbook", "search"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:moltbook|search)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? message?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State | undefined
    ): Promise<boolean> => {
      const text = message.content.text?.toLowerCase() || "";

      // Check for search intent
      const hasSearchIntent =
        text.includes("search") ||
        text.includes("find") ||
        text.includes("look up") ||
        text.includes("lookup");

      const hasMoltbookMention = text.includes("moltbook");

      return hasSearchIntent && hasMoltbookMention;
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<MoltbookService>(PLUGIN_NAME);
    if (!service) {
      const error = "Moltbook service is not available";
      if (callback) {
        await callback({ text: error, error: true });
      }
      return { success: false, error: new Error(error) };
    }

    // Check authentication
    const creds = await service.getCredentials();
    if (!creds) {
      const error = "Not authenticated with Moltbook.";
      if (callback) {
        await callback({ text: error, error: true });
      }
      return { success: false, error: new Error(error) };
    }

    // Extract search query
    const intent = extractSearchIntent(message.content.text || "");

    if (!intent.query) {
      const error = "Please specify what to search for.";
      if (callback) {
        await callback({ text: error });
      }
      return { success: false, error: new Error(error) };
    }

    try {
      // Perform search
      const results = await service.search(intent.query, {
        type: intent.type,
        limit: 10,
      });

      if (!results) {
        const error = "Search failed.";
        if (callback) {
          await callback({ text: error, error: true });
        }
        return { success: false, error: new Error(error) };
      }

      // Format results
      const formattedResults = formatSearchResults(results, intent.query);

      if (callback) {
        await callback({ text: formattedResults });
      }

      return {
        success: true,
        text: `Search results for "${intent.query}"`,
        values: {
          query: intent.query,
          resultCount: results.count || results.results?.length || 0,
        },
        data: {
          action: "MOLTBOOK_SEARCH",
          results,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      runtime.logger.error({ error }, "Error searching Moltbook");

      if (callback) {
        await callback({
          text: `Search failed: ${errorMessage}`,
          error: true,
        });
      }

      return {
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage),
      };
    }
  },

  examples: [
    [
      {
        name: "{{userName}}",
        content: {
          text: "Search Moltbook for AI agents",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: '**Search Results for "AI agents"**\n\n📝 **Posts (3)**\n- "Thoughts on AI Agents" by @alice ↑15\n- "Building autonomous agents" by @bob ↑8\n\n👤 **Users (1)**\n- @ai_researcher',
          actions: ["MOLTBOOK_SEARCH"],
        },
      },
    ],
  ],
};

/**
 * Extract search intent from user message
 */
function extractSearchIntent(text: string): {
  query?: string;
  type?: "posts" | "comments" | "all";
} {
  // Extract search type (Moltbook semantic search supports: posts, comments, all)
  let type: "posts" | "comments" | "all" | undefined;
  const lowerText = text.toLowerCase();

  if (lowerText.includes("post")) {
    type = "posts";
  } else if (lowerText.includes("comment") || lowerText.includes("discussion")) {
    type = "comments";
  }

  // Extract query
  // Pattern: search ... for "query" or search ... for query
  const quotedMatch = text.match(
    /(?:search|find|look up)\s+(?:moltbook\s+)?(?:for\s+)?["']([^"']+)["']/i
  );
  if (quotedMatch) {
    return { query: quotedMatch[1], type };
  }

  const forMatch = text.match(
    /(?:search|find|look up)\s+(?:moltbook\s+)?for\s+(.+?)(?:\s+on|\s*$)/i
  );
  if (forMatch) {
    return { query: forMatch[1].trim(), type };
  }

  // Pattern: search moltbook query
  const simpleMatch = text.match(/(?:search|find)\s+(?:moltbook\s+)?(.+)/i);
  if (simpleMatch) {
    // Clean up common words
    const query = simpleMatch[1].replace(/\b(on|in|moltbook|for|the)\b/gi, "").trim();
    return { query, type };
  }

  return { type };
}

/**
 * Format search results for display
 * Results are from Moltbook's semantic search API
 */
function formatSearchResults(results: MoltbookSearchResults, query: string): string {
  const sections: string[] = [];

  sections.push(`**Semantic Search Results for "${query}"**`);

  if (!results.results || results.results.length === 0) {
    sections.push("");
    sections.push("No results found.");
    return sections.join("\n");
  }

  // Group by type
  const posts = results.results.filter((r) => r.type === "post");
  const comments = results.results.filter((r) => r.type === "comment");

  // Posts section
  if (posts.length > 0) {
    sections.push("");
    sections.push(`📝 **Posts (${posts.length})**`);
    for (const item of posts.slice(0, 5)) {
      const score = item.upvotes - item.downvotes;
      const scoreStr = score >= 0 ? `↑${score}` : `↓${Math.abs(score)}`;
      const similarity = Math.round(item.similarity * 100);
      sections.push(
        `- "${item.title || "Untitled"}" by @${item.author.name} ${scoreStr} (${similarity}% match)`
      );
    }
  }

  // Comments section
  if (comments.length > 0) {
    sections.push("");
    sections.push(`💬 **Comments (${comments.length})**`);
    for (const item of comments.slice(0, 5)) {
      const preview = item.content.slice(0, 50) + (item.content.length > 50 ? "..." : "");
      const similarity = Math.round(item.similarity * 100);
      sections.push(`- "${preview}" by @${item.author.name} (${similarity}% match)`);
    }
  }

  sections.push("");
  sections.push(`_Found ${results.count} results via semantic search_`);

  return sections.join("\n");
}

export default searchAction;
