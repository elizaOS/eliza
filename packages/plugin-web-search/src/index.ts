import { elizaLogger } from "@elizaos/core";
import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
} from "@elizaos/core";
import { generateWebSearch } from "@elizaos/core";
import { SearchResult } from "@elizaos/core";
import { encodingForModel, TiktokenModel } from "js-tiktoken";

const DEFAULT_MAX_WEB_SEARCH_TOKENS = 4000;
const DEFAULT_MODEL_ENCODING = "gpt-3.5-turbo";

function getTotalTokensFromString(
    str: string,
    encodingName: TiktokenModel = DEFAULT_MODEL_ENCODING
) {
    const encoding = encodingForModel(encodingName);
    return encoding.encode(str).length;
}

function MaxTokens(
    data: string,
    maxTokens: number = DEFAULT_MAX_WEB_SEARCH_TOKENS
): string {
    if (getTotalTokensFromString(data) >= maxTokens) {
        return data.slice(0, maxTokens);
    }
    return data;
}

const webSearch: Action = {
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
        "ANALYZE_PAGE",
    ],
    description:
        "Perform a web search to find information related to the message.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const tavilyApiKeyOk = !!runtime.getSetting("TAVILY_API_KEY");

        return tavilyApiKeyOk;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Composing state for message:", message);
        state = (await runtime.composeState(message)) as State;
        const userId = runtime.agentId;
        elizaLogger.log("User ID:", userId);

        const webSearchPrompt = message.content.text;
        elizaLogger.log("web search prompt received:", webSearchPrompt);

        const searchResponse = await generateWebSearch(
            webSearchPrompt,
            runtime
        );

        if (searchResponse && searchResponse.results.length) {
            elizaLogger.log("web search performed. Result length:", searchResponse.results.length);
            const responseList = searchResponse.answer
                ? `${searchResponse.answer}${
                      Array.isArray(searchResponse.results) &&
                      searchResponse.results.length > 0
                          ? `\n\nFor more details, you can check out these resources:\n${searchResponse.results
                                .map(
                                    (result: SearchResult, index: number) =>
                                        `${index + 1}. [${result.title}](${result.url})`
                                )
                                .join("\n")}`
                          : ""
                  }`
                : "";
            callback({
                text: MaxTokens(responseList, DEFAULT_MAX_WEB_SEARCH_TOKENS),
            });
        } else {
            elizaLogger.error("search failed or returned no data.");
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please analyze the following github repo: https://github.com/ElizaOS/Eliza.",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll analyze the repo...",
                    action: "WEB_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please provide a web search on the eliza os framework.",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll perform a web search to learn about eliza os framework...",
                    action: "WEB_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What is the schedule for the next FIFA World Cup?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll perform a web search to get the schedule details...",
                    action: "WEB_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What are the current trending movies in the US?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll perform a web search to find out...",
                    action: "WEB_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What is the latest score in the NBA finals?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Let me search the web...",
                    action: "WEB_SEARCH",
                },
            },
        ],
    ],
} as Action;

export const webSearchPlugin: Plugin = {
    name: "webSearch",
    description: "Search web",
    actions: [webSearch],
    evaluators: [],
    providers: [],
};

export default webSearchPlugin;
