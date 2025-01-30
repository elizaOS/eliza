import type { HandlerCallback } from "@elizaos/core";
import {
    type Action,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";

const TIMEOUT_MS = 5000;
const RATE_LIMIT_WINDOW_MS = 60000;
let lastRequestTime = 0;

export const fetchStandingsAction: Action = {
    name: "FETCH_STANDINGS",
    similes: ["GET_TABLE", "LEAGUE_STANDINGS"],
    description: "Fetch current league standings",
    validate: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State,
    ) => {
        const apiKey = runtime.getSetting("FOOTBALL_API_KEY");
        return !!apiKey;
    },
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State,
        _options?: { [key: string]: unknown },
        callback?: HandlerCallback,
    ): Promise<boolean> => {
        try {
            const league = runtime.getSetting("LEAGUE_ID") || "PL";
            const apiKey = runtime.getSetting("FOOTBALL_API_KEY");

            if (!apiKey?.match(/^[a-f0-9]{32}$/i)) {
                elizaLogger.error("Invalid API key format");
                return false;
            }

            const now = Date.now();
            if (now - lastRequestTime < RATE_LIMIT_WINDOW_MS) {
                elizaLogger.error("Rate limit exceeded");
                return false;
            }
            lastRequestTime = now;

            const apiUrl = `https://api.football-data.org/v4/competitions/${league}/standings`;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const response = await fetch(apiUrl, {
                headers: { "X-Auth-Token": apiKey },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                elizaLogger.error(
                    "Error fetching standings data:",
                    response.statusText,
                );
                callback({
                    text: "Error fetching standings data:",
                    action: "FETCH_STANDINGS",
                });
                return false;
            }

            const standingsData = await response.json();
            callback(
                {
                    text: `Football standings data fetched successfully:
                    - Result: ${JSON.stringify(standingsData, null, 2)}`,
                },
                [],
            );

            return;
        } catch (error) {
            elizaLogger.error("Error in fetchStandingsAction:", error);
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What are the current standings in the Premier League?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The top 2 teams are: 1. Manchester City - 45 points, 2. Arsenal - 42 points.",
                    action: "FETCH_STANDINGS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Give me the table for La Liga" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The top 3 teams in La Liga are: 1. Barcelona, 2. Real Madrid, 3. Atletico Madrid.",
                    action: "FETCH_STANDINGS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Check the Serie A table for me." },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Serie A current standings: Juventus 1st, AC Milan 2nd, Inter Milan 3rd.",
                    action: "FETCH_STANDINGS",
                },
            },
        ],
    ],
};
