import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { recordExperienceAction } from "./actions/record-experience";
import { experienceEvaluator } from "./evaluators/experienceEvaluator";
import { experienceProvider } from "./providers/experienceProvider";
import { ExperienceService } from "./service";
import "./types";

export const experiencePlugin: Plugin = {
  name: "experience",
  description:
    "Self-learning experience system that records and recalls transferable agent learnings",

  actions: [recordExperienceAction],
  services: [ExperienceService],
  providers: [experienceProvider],
  evaluators: [experienceEvaluator],

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    logger.info("[ExperiencePlugin] Initializing experience learning system");

    const maxExperiences = parseOptionalNumber(config.MAX_EXPERIENCES, 10000);
    const autoRecordThreshold = parseOptionalNumber(config.AUTO_RECORD_THRESHOLD, 0.7);

    runtime.setSetting("MAX_EXPERIENCES", maxExperiences.toString());
    runtime.setSetting("AUTO_RECORD_THRESHOLD", autoRecordThreshold.toString());

    const experienceService = runtime.getService<ExperienceService>("EXPERIENCE");
    experienceService?.setMaxExperiences(maxExperiences);

    logger.info(`[ExperiencePlugin] Configuration:
    - MAX_EXPERIENCES: ${maxExperiences}
    - AUTO_RECORD_THRESHOLD: ${autoRecordThreshold}`);
  },
};

export default experiencePlugin;

export { ExperienceService } from "./service";
export * from "./types";

function parseOptionalNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
