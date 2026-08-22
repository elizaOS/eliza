/** Adds trajectory steps around action and provider execution. */

import { ElizaError } from "../../errors";
import { logger } from "../../logger";
import { sanitizeTrajectoryJsonValue } from "../../services/trajectory-json";
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
} from "../../types";
import type { TrajectoriesService } from "./TrajectoriesService";
import type { JsonValue } from "./types";

interface TrajectoryContext {
	trajectoryId: string;
	logger: TrajectoriesService;
}

const trajectoryContexts = new WeakMap<IAgentRuntime, TrajectoryContext>();

/**
 * Origin snapshotted action/provider `state` with JSON.parse(JSON.stringify).
 * StateValue allows arbitrary objects, so a cyclic or over-deep provider
 * value RangeError/TypeError'd *after* the action already succeeded.
 * Use the persistence sanitizer so the live snapshot matches the SQL walk
 * (path-scoped cycles, Dates, bigint/function, item/key/byte caps).
 * A poisoned getter still throws inside that walk — catch it so diagnostics
 * cannot fail the turn (J7).
 */
export function snapshotStateForTrajectory(state: unknown): JsonValue | null {
	if (state === undefined || state === null) return null;
	try {
		return sanitizeTrajectoryJsonValue(state) ?? null;
	} catch (error) {
		// error-policy:J7 snapshot diagnostics must never fail the turn; a
		// poisoned getter degrades the snapshot to null but is surfaced.
		logger.warn(
			`[TrajectoryInterceptor] state snapshot degraded to null: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

export function setTrajectoryContext(
	runtime: IAgentRuntime,
	trajectoryId: string,
	trajectoryLogger: TrajectoriesService,
): void {
	trajectoryContexts.set(runtime, { trajectoryId, logger: trajectoryLogger });
}

export function getTrajectoryContext(
	runtime: IAgentRuntime,
): TrajectoryContext | null {
	return trajectoryContexts.get(runtime) || null;
}

export function clearTrajectoryContext(runtime: IAgentRuntime): void {
	trajectoryContexts.delete(runtime);
}

type ErrorLike = { message?: string };

function requiredTrajectoryString(
	context: Record<string, JsonValue | undefined>,
	field: string,
	options: { allowEmpty?: boolean } = {},
): string {
	const value = context[field];
	if (
		typeof value !== "string" ||
		(!options.allowEmpty && value.trim().length === 0)
	) {
		throw new ElizaError(`Trajectory action context requires ${field}`, {
			code: "INVALID_TRAJECTORY_ACTION_CONTEXT",
			context: { field },
		});
	}
	return value;
}

function trajectoryStringOrEmpty(
	context: Record<string, JsonValue | undefined>,
	field: string,
): string {
	const value = context[field];
	return typeof value === "string" ? value : "";
}

function optionalTrajectoryNumber(
	context: Record<string, JsonValue | undefined>,
	field: string,
): number | undefined {
	const value = context[field];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function requiredTrajectoryData(
	context: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> {
	const value = context.data;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ElizaError("Trajectory provider context requires data", {
			code: "INVALID_TRAJECTORY_PROVIDER_CONTEXT",
		});
	}
	return value;
}

export function wrapActionWithLogging(
	action: Action,
	_trajectoryLogger: TrajectoriesService,
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
		): Promise<ActionResult | undefined> => {
			const context = getTrajectoryContext(runtime);
			if (!context) {
				const result = await originalHandler(
					runtime,
					message,
					state,
					options,
					callback,
				);
				return result ?? undefined;
			}

			const { trajectoryId, logger: loggerService } = context;
			const stepId = loggerService.getCurrentStepId(trajectoryId);

			if (!stepId) {
				logger.warn(
					{ action: action.name, trajectoryId },
					"No active step for action execution",
				);
				const result = await originalHandler(
					runtime,
					message,
					state,
					options,
					callback,
				);
				return result ?? undefined;
			}

			const successHandler = (): void => {
				const stateSnapshot = state ? snapshotStateForTrajectory(state) : null;

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
					{ reward: 0.1 },
				);
			};

			const errorHandler = (err: Error | ErrorLike | string): never => {
				const error =
					err instanceof Error
						? err.message
						: typeof err === "string"
							? err
							: err.message || String(err);

				logger.error(
					{ action: action.name, trajectoryId, error },
					"Action execution failed",
				);

				const stateSnapshot = state ? snapshotStateForTrajectory(state) : null;

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
					{ reward: -0.1 },
				);

				throw err;
			};

			try {
				const result = await originalHandler(
					runtime,
					message,
					state,
					options,
					callback,
				);
				successHandler();
				return result ?? undefined;
			} catch (err) {
				// error-policy:J1 The interceptor converts tool exceptions through the
				// caller-supplied trajectory error boundary.
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
	trajectoryLogger: TrajectoriesService,
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

export function logLLMCallFromAction(
	actionContext: Record<string, JsonValue | undefined>,
	trajectoryLogger: TrajectoriesService,
	trajectoryId: string,
): void {
	const stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
	if (!stepId) {
		logger.warn({ trajectoryId }, "No active step for LLM call from action");
		return;
	}

	trajectoryLogger.logLLMCall(stepId, {
		model: requiredTrajectoryString(actionContext, "model"),
		// Prompt/response are recorded verbatim when present; a pure tool-call
		// leg has NO text response (response is undefined, not ""), and the
		// strict string requirement threw INVALID_TRAJECTORY_ACTION_CONTEXT —
		// dropping exactly the planner legs a trajectory exists to show.
		// Absent text records as "" honestly.
		systemPrompt: trajectoryStringOrEmpty(actionContext, "systemPrompt"),
		userPrompt: trajectoryStringOrEmpty(actionContext, "userPrompt"),
		response: trajectoryStringOrEmpty(actionContext, "response"),
		reasoning:
			typeof actionContext.reasoning === "string"
				? actionContext.reasoning
				: undefined,
		...(typeof actionContext.temperature === "number"
			? { temperature: actionContext.temperature }
			: {}),
		...(typeof actionContext.maxTokens === "number"
			? { maxTokens: actionContext.maxTokens }
			: {}),
		purpose:
			(actionContext.purpose as
				| "action"
				| "reasoning"
				| "evaluation"
				| "response"
				| "other") || "action",
		actionType: (actionContext.actionType as string) || undefined,
		promptTokens: optionalTrajectoryNumber(actionContext, "promptTokens"),
		completionTokens: optionalTrajectoryNumber(
			actionContext,
			"completionTokens",
		),
		latencyMs: optionalTrajectoryNumber(actionContext, "latencyMs"),
	});
}

export function logProviderFromAction(
	actionContext: Record<string, JsonValue | undefined>,
	trajectoryLogger: TrajectoriesService,
	trajectoryId: string,
): void {
	const stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
	if (!stepId) {
		logger.warn(
			{ trajectoryId },
			"No active step for provider access from action",
		);
		return;
	}

	trajectoryLogger.logProviderAccess(stepId, {
		providerName: requiredTrajectoryString(actionContext, "providerName"),
		data: requiredTrajectoryData(actionContext),
		purpose: (actionContext.purpose as string) || "action",
		query:
			actionContext.query &&
			typeof actionContext.query === "object" &&
			!Array.isArray(actionContext.query)
				? actionContext.query
				: undefined,
	});
}

export function wrapProviderWithLogging(
	provider: Provider,
	_trajectoryLogger: TrajectoriesService,
): Provider {
	const originalGet = provider.get;

	return {
		...provider,
		get: async (
			runtime: IAgentRuntime,
			message: Memory,
			state: State,
		): Promise<ProviderResult> => {
			const context = getTrajectoryContext(runtime);
			if (!context) {
				return originalGet(runtime, message, state) || { text: "" };
			}

			const { trajectoryId, logger: loggerService } = context;
			const stepId = loggerService.getCurrentStepId(trajectoryId);

			if (!stepId) {
				logger.warn(
					{ provider: provider.name, trajectoryId },
					"No active step for provider access",
				);
				return originalGet(runtime, message, state) || { text: "" };
			}

			const result = (await originalGet(runtime, message, state)) || {
				text: "",
			};

			const stateSnapshot = state ? snapshotStateForTrajectory(state) : null;

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
	trajectoryLogger: TrajectoriesService,
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
