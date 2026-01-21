/**
 * Action-Level Instrumentation
 *
 * Wraps actions with trajectory logging
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";
import type { JsonValue } from "@polyagent/shared";
import { logger } from "../../../shared/logger";
import type { TrajectoryLoggerService } from "./TrajectoryLoggerService";

/**
 * Context for trajectory logging during action execution
 */
interface TrajectoryContext {
  trajectoryId: string;
  logger: TrajectoryLoggerService;
}

// Global context storage (per runtime instance)
const trajectoryContexts = new WeakMap<IAgentRuntime, TrajectoryContext>();

/**
 * Set trajectory context for a runtime
 */
export function setTrajectoryContext(
  runtime: IAgentRuntime,
  trajectoryId: string,
  trajectoryLogger: TrajectoryLoggerService,
): void {
  trajectoryContexts.set(runtime, { trajectoryId, logger: trajectoryLogger });
}

/**
 * Get trajectory context for a runtime
 */
export function getTrajectoryContext(
  runtime: IAgentRuntime,
): TrajectoryContext | null {
  return trajectoryContexts.get(runtime) || null;
}

/**
 * Clear trajectory context for a runtime
 * Should be called after ending a trajectory to prevent stale context
 */
export function clearTrajectoryContext(runtime: IAgentRuntime): void {
  trajectoryContexts.delete(runtime);
}

/**
 * Wrap an action with logging
 */
export function wrapActionWithLogging(
  action: Action,
  _trajectoryLogger: TrajectoryLoggerService,
): Action {
  const originalHandler = action.handler;

  return {
    ...action,
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      state?: State,
      options?: HandlerOptions,
      callback?: HandlerCallback,
    ): Promise<void> => {
      const context = getTrajectoryContext(runtime);
      if (!context) {
        // No trajectory context - execute without logging
        if (originalHandler) {
          await originalHandler(runtime, message, state, options, callback);
        }
        return;
      }

      const { trajectoryId, logger: loggerService } = context;
      const stepId = loggerService.getCurrentStepId(trajectoryId);

      if (!stepId) {
        logger.warn("No active step for action execution", {
          action: action.name,
          trajectoryId,
        });
        if (originalHandler) {
          await originalHandler(runtime, message, state, options, callback);
        }
        return;
      }

      // Handle success case
      const successHandler = (): void => {
        loggerService.completeStep(
          trajectoryId,
          stepId,
          {
            actionType: action.name,
            actionName: action.name,
            parameters: {
              message: message.content.text || "",
              state: state ? JSON.parse(JSON.stringify(state)) : undefined,
            },
            success: true,
            result: { executed: true },
            reasoning: `Action ${action.name} executed via ${action.description || "handler"}`,
          },
          {
            reward: 0.1, // Small reward for successful execution
          },
        );
      };

      // Handle error case
      const errorHandler = (err: unknown): never => {
        const error = err instanceof Error ? err.message : String(err);
        logger.error(
          "Action execution failed",
          {
            action: action.name,
            trajectoryId,
            error,
          },
          "ActionInterceptor",
        );

        loggerService.completeStep(
          trajectoryId,
          stepId,
          {
            actionType: action.name,
            actionName: action.name,
            parameters: {
              message: message.content.text || "",
              state: state ? JSON.parse(JSON.stringify(state)) : undefined,
            },
            success: false,
            result: { error },
            reasoning: `Action ${action.name} failed: ${error}`,
          },
          {
            reward: -0.1, // Negative reward for failed execution
          },
        );

        throw err;
      };

      // Execute action and handle both success and error cases
      if (originalHandler) {
        await originalHandler(runtime, message, state, options, callback).then(
          successHandler,
          errorHandler,
        );
      } else {
        successHandler();
      }
    },
  };
}

/**
 * Wrap all plugin actions
 */
export function wrapPluginActions(
  plugin: Plugin,
  trajectoryLogger: TrajectoryLoggerService,
): Plugin {
  if (!plugin.actions || plugin.actions.length === 0) {
    return plugin;
  }

  return {
    ...plugin,
    actions: plugin.actions.map((action) =>
      wrapActionWithLogging(action, trajectoryLogger),
    ),
  };
}

/**
 * Log LLM call from action context
 */
export function logLLMCallFromAction(
  actionContext: Record<string, JsonValue | undefined>,
  trajectoryLogger: TrajectoryLoggerService,
  trajectoryId: string,
): void {
  const stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
  if (!stepId) {
    logger.warn("No active step for LLM call from action", { trajectoryId });
    return;
  }

  trajectoryLogger.logLLMCall(stepId, {
    model: (actionContext.model as string) || "unknown",
    systemPrompt: (actionContext.systemPrompt as string) || "",
    userPrompt: (actionContext.userPrompt as string) || "",
    response: (actionContext.response as string) || "",
    reasoning: (actionContext.reasoning as string) || undefined,
    temperature: (actionContext.temperature as number) || 0.7,
    maxTokens: (actionContext.maxTokens as number) || 8192,
    purpose:
      (actionContext.purpose as
        | "action"
        | "reasoning"
        | "evaluation"
        | "response"
        | "other") || "action",
    actionType: (actionContext.actionType as string) || undefined,
    promptTokens: (actionContext.promptTokens as number) || undefined,
    completionTokens: (actionContext.completionTokens as number) || undefined,
    latencyMs: (actionContext.latencyMs as number) || undefined,
  });
}

/**
 * Log provider access from action context
 */
export function logProviderFromAction(
  actionContext: Record<string, JsonValue | undefined>,
  trajectoryLogger: TrajectoryLoggerService,
  trajectoryId: string,
): void {
  const stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
  if (!stepId) {
    logger.warn("No active step for provider access from action", {
      trajectoryId,
    });
    return;
  }

  trajectoryLogger.logProviderAccess(stepId, {
    providerName: (actionContext.providerName as string) || "unknown",
    data:
      (actionContext.data as Record<string, JsonValue>) ||
      ({} as Record<string, JsonValue>),
    purpose: (actionContext.purpose as string) || "action",
    query: (actionContext.query as Record<string, JsonValue>) || undefined,
  });
}

/**
 * Wrap a provider with trajectory logging
 */
export function wrapProviderWithLogging(
  provider: import("@elizaos/core").Provider,
  _trajectoryLogger: TrajectoryLoggerService,
): import("@elizaos/core").Provider {
  const originalGet = provider.get;

  return {
    ...provider,
    get: async (
      runtime: IAgentRuntime,
      message: Memory,
      state: State,
    ): Promise<import("@elizaos/core").ProviderResult> => {
      const context = getTrajectoryContext(runtime);
      if (!context) {
        // No trajectory context - execute without logging
        return originalGet?.(runtime, message, state) || { text: "" };
      }

      const { trajectoryId, logger: loggerService } = context;
      const stepId = loggerService.getCurrentStepId(trajectoryId);

      if (!stepId) {
        logger.warn("No active step for provider access", {
          provider: provider.name,
          trajectoryId,
        });
        return originalGet?.(runtime, message, state) || { text: "" };
      }

      const result = (await originalGet?.(runtime, message, state)) || {
        text: "",
      };
      // Log provider access on success
      loggerService.logProviderAccess(stepId, {
        providerName: provider.name,
        data: {
          text: result.text || "",
          success: true,
        },
        purpose: `Provider ${provider.name} accessed for context`,
        query: {
          message: message.content.text || "",
          state: state ? JSON.parse(JSON.stringify(state)) : undefined,
        },
      });

      return result;
    },
  };
}

/**
 * Wrap all plugin providers with trajectory logging
 */
export function wrapPluginProviders(
  plugin: Plugin,
  trajectoryLogger: TrajectoryLoggerService,
): Plugin {
  if (!plugin.providers || plugin.providers.length === 0) {
    return plugin;
  }

  return {
    ...plugin,
    providers: plugin.providers.map((provider) =>
      wrapProviderWithLogging(provider, trajectoryLogger),
    ),
  };
}
