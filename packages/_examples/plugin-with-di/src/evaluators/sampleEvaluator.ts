import { type IAgentRuntime, type Memory, elizaLogger } from "@elizaos/core";
import { injectable } from "inversify";
import {
    globalContainer,
    BaseInjectableEvaluator,
    type EvaluatorOptions
} from "@elizaos/plugin-di";

const options: EvaluatorOptions = {
    alwaysRun: false,
    name: "sampleEvaluator",
    description: "Sample evaluator for checking important content in memory",
    similes: ["content checker", "memory evaluator"],
    examples: [
        {
            context: "Checking if memory contains important content",
            messages: [
                {
                    user: "{{user1}}",
                    content: {
                        text: "This is an important message",
                    },
                },
            ],
            outcome: `\`\`\`json
[
  {
    "score": 1,
    "reason": "Memory contains important content."
  }
]
\`\`\``,
        },
    ],
};

@injectable()
export class SampleEvaluator extends BaseInjectableEvaluator {
    constructor() {
        super(options);
    }

    async handler(runtime: IAgentRuntime, memory: Memory) {
        // Evaluation logic for the evaluator
        elizaLogger.log("Evaluating data in sampleEvaluator...");
        try {
            if (!memory.content || typeof memory.content.text !== "string") {
                return {
                    score: 0,
                    reason: "Invalid memory content structure",
                };
            }

            if (memory.content.text.includes("important")) {
                elizaLogger.log("Important content found in memory.");
                return {
                    score: 1,
                    reason: "Memory contains important content.",
                };
            } else {
                elizaLogger.log("No important content found in memory.");
                return {
                    score: 0,
                    reason: "Memory does not contain important content.",
                };
            }
        } catch (error) {
            elizaLogger.error("Error in sampleEvaluator:", error);
            throw error;
        }
    }
}

// Register the sample evaluator with the global container
globalContainer.bind(SampleEvaluator).toSelf().inRequestScope();
