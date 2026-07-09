/**
 * Runtime wiring entry point (`registerTrainingRuntimeHooks`): registers the
 * OptimizedPromptService, the training-config and training-trigger services, and
 * the nightly trajectory-export and skill-scoring crons on an AgentRuntime. The
 * host must call this at agent boot — the plugin does not auto-enable. Cron
 * registration is skipped when `ELIZA_DISABLE_TRAINING_CRONS` is set.
 */
import type { AgentRuntime, PipelineHookSpec, Service } from "@elizaos/core";
import {
  applyOptimizedProviderSelection,
  logger,
  OptimizedPromptService,
  resolveOptimizedContextConfigForRuntime,
} from "@elizaos/core";
import { registerSkillScoringCron } from "./core/skill-scoring-cron.js";
import { registerTrajectoryExportCron } from "./core/trajectory-export-cron.js";
import { registerTrainingConfigService } from "./services/training-config-service.js";
import {
  bootstrapOptimizationFromAccumulatedTrajectories,
  registerTrainingTriggerService,
} from "./services/training-trigger.js";

function trainingCronRegistrationDisabled(): boolean {
  const raw = process.env.ELIZA_DISABLE_TRAINING_CRONS;
  if (!raw) {
    return false;
  }
  return ["1", "true", "yes"].includes(raw.trim().toLowerCase());
}

export const OPTIMIZED_CONTEXT_CONFIG_HOOK_ID =
  "training:optimized-context-config";

export function registerOptimizedContextConfigHook(
  runtime: AgentRuntime,
): void {
  runtime.unregisterPipelineHook(OPTIMIZED_CONTEXT_CONFIG_HOOK_ID);
  const spec: PipelineHookSpec = {
    id: OPTIMIZED_CONTEXT_CONFIG_HOOK_ID,
    phase: "compose_state_providers",
    position: 25,
    mutatesPrimary: true,
    handler: (hookRuntime, ctx) => {
      if (ctx.phase !== "compose_state_providers") return;
      if (ctx.onlyInclude) return;
      const contextConfig =
        resolveOptimizedContextConfigForRuntime(
          hookRuntime,
          "context_routing",
        ) ??
        resolveOptimizedContextConfigForRuntime(hookRuntime, "action_planner");
      if (!contextConfig) return;
      ctx.providers.current = applyOptimizedProviderSelection(
        ctx.providers.current,
        contextConfig,
      );
    },
  };
  runtime.registerPipelineHook(spec);
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
    let optimizedPromptService: Service | null = await runtime
      .getServiceLoadPromise(OptimizedPromptService.serviceType)
      .catch(() => null);
    if (!optimizedPromptService) {
      await runtime.registerService(
        OptimizedPromptService as Parameters<typeof runtime.registerService>[0],
      );
      optimizedPromptService = await runtime.getServiceLoadPromise(
        OptimizedPromptService.serviceType,
      );
    }
    logger.info(
      "[eliza] Registered OptimizedPromptService (action_planner / media_description / etc. will pick up artifacts from <stateDir>/optimized-prompts/)",
    );
  } catch (err) {
    logger.warn(
      `[eliza] OptimizedPromptService registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  registerOptimizedContextConfigHook(runtime);

  const skipCronRegistration = trainingCronRegistrationDisabled();
  if (skipCronRegistration) {
    logger.info("[eliza] Training cron registration skipped");
  } else {
    await registerTrajectoryExportCron(runtime);
    await registerSkillScoringCron(runtime);
  }
  // Contribute the settings extension the host SETTINGS action dispatches
  // `toggle_training` to (looked up by TRAINING_CONFIG_SERVICE name; the host
  // does not import this plugin).
  registerTrainingConfigService(runtime);

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
