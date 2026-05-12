import type { AgentRuntime } from "@elizaos/core";
import { logger, OptimizedPromptService } from "@elizaos/core";
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
  // Register the OptimizedPromptService so the planner-loop + media handler
  // can pick up artifacts written by `bun run train -- --backend native`
  // (or by the in-runtime trigger service) without operator intervention.
  // Without this, runtime.getService(OPTIMIZED_PROMPT_SERVICE) always
  // returns null and the optimized prompt is never substituted in.
  try {
    const optimizedPromptService = await OptimizedPromptService.start(runtime);
    runtime.registerService(
      OptimizedPromptService as unknown as Parameters<
        typeof runtime.registerService
      >[0],
    );
    // Mutate the runtime's service map so subsequent getService calls
    // hit our pre-warmed instance instead of going through plugin lifecycle.
    (
      runtime as AgentRuntime & {
        services?: Map<string, unknown>;
      }
    ).services?.set(OptimizedPromptService.serviceType, optimizedPromptService);
    logger.info(
      "[eliza] Registered OptimizedPromptService (action_planner / media_description / etc. will pick up artifacts from ~/.eliza/optimized-prompts/)",
    );
  } catch (err) {
    logger.warn(
      `[eliza] OptimizedPromptService registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

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
