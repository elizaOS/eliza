import {
  Action,
  type ActionResult,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { defineActionParameters } from "@/lib/eliza/plugin-cloud-bootstrap/types";
import { normalizeCloudActionArgs } from "@/lib/eliza/plugin-cloud-bootstrap/utils/native-planner-guards";
import { WebSearchService } from "../services/searchService";
import type { SearchResult } from "../types";

interface WebSearchParams {
  query?: string;
  topic?: string;
  source?: string;
  max_results?: number;
  search_depth?: string;
  time_range?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  start_date?: string;
  end_date?: string;
}

const DEFAULT_MAX_WEB_SEARCH_CHARS = 16000;

/**
 * Build the extraction template with the appropriate conversation context.
 * Prefers conversationLog if available, falls back to recentMessages.
 */
function buildExtractionTemplate(conversationContext: string): string {
  return `# Web Search Parameter Extraction

## Recent Conversation
${conversationContext}

## Task
Extract the search query and parameters from the conversation above. The user wants to search the web for information.

## Instructions
- Determine the exact search query the user wants
- If the topic is about crypto, DeFi, finance, or markets, set topic to "finance"
- Only include optional parameters if clearly indicated by the user
- Briefly explain parameter choices in the JSON thought field

Respond using JSON only. No markdown, no prose, no XML.
{
  "thought": "2-3 sentence rationale for the query and parameters",
  "query": "the exact query to search",
  "topic": "general or finance"
}`;
}

function MaxTokens(data: string, maxTokens: number = DEFAULT_MAX_WEB_SEARCH_CHARS): string {
  // Character-based truncation to cap response length
  return data.length > maxTokens ? data.slice(0, maxTokens) : data;
}

/**
 * Extract search parameters from state or via LLM.
 * Supports multiple runtime patterns:
 * 1. Native keyed params from tool execution
 * 2. Legacy direct actionParams/actionInput
 * 3. LLM extraction from conversation context
 */
async function extractSearchParams(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
): Promise<WebSearchParams> {
  const content = message.content as Record<string, unknown>;
  const messageParams = normalizeCloudActionArgs("WEB_SEARCH", {
    params: content.params,
    actionParams: content.actionParams,
    actionInput: content.actionInput,
  }) as WebSearchParams;

  if (messageParams?.query?.trim()) {
    logger.info(
      { src: "webSearch:extractParams", source: "message.params" },
      "Using params from action message",
    );
    return messageParams;
  }

  // First, try to get params from state (custom bootstrap pattern)
  const composedState = await runtime.composeState(message, ["ACTION_STATE"], true);
  const stateParamSources = [
    { source: "actionParams", value: composedState?.data?.actionParams },
    { source: "webSearch", value: composedState?.data?.webSearch },
    { source: "websearch", value: composedState?.data?.websearch },
  ];
  const matchedStateParams = stateParamSources.find(
    (candidate) =>
      candidate.value && typeof candidate.value === "object" && !Array.isArray(candidate.value),
  );
  const stateParams = (matchedStateParams?.value || {}) as WebSearchParams;

  // If we have a query from state, use it
  if (stateParams?.query?.trim()) {
    logger.info(
      {
        src: "webSearch:extractParams",
        source: matchedStateParams?.source || "actionParams",
      },
      "Using params from state",
    );
    return stateParams;
  }

  // Otherwise, extract from conversation using LLM
  logger.info({ src: "webSearch:extractParams", source: "llm" }, "Extracting params via LLM");

  try {
    // Compose state - try to get both conversationLog and recentMessages
    const extractionState = await runtime.composeState(message, ["RECENT_MESSAGES"], true);

    // Prefer conversationLog if available, fallback to recentMessages
    const conversationLog = extractionState?.values?.conversationLog;
    const recentMessages = extractionState?.values?.recentMessages;

    const conversationContext =
      (typeof conversationLog === "string" && conversationLog.trim()) ||
      (typeof recentMessages === "string" && recentMessages.trim()) ||
      "";

    const contextSource =
      typeof conversationLog === "string" && conversationLog.trim()
        ? "conversationLog"
        : "recentMessages";

    logger.debug({ src: "webSearch:extractParams", contextSource }, "Using conversation context");

    const template = buildExtractionTemplate(conversationContext);
    const prompt = composePromptFromState({
      state: extractionState,
      template,
    });

    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const parsed = parseJSONObjectFromText(response || "");

    if (parsed?.query) {
      const extractedParams: WebSearchParams = {
        query: String(parsed.query).trim(),
        topic: parsed.topic === "finance" ? "finance" : ("general" as "general" | "finance"),
      };

      logger.info(
        { src: "webSearch:extractParams", query: extractedParams.query },
        "Extracted query via LLM",
      );

      return extractedParams;
    }
  } catch (err) {
    logger.warn(
      { src: "webSearch:extractParams", error: (err as Error).message },
      "LLM extraction failed, falling back to message text",
    );
  }

  // Final fallback: use the message text directly as the query
  const messageText = message.content?.text?.trim();
  if (messageText) {
    logger.info(
      { src: "webSearch:extractParams", source: "messageText" },
      "Using message text as query",
    );
    return { query: messageText };
  }

  return {};
}

export const webSearch: Action & Record<string, unknown> = {
  name: "WEB_SEARCH",
  contexts: ["web", "documents", "finance", "crypto"],
  contextGate: { anyOf: ["web", "documents", "finance", "crypto"] },
  roleGate: { minRole: "USER" },
  similes: [
    "SEARCH_WEB",
    "INTERNET_SEARCH",
    "LOOKUP",
    "QUERY_WEB",
    "FIND_ONLINE",
    "SEARCH_ENGINE",
    "WEB_LOOKUP",
    "ONLINE_SEARCH",
    "FIND_INFORMATION",
  ],
  suppressInitialMessage: true,
  description:
    "Search the web using hosted Google Search grounding via Gemini. Supports general web search and finance topics (crypto/DeFi/markets). Use when other actions/providers can't provide accurate or current info.\n\n" +
    "IMPORTANT - Result Quality Check:\n" +
    "- If search returns off-topic or poor results, RETRY with parameter adjustments in the SAME round\n" +
    "- Try: topic='finance' for crypto/markets, source filter (theblock.com, coindesk.com), broader time_range, or a rephrased query\n" +
    "- For crypto/DeFi content: use topic='finance' + source from [theblock.com, coindesk.com, decrypt.co, dlnews.com]\n" +
    "- Don't give up after one attempt if results are clearly irrelevant",

  // Parameter schema for tool calling.
  parameters: defineActionParameters({
    query: {
      type: "string",
      description: "The search query to look up on the web",
      required: true,
    },
    topic: {
      type: "string",
      description:
        "Search topic: 'general' for web search, 'finance' for financial/crypto/DeFi content. Defaults to 'general'.",
      required: false,
    },
    source: {
      type: "string",
      description:
        "Specific source domain to limit results (e.g., 'bloomberg.com', 'reuters.com'). Uses site: operator.",
      required: false,
    },
    max_results: {
      type: "number",
      description: "Maximum number of results to return (1-20). Defaults to 5.",
      required: false,
    },
    search_depth: {
      type: "string",
      description:
        "Compatibility field from older search providers. Accepted but ignored by hosted Google search.",
      required: false,
    },
    time_range: {
      type: "string",
      description: "Time range filter: 'day', 'week', 'month', 'year' (or 'd', 'w', 'm', 'y')",
      required: false,
    },
    start_date: {
      type: "string",
      description: "Start date filter in YYYY-MM-DD format (returns results after this date)",
      required: false,
    },
    end_date: {
      type: "string",
      description: "End date filter in YYYY-MM-DD format (returns results before this date)",
      required: false,
    },
  }),

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    try {
      const service = runtime.getService<WebSearchService>("WEB_SEARCH");
      return !!service;
    } catch (err) {
      logger.warn(
        { src: "webSearch:validate", error: (err as Error).message },
        "WebSearchService not available",
      );
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const webSearchService = runtime.getService<WebSearchService>("WEB_SEARCH");
      if (!webSearchService) {
        throw new Error("WebSearchService not initialized");
      }

      // Extract parameters (supports multiple runtime patterns)
      // The LLM call will automatically stream the <thought> tag as reasoning
      const params = await extractSearchParams(runtime, message, state);

      // Extract and validate query parameter (required)
      const query: string | undefined = params?.query?.trim();

      if (!query) {
        const errorMsg = "Missing required parameter 'query'. Please specify what to search for.";
        logger.error({ src: "webSearch:handler" }, errorMsg);
        const emptyResult: ActionResult = {
          text: errorMsg,
          success: false,
          data: {
            actionName: "WEB_SEARCH",
          },
          error: "missing_required_parameter",
        };
        if (callback) {
          callback({
            text: emptyResult.text,
            content: { error: "missing_required_parameter", details: errorMsg },
          });
        }
        return emptyResult;
      }

      const source = params?.source?.trim();
      const topic = params?.topic === "finance" ? "finance" : "general";
      const maxResults = params?.max_results ? Math.min(Math.max(1, params.max_results), 10) : 5;

      logger.info({ src: "webSearch:handler", query, topic, source }, "Executing web search");

      // Store input parameters for return
      const inputParams = {
        query,
        topic,
        source,
        max_results: maxResults,
        search_depth: params?.search_depth,
        time_range: params?.time_range,
        start_date: params?.start_date,
        end_date: params?.end_date,
      };

      const searchResponse = await webSearchService.search(query, {
        topic,
        max_results: maxResults,
        time_range: params?.time_range,
        start_date: params?.start_date,
        end_date: params?.end_date,
        source,
      });

      if (searchResponse && searchResponse.results.length) {
        const responseList = searchResponse.answer
          ? `${searchResponse.answer}${
              Array.isArray(searchResponse.results) && searchResponse.results.length > 0
                ? `\n\nFor more details, you can check out these resources:\n${searchResponse.results
                    .map(
                      (result: SearchResult, index: number) =>
                        `${index + 1}. [${result.title}](${result.url})`,
                    )
                    .join("\n")}`
                : ""
            }`
          : "";

        // Build detailed reasoning for storage
        const reasoningSteps = [
          `1. Extracted search query: "${query}"`,
          `2. Configured search: topic=${topic}${source ? `, source=${source}` : ""}`,
          `3. Executed hosted Google-grounded search with ${maxResults} max results`,
          `4. Retrieved ${searchResponse.results.length} grounded results${searchResponse.answer ? " with synthesized answer" : ""}`,
        ].join("\n");

        const result: ActionResult = {
          text: MaxTokens(responseList, DEFAULT_MAX_WEB_SEARCH_CHARS),
          success: true,
          data: {
            ...searchResponse,
            actionName: "WEB_SEARCH",
            reasoning: reasoningSteps,
            searchMetadata: {
              query,
              topic,
              source,
              maxResults,
              resultsFound: searchResponse.results.length,
              hasAnswer: !!searchResponse.answer,
              searchQueries: searchResponse.searchQueries ?? [],
            },
          },
          input: inputParams,
        } as ActionResult & { input: typeof inputParams };

        if (callback) {
          callback({
            text: result.text,
            actions: ["WEB_SEARCH"],
            data: result.data,
          } as unknown as Content);
        }

        return result;
      }

      const noResult: ActionResult = {
        text: "I couldn't find relevant results for that query.",
        success: false,
        data: {
          actionName: "WEB_SEARCH",
        },
        input: inputParams,
      } as ActionResult & { input: typeof inputParams };

      if (callback) {
        callback({ text: noResult.text });
      }
      return noResult;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ src: "webSearch:handler", error: errMsg }, "Action failed");

      const errorResult: ActionResult = {
        text: `Web search failed: ${errMsg}`,
        success: false,
        data: {
          actionName: "WEB_SEARCH",
        },
        error: errMsg,
      };

      if (callback) {
        callback({
          text: errorResult.text,
          content: { error: "web_search_failed", details: errMsg },
        });
      }
      return errorResult;
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "Latest Aave news",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me search for Aave news from crypto sources:",
          action: "WEB_SEARCH",
          actionParams: {
            query: "Aave protocol",
            topic: "finance",
            source: "theblock.com",
            time_range: "week",
          },
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: {
          text: "Find the latest news about SpaceX launches.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here is the latest news about SpaceX launches:",
          action: "WEB_SEARCH",
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: {
          text: "Can you find details about the iPhone 16 release?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here are the details I found about the iPhone 16 release:",
          action: "WEB_SEARCH",
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: {
          text: "What is the schedule for the next FIFA World Cup?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here is the schedule for the next FIFA World Cup:",
          action: "WEB_SEARCH",
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "Check the latest stock price of Tesla." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here is the latest stock price of Tesla I found:",
          action: "WEB_SEARCH",
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: {
          text: "What are the current trending movies in the US?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here are the current trending movies in the US:",
          action: "WEB_SEARCH",
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: {
          text: "What is the latest score in the NBA finals?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here is the latest score from the NBA finals:",
          action: "WEB_SEARCH",
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "When is the next Apple keynote event?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here is the information about the next Apple keynote event:",
          action: "WEB_SEARCH",
        },
      },
    ],
  ],
};
