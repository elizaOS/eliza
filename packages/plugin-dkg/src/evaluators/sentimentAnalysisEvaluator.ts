import {
    generateText,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    ModelClass,
    Evaluator,
} from "@elizaos/core";
import { isSentimentAnalysisQueryPrompt } from "../constants.ts";

export class SentimentAnalysisEvaluator implements Evaluator {
    name = "SENTIMENT_ANALYSIS_EVALUATOR";
    similes = ["sentiment", "evaluate sentiment", "check sentiment"];
    description = "Evaluates messages for sentiment analysis requests";
    alwaysRun = true;

    async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
        elizaLogger.log("Entering sentiment analysis evaluator!");

        const requiredEnvVars = [
            "DKG_ENVIRONMENT",
            "DKG_HOSTNAME",
            "DKG_PORT",
            "DKG_BLOCKCHAIN_NAME",
            "DKG_PUBLIC_KEY",
            "DKG_PRIVATE_KEY",
        ];

        const missingVars = requiredEnvVars.filter(
            (varName) => !runtime.getSetting(varName),
        );

        if (missingVars.length > 0) {
            elizaLogger.error(
                `Missing required environment variables: ${missingVars.join(", ")}`,
            );
            return false;
        }

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
        _state: State,
    ): Promise<String> {
        return "DKG_ANALYZE_SENTIMENT";
    }

    examples = [];
}

export const sentimentAnalysisEvaluator = new SentimentAnalysisEvaluator();
