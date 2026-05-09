import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { registerSkillScoringCron } from "./core/skill-scoring-cron";
import { registerTrajectoryExportCron } from "./core/trajectory-export-cron";
import {
  bootstrapOptimizationFromAccumulatedTrajectories,
  registerTrainingTriggerService,
} from "./services/training-trigger";

function trainingCronRegistrationDisabled(): boolean {
  const raw = process.env.ELIZA_DISABLE_TRAINING_CRONS;
  if (!raw) {
    return false;
  }
  return ["1", "true", "yes"].includes(raw.trim().toLowerCase());
}

export async function registerTrainingRuntimeHooks(
  runtime: AgentRuntime,
): Promise<void> {
  const skipCronRegistration = trainingCronRegistrationDisabled();
  if (skipCronRegistration) {
    logger.info("[eliza] Training cron registration skipped");
  } else {
    await registerTrajectoryExportCron(runtime);
    await registerSkillScoringCron(runtime);
  }
  const triggerService = registerTrainingTriggerService(runtime);
  logger.info(
    skipCronRegistration
      ? "[eliza] Registered Track C auto-train trigger service"
      : "[eliza] Registered Track C training crons + auto-train trigger service",
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
