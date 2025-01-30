import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { getObsidian, markdownToPlaintext, processUserInput }  from "../helper";
import { isSearchQuery } from "../types";

export const searchAction: Action = {
    name: "SEARCH",
    similes: [
        "FIND",
        "QUERY",
        "LOOKUP",
        "QUICK_SEARCH",
        "BASIC_SEARCH",
        "FAST_SEARCH",
        "SEARCH_KEYWORD",
        "OR_SEARCH",
        "FIND_KEYWORDS",
        "SEARCH_KEYWORDS",
        "FULL_SEARCH",
        "FULL_SEARCH_VAULT",
        "FULL_SEARCH_NOTES",
        "FULL_SEARCH_FILES",
        "SEARCH_ALL",
        "SEARCH_ALL_NOTES",
        "SEARCH_ALL_FILES",
        "SEARCH_VAULT",
        "SEARCH_NOTES",
        "FIND_NOTES",
        "FIND_FILES",
        "FIND_ALL",
        "FIND_ALL_NOTES",
        "FIND_ALL_FILES",
        "QUERY_VAULT",
        "QUERY_ALL",
        "QUERY_ALL_NOTES",
        "QUERY_ALL_FILES",
        "DATAVIEW_QUERY",
        "DQL",
    ],
    description:
        "Search the Obsidian vault using plain text, Dataview queries, or JSONLogic. Format: 'Search QUERY' or 'Query TABLE field FROM folder'",
    validate: async (runtime: IAgentRuntime) => {
        try {
            elizaLogger.debug("Validating Obsidian connection");
            const obsidian = await getObsidian(runtime);
            await obsidian.connect();
            elizaLogger.debug("Obsidian connection validated successfully");
            return true;
        } catch (error) {
            elizaLogger.error("Failed to validate Obsidian connection:", error);
            return false;
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.info("Starting search handler");
        const obsidian = await getObsidian(runtime);

        try {
            let query = "";
            let queryFormat: 'plaintext' | 'dataview' | 'jsonlogic' = 'plaintext';
            let searchOptions: {
                contextLength?: number;
                ignoreCase?: boolean;
            } = {
                contextLength: 150,
                ignoreCase: true,
            };

            // Initialize or update state for context generation
            if (!state) {
                state = (await runtime.composeState(message)) as State;
            } else {
                state = await runtime.updateRecentMessageState(state);
            }

            const searchContext = await processUserInput(message.content.text as string, state, runtime);

            elizaLogger.debug("Search context:", JSON.stringify(searchContext.query, null, 2));

            if (!isSearchQuery(searchContext)) {
                elizaLogger.error(
                    "Invalid search query:",
                    searchContext
                );
                return null;
            }

            // Extract query and format from various text patterns
            if (searchContext.queryFormat === 'dataview') {
                query = searchContext.query;
                queryFormat = 'dataview';

                // Merge provided options with defaults
                if (searchContext.options) {
                    searchOptions = {
                        ...searchOptions,
                        ...searchContext.options as typeof searchOptions,
                    };
                } /*else {
                    // Extract folders if specified in the format "FROM folder1, folder2"
                    const fromMatch = query.match(/FROM\s+"([^"]+)"(?:\s*,\s*"([^"]+)")*$/i);
                    if (fromMatch) {
                        searchOptions.searchIn = fromMatch
                            .slice(1)
                            .filter(Boolean)
                            .map(folder => folder.trim());
                    }
                }*/

            } else if (searchContext.queryFormat === 'jsonlogic') {
                queryFormat = 'jsonlogic';
                query = searchContext.query;
                // Merge provided options with defaults
                if (searchContext.options) {
                    searchOptions = {
                        ...searchOptions,
                        ...searchContext.options as typeof searchOptions,
                    };
                }
            } else {
                query = searchContext.query;
                // Merge provided options with defaults
                if (searchContext.options) {
                    searchOptions = {
                        ...searchOptions,
                        ...searchContext.options as typeof searchOptions,
                    };
                }
            }

            if (!query) {
                throw new Error(
                    "Search query is required. Use format: 'Search QUERY' or 'Query TABLE field FROM folder'"
                );
            }

            elizaLogger.info(`Searching vault with ${queryFormat} query: ${typeof query === 'string' ? query : JSON.stringify(query)}`);

            if (queryFormat === 'plaintext') {
            const results = await obsidian.search(
                query,
                queryFormat,
                searchOptions
            );

            elizaLogger.info(`Found ${results.length} matching notes`);

            // Format the results into a readable string
            const formattedResults = results.length > 0
                ? results.map(result => {

                const matches = result.matches
                    .map(item => `${markdownToPlaintext(item.context.substring(item.match.start, searchOptions.contextLength || 150)).trim()}...`)
                    .join('\n');

return `
#### ✅ ${result.filename} (**Score:** ${result.score})\n${matches}`;

                }).join('\n\n')
                : "**No matching notes found**";


                elizaLogger.info("Formatted results:", formattedResults);

            if (callback) {
                callback({
                    text: `Found **${results.length}** matches:\n\n${formattedResults}`,
                    metadata: {
                        count: results.length,
                        results: results,
                        query: query,
                        queryFormat: queryFormat,
                        searchOptions: searchOptions,
                    },
                });
            }

        } else {

            const results = await obsidian.search(
                query,
                queryFormat,
                searchOptions
            );

            elizaLogger.info(`Found ${results.length} matching notes`);

            // Format the results into a readable string
            const formattedResults = results.length > 0
                ? results.map(result => {
return `
#### ✅ ${result.filename}`;

                }).join('\n\n')
                : "**No matching notes found**";


                elizaLogger.info("Formatted results:", formattedResults);

            if (callback) {
                callback({
                    text: `Found **${results.length}** matches:\n\n${formattedResults}`,
                    metadata: {
                        count: results.length,
                        results: results,
                        query: query,
                        queryFormat: queryFormat,
                        searchOptions: searchOptions,
                    },
                });
            }


        }

            return true;
        } catch (error) {
            elizaLogger.error("Error searching vault:", error);
            if (callback) {
                callback({
                    text: `Error searching vault: ${error.message}`,
                    error: true,
                });
            }
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Search project management",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Search <keyword>",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Find <keyword>",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Search project OR management",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Find meeting notes OR agenda",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Quick search todo OR task OR deadline",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "TABLE file.name FROM \"Notes\"",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "DQL FROM \"Daily Notes\" WHERE date = today",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "SEARCH",
                },
            },
        ],
    ],
};

export default searchAction;
