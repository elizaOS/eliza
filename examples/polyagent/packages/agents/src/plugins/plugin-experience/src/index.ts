import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { JsonValue } from "@polyagent/shared";
import { experienceEvaluator } from "./evaluators/experienceEvaluator";
import { marketOutcomeEvaluator } from "./evaluators/marketOutcomeEvaluator";
import { experienceProvider } from "./providers/experienceProvider";
import { ExperienceService } from "./service";
import "./types"; // Ensure module augmentation is loaded

export const experiencePlugin: Plugin = {
  name: "experience",
  description:
    "Self-learning experience system that records experiences, learns from agent interactions, and tracks NPC trust & performance",

  services: [ExperienceService],

  providers: [experienceProvider],

  evaluators: [
    experienceEvaluator, // Learns from conversations
    marketOutcomeEvaluator, // Learns from market outcomes (trust + performance)
  ],

  init: async (config: Record<string, JsonValue>, runtime: IAgentRuntime) => {
    void runtime; // Runtime currently unused during initialization

    logger.info(
      "[ExperiencePlugin] Initializing self-learning experience system",
    );

    const maxExperiences = (config.maxExperiences as number) || 10000;
    const autoRecordThreshold = (config.autoRecordThreshold as number) || 0.7;

    logger.info(`[ExperiencePlugin] Configuration read:
    - Max experiences: ${maxExperiences}
    - Auto-record threshold: ${autoRecordThreshold}`);
  },
};

// Export individual components for testing
export { ExperienceService } from "./service";
export * from "./types";

export default experiencePlugin;
