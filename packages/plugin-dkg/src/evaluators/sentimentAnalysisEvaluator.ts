import type { Evaluator, IAgentRuntime, Memory, State } from "@elizaos/core";
import { ModelClass } from "@elizaos/core";
import { generateText, elizaLogger } from "@elizaos/core";
import { isSentimentAnalysisQueryPrompt } from "../constants.ts";

export class SentimentAnalysisEvaluator implements Evaluator {
    name = "SENTIMENT_ANALYSIS_EVALUATOR";
    similes = ["sentiment", "evaluate sentiment", "check sentiment"];
    description = "Evaluates messages for sentiment analysis requests";
    alwaysRun = true;

    async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
        elizaLogger.log("Entering sentiment analysis evaluator!");

        const content =
            typeof message.content === "string"
                ? message.content
                : message.content?.text;

        if (!content) return false;

        const context = isSentimentAnalysisQueryPrompt(content);

        const isSentimentQuery = await generateText({
            runtime,
            context,
            modelClass: ModelClass.MEDIUM,
        });

        elizaLogger.log(
            `Evaluated user query for sentiment analysis, decision: ${isSentimentQuery}`,
        );

        return isSentimentQuery.toLowerCase() === "yes";
    }

    async handler(
        _runtime: IAgentRuntime,
        _message: Memory,
        _state?: State,
    ): Promise<string> {
        elizaLogger.log("Evaluated query, action is DKG_ANALYZE_SENTIMENT");

        return "DKG_ANALYZE_SENTIMENT";
    }

    examples = [
        {
            context: "User asking for ticker sentiment with address",
            messages: [
                {
                    user: "{{user}}",
                    content: {
                        text: "What's the sentiment of 0x1234567890123456789012345678901234567890 on X recently?",
                        action: "DKG_ANALYZE_SENTIMENT",
                    },
                },
            ],
            outcome: "DKG_ANALYZE_SENTIMENT",
        },
        {
            context: "User checking ticker sentiment with $ symbol",
            messages: [
                {
                    user: "{{user}}",
                    content: {
                        text: "How is $eth doing recently?",
                        action: "DKG_ANALYZE_SENTIMENT",
                    },
                },
            ],
            outcome: "DKG_ANALYZE_SENTIMENT",
        },
        {
            context: "User checking ticker sentiment with plain symbol",
            messages: [
                {
                    user: "{{user}}",
                    content: {
                        text: "What's the sentiment for btc",
                        action: "DKG_ANALYZE_SENTIMENT",
                    },
                },
            ],
            outcome: "DKG_ANALYZE_SENTIMENT",
        },
    ];
}

export const sentimentAnalysisEvaluator = new SentimentAnalysisEvaluator();
