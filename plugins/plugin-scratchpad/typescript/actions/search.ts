import {
  type Action,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/specs";
import { createScratchpadService } from "../services/scratchpadService";

interface SearchInput {
  query: string;
  maxResults?: number;
}

function isValidSearchInput(obj: Record<string, unknown>): boolean {
  return typeof obj.query === "string" && obj.query.length > 0;
}

const EXTRACT_TEMPLATE = `Extract the search query from the user's message.

User message: {{text}}

Respond with XML containing:
- query: The search terms to find in scratchpad entries (required)
- maxResults: Maximum number of results to return (optional, default 5)

<response>
<query>search terms</query>
<maxResults>5</maxResults>
</response>`;

async function extractSearchInfo(
  runtime: IAgentRuntime,
  message: Memory
): Promise<SearchInput | null> {
  const prompt = EXTRACT_TEMPLATE.replace("{{text}}", message.content.text ?? "");

  const result = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt,
    stopSequences: [],
  });

  logger.debug("[ScratchpadSearch] Extract result:", result);

  const parsed = parseKeyValueXml(String(result)) as Record<string, unknown> | null;

  if (!parsed || !isValidSearchInput(parsed)) {
    logger.error("[ScratchpadSearch] Failed to extract valid search info");
    return null;
  }

  return {
    query: String(parsed.query),
    maxResults: parsed.maxResults ? Number(parsed.maxResults) : 5,
  };
}

const spec = requireActionSpec("SCRATCHPAD_SEARCH");

export const scratchpadSearchAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check for search/retrieval intent in the message
    const text = (message.content?.text ?? "").toLowerCase();
    const hasSearchIntent =
      text.includes("search") ||
      text.includes("find") ||
      text.includes("look for") ||
      text.includes("scratchpad") ||
      text.includes("notes") ||
      text.includes("retrieve") ||
      text.includes("lookup") ||
      text.includes("what did i save");

    return hasSearchIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _stateFromTrigger: State | undefined,
    _options: HandlerOptions | undefined,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ) => {
    const searchInfo = await extractSearchInfo(runtime, message);

    if (!searchInfo) {
      if (callback) {
        await callback({
          text: "I couldn't understand what you're searching for. Please provide search terms.",
          actions: ["SCRATCHPAD_SEARCH_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to extract search info" };
    }

    try {
      const service = createScratchpadService(runtime);
      const results = await service.search(searchInfo.query, {
        maxResults: searchInfo.maxResults,
      });

      if (results.length === 0) {
        if (callback) {
          await callback({
            text: `No scratchpad entries found matching "${searchInfo.query}".`,
            actions: ["SCRATCHPAD_SEARCH_EMPTY"],
            source: message.content.source,
          });
        }
        return { success: true, text: "No results found", results: [] };
      }

      const resultText = results
        .map((r, i) => {
          const scorePercent = Math.round(r.score * 100);
          return `**${i + 1}. ${r.entryId}** (${scorePercent}% match, lines ${r.startLine}-${r.endLine})\n\`\`\`\n${r.snippet.substring(0, 200)}${r.snippet.length > 200 ? "..." : ""}\n\`\`\``;
        })
        .join("\n\n");

      const successMessage = `Found ${results.length} matching scratchpad entries for "${searchInfo.query}":\n\n${resultText}\n\nUse SCRATCHPAD_READ with an entry ID to view the full content.`;

      if (callback) {
        await callback({
          text: successMessage,
          actions: ["SCRATCHPAD_SEARCH_SUCCESS"],
          source: message.content.source,
        });
      }

      return { success: true, text: successMessage, results };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("[ScratchpadSearch] Error:", errorMsg);
      if (callback) {
        await callback({
          text: `Failed to search scratchpad: ${errorMsg}`,
          actions: ["SCRATCHPAD_SEARCH_FAILED"],
          source: message.content.source,
        });
      }
      return { success: false, text: "Failed to search scratchpad" };
    }
  },

  examples: [],
};

export default scratchpadSearchAction;
