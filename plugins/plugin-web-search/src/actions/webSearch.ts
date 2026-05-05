import {
    type Action,
    type ActionResult,
    elizaLogger,
    type HandlerCallback,
    type HandlerOptions,
    type IAgentRuntime,
    type Memory,
    ServiceType,
    type State,
} from "@elizaos/core";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";

import { WebSearchService } from "../services/webSearchService";
import type { SearchResult } from "../types";

const DEFAULT_MAX_WEB_SEARCH_TOKENS = 4000;
const DEFAULT_MODEL_ENCODING = "gpt-3.5-turbo";

function getTotalTokensFromString(
    str: string,
    encodingName: TiktokenModel = DEFAULT_MODEL_ENCODING
): number {
    const encoding = encodingForModel(encodingName);
    return encoding.encode(str).length;
}

function maxTokens(data: string, limit: number = DEFAULT_MAX_WEB_SEARCH_TOKENS): string {
    if (getTotalTokensFromString(data) >= limit) {
        return data.slice(0, limit);
    }
    return data;
}

export const webSearch: Action = {
    name: "WEB_SEARCH",
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
    suppressPostActionContinuation: true,
    description: "Perform a web search to find information related to the message.",
    descriptionCompressed: "Search web via Tavily; return ranked links.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const key = runtime.getSetting("TAVILY_API_KEY");
        return typeof key === "string" && key.length > 0;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options?: HandlerOptions,
        callback?: HandlerCallback,
        _responses?: Memory[]
    ): Promise<ActionResult | undefined> => {
        const userId = runtime.agentId;
        elizaLogger.debug({ userId }, "WEB_SEARCH user");

        const rawPrompt = message.content.text;
        const webSearchPrompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
        if (!webSearchPrompt) {
            elizaLogger.warn("WEB_SEARCH: empty prompt");
            return { success: false, error: "Empty search prompt" };
        }
        elizaLogger.debug({ promptLength: webSearchPrompt.length }, "WEB_SEARCH prompt");

        const svc = runtime.getService(ServiceType.WEB_SEARCH);
        if (!(svc instanceof WebSearchService)) {
            elizaLogger.error("WEB_SEARCH: WebSearchService is not registered");
            return { success: false, error: "Web search service is not available" };
        }

        const searchResponse = await svc.search(webSearchPrompt);

        if (searchResponse?.results?.length) {
            const responseList = searchResponse.answer
                ? `${searchResponse.answer}${
                      Array.isArray(searchResponse.results) && searchResponse.results.length > 0
                          ? `\n\nFor more details, you can check out these resources:\n${searchResponse.results
                                .map(
                                    (result: SearchResult, index: number) =>
                                        `${index + 1}. [${result.title}](${result.url})`
                                )
                                .join("\n")}`
                          : ""
                  }`
                : "";

            const text = maxTokens(responseList, DEFAULT_MAX_WEB_SEARCH_TOKENS);
            if (callback) {
                await callback({ text });
            }
            return { success: true, text };
        }

        elizaLogger.error("search failed or returned no data.");
        return { success: false, error: "Search returned no results" };
    },
    examples: [
        [
            {
                name: "{{user1}}",
                content: {
                    text: "Find the latest news about SpaceX launches.",
                },
            },
            {
                name: "{{agentName}}",
                content: {
                    text: "Here is the latest news about SpaceX launches:",
                    action: "WEB_SEARCH",
                },
            },
        ],
        [
            {
                name: "{{user1}}",
                content: {
                    text: "Can you find details about the iPhone 16 release?",
                },
            },
            {
                name: "{{agentName}}",
                content: {
                    text: "Here are the details I found about the iPhone 16 release:",
                    action: "WEB_SEARCH",
                },
            },
        ],
    ],
};
