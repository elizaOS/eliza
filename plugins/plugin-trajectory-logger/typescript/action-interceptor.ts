/**
 * Action-Level Instrumentation
 *
 * Wraps actions and providers with trajectory logging.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { TrajectoryLoggerService } from "./TrajectoryLoggerService";
import type { JsonValue } from "./types";

interface TrajectoryContext {
  trajectoryId: string;
  logger: TrajectoryLoggerService;
}

const trajectoryContexts = new WeakMap<IAgentRuntime, TrajectoryContext>();

export function setTrajectoryContext(
  runtime: IAgentRuntime,
  trajectoryId: string,
  trajectoryLogger: TrajectoryLoggerService
): void {
  trajectoryContexts.set(runtime, { trajectoryId, logger: trajectoryLogger });
}

export function getTrajectoryContext(runtime: IAgentRuntime): TrajectoryContext | null {
  return trajectoryContexts.get(runtime) || null;
}

export function clearTrajectoryContext(runtime: IAgentRuntime): void {
  trajectoryContexts.delete(runtime);
}

type ErrorLike = { message?: string };

export function wrapActionWithLogging(
  action: Action,
  _trajectoryLogger: TrajectoryLoggerService
): Action {
  const originalHandler = action.handler;

  return {
    ...action,
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      state?: State,
      options?: HandlerOptions,
      callback?: HandlerCallback
    ): Promise<ActionResult | undefined> => {
      const context = getTrajectoryContext(runtime);
      if (!context) {
        const result = await originalHandler(runtime, message, state, options, callback);
        return result ?? undefined;
      }

      const { trajectoryId, logger: loggerService } = context;
      const stepId = loggerService.getCurrentStepId(trajectoryId);

      if (!stepId) {
        logger.warn({ action: action.name, trajectoryId }, "No active step for action execution");
        const result = await originalHandler(runtime, message, state, options, callback);
        return result ?? undefined;
      }

      const successHandler = (): void => {
        const stateSnapshot = state ? (JSON.parse(JSON.stringify(state)) as JsonValue) : null;

        loggerService.completeStep(
          trajectoryId,
          stepId,
          {
            actionType: action.name,
            actionName: action.name,
            parameters: {
              message: message.content.text || "",
              state: stateSnapshot,
            },
            success: true,
            result: { executed: true },
            reasoning: `Action ${action.name} executed via ${action.description || "handler"}`,
          },
          { reward: 0.1 }
        );
      };

      const errorHandler = (err: Error | ErrorLike | string): never => {
        const error =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : err.message || String(err);

        logger.error({ action: action.name, trajectoryId, error }, "Action execution failed");

        const stateSnapshot = state ? (JSON.parse(JSON.stringify(state)) as JsonValue) : null;

        loggerService.completeStep(
          trajectoryId,
          stepId,
          {
            actionType: action.name,
            actionName: action.name,
            parameters: {
              message: message.content.text || "",
              state: stateSnapshot,
            },
            success: false,
            result: { error },
            reasoning: `Action ${action.name} failed: ${error}`,
          },
          { reward: -0.1 }
        );

        throw err;
      };

      try {
        const result = await originalHandler(runtime, message, state, options, callback);
        successHandler();
        return result ?? undefined;
      } catch (err) {
        if (err instanceof Error) {
          return errorHandler(err);
        }
        if (typeof err === "string") {
          return errorHandler(err);
        }
        return errorHandler(err as ErrorLike);
      }
    },
  };
}

export function wrapPluginActions(
  plugin: Plugin,
  trajectoryLogger: TrajectoryLoggerService
): Plugin {
  if (!plugin.actions || plugin.actions.length === 0) {
    return plugin;
  }

  return {
    ...plugin,
    actions: plugin.actions.map((action) => wrapActionWithLogging(action, trajectoryLogger)),
  };
}

export function logLLMCallFromAction(
  actionContext: Record<string, JsonValue | undefined>,
  trajectoryLogger: TrajectoryLoggerService,
  trajectoryId: string
): void {
  const stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
  if (!stepId) {
    logger.warn({ trajectoryId }, "No active step for LLM call from action");
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
      (actionContext.purpose as "action" | "reasoning" | "evaluation" | "response" | "other") ||
      "action",
    actionType: (actionContext.actionType as string) || undefined,
    promptTokens: (actionContext.promptTokens as number) || undefined,
    completionTokens: (actionContext.completionTokens as number) || undefined,
    latencyMs: (actionContext.latencyMs as number) || undefined,
  });
}

export function logProviderFromAction(
  actionContext: Record<string, JsonValue | undefined>,
  trajectoryLogger: TrajectoryLoggerService,
  trajectoryId: string
): void {
  const stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
  if (!stepId) {
    logger.warn({ trajectoryId }, "No active step for provider access from action");
    return;
  }

  trajectoryLogger.logProviderAccess(stepId, {
    providerName: (actionContext.providerName as string) || "unknown",
    data: (actionContext.data as Record<string, JsonValue>) || {},
    purpose: (actionContext.purpose as string) || "action",
    query: (actionContext.query as Record<string, JsonValue>) || undefined,
  });
}

export function wrapProviderWithLogging(
  provider: Provider,
  _trajectoryLogger: TrajectoryLoggerService
): Provider {
  const originalGet = provider.get;

  return {
    ...provider,
    get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
      const context = getTrajectoryContext(runtime);
      if (!context) {
        return originalGet?.(runtime, message, state) || { text: "" };
      }

      const { trajectoryId, logger: loggerService } = context;
      const stepId = loggerService.getCurrentStepId(trajectoryId);

      if (!stepId) {
        logger.warn(
          { provider: provider.name, trajectoryId },
          "No active step for provider access"
        );
        return originalGet?.(runtime, message, state) || { text: "" };
      }

      const result = (await originalGet?.(runtime, message, state)) || { text: "" };

      const stateSnapshot = state ? (JSON.parse(JSON.stringify(state)) as JsonValue) : null;

      loggerService.logProviderAccess(stepId, {
        providerName: provider.name,
        data: {
          text: result.text || "",
          success: true,
        },
        purpose: `Provider ${provider.name} accessed for context`,
        query: {
          message: message.content.text || "",
          state: stateSnapshot,
        },
      });

      return result;
    },
  };
}

export function wrapPluginProviders(
  plugin: Plugin,
  trajectoryLogger: TrajectoryLoggerService
): Plugin {
  if (!plugin.providers || plugin.providers.length === 0) {
    return plugin;
  }

  return {
    ...plugin,
    providers: plugin.providers.map((provider) =>
      wrapProviderWithLogging(provider, trajectoryLogger)
    ),
  };
}
