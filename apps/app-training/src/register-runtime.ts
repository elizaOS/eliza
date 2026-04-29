import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { registerSkillScoringCron } from "./core/skill-scoring-cron";
import { registerTrajectoryExportCron } from "./core/trajectory-export-cron";
import {
  bootstrapOptimizationFromAccumulatedTrajectories,
  registerTrainingTriggerService,
} from "./services/training-trigger";

export async function registerTrainingRuntimeHooks(
  runtime: AgentRuntime,
): Promise<void> {
  await registerTrajectoryExportCron(runtime);
  await registerSkillScoringCron(runtime);
  const triggerService = registerTrainingTriggerService(runtime);
  logger.info(
    "[eliza] Registered Track C training crons + auto-train trigger service",
  );

  void bootstrapOptimizationFromAccumulatedTrajectories(runtime, triggerService)
    .then((fired) => {
      if (fired.length > 0) {
        logger.info(
          `[eliza] Bootstrapped prompt optimization for ${fired.join(", ")}`,
        );
      }
    })
    .catch((err) => {
      logger.error(
        `[eliza] bootstrapOptimizationFromAccumulatedTrajectories failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    });
}
