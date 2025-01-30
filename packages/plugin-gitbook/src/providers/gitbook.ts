import {
    type Provider,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import type { GitBookResponse, GitBookClientConfig } from "../types";

function cleanText(text: string): string {
    const cleaned = text
        .replace(/<@!?\d+>/g, "") // Discord mentions
        .replace(/<#\d+>/g, "") // Discord channels
        .replace(/<@&\d+>/g, "") // Discord roles
        .replace(/(?:^|\s)@[\w_]+/g, "") // Platform mentions
        .trim();

    return cleaned;
}

async function validateQuery(
    runtime: IAgentRuntime,
    text: string
): Promise<boolean> {
    // Default general queries - everything else comes from config
    const keywords = {
        generalQueries: [
            "how",
            "what",
            "where",
            "explain",
            "show",
            "tell",
            "can",
            "does",
            "is",
            "are",
            "will",
            "why",
            "benefits",
            "features",
            "cost",
            "price",
            "use",
            "using",
            "work",
            "access",
            "get",
        ],
    };

    try {
        const gitbookConfig = runtime.character.clientConfig
            ?.gitbook as GitBookClientConfig;

        // Get project terms and document triggers from config
        const projectTerms = gitbookConfig?.keywords?.projectTerms || [];
        const documentTriggers = gitbookConfig?.documentTriggers || [];

        // Merge any additional general queries from config
        if (gitbookConfig?.keywords?.generalQueries) {
            keywords.generalQueries = [
                ...keywords.generalQueries,
                ...gitbookConfig.keywords.generalQueries,
            ];
        }

        const containsAnyWord = (text: string, words: string[] = []) => {
            return (
                words.length === 0 ||
                words.some((word) => {
                    if (word.includes(" ")) {
                        return text.includes(word.toLowerCase());
                    }
                    const regex = new RegExp(`\\b${word}\\b`, "i");
                    return regex.test(text);
                })
            );
        };

        const hasProjectTerm = containsAnyWord(text, projectTerms);
        const hasDocTrigger = containsAnyWord(text, documentTriggers);
        const hasGeneralQuery = containsAnyWord(text, keywords.generalQueries);

        const isValid = hasProjectTerm || hasDocTrigger || hasGeneralQuery;

        elizaLogger.info(`✅ Is GitBook Validation Result: ${isValid}`);
        return isValid;
    } catch (error) {
        elizaLogger.warn(`❌ Error in GitBook validation:\n${error}`);
        return false;
    }
}

export const gitbookProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ): Promise<string> => {
        try {
            const spaceId = runtime.getSetting("GITBOOK_SPACE_ID");
            if (!spaceId) {
                elizaLogger.error("⚠️ GitBook Space ID not configured");
                return "";
            }

            const text = message.content.text.toLowerCase().trim();
            const isValidQuery = await validateQuery(runtime, text);

            if (!isValidQuery) {
                elizaLogger.info("⚠️ GitBook Query validation failed");
                return "";
            }

            const cleanedQuery = cleanText(message.content.text);

            const response = await fetch(
                `https://api.gitbook.com/v1/spaces/${spaceId}/search/ask`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        query: cleanedQuery,
                        variables: {},
                    }),
                }
            );

            if (!response.ok) {
                elizaLogger.error("❌ GitBook API error:", response.status);
                return "";
            }

            const result: GitBookResponse = await response.json();

            return `## GitBook Provider
### Query: ${message.content.text}
### Answer:
${result.answer?.text || ""}`;
        } catch (error) {
            elizaLogger.error("❌ Error in GitBook provider:", error);
            return "";
        }
    },
};
