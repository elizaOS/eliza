/** Adds trajectory steps around action and provider execution. */

import { ElizaError } from "../../errors";
import { logger } from "../../logger";
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

export const TRAJECTORY_STATE_BOUNDED = "[BOUNDED]";
export const MAX_TRAJECTORY_STATE_DEPTH = 16;
export const MAX_TRAJECTORY_STATE_NODES = 2_048;

/**
 * Origin snapshotted action/provider `state` with JSON.parse(JSON.stringify).
 * StateValue allows arbitrary objects, so a cyclic or over-deep provider
 * value RangeError/TypeError'd *after* the action already succeeded.
 * Bound the walk; overflow becomes a sentinel so logging cannot fail the turn.
 */
export function snapshotStateForTrajectory(state: unknown): JsonValue | null {
	if (state === undefined || state === null) return null;
	return walkSnapshot(state, 0, new WeakSet<object>(), { n: 0 }) as JsonValue;
}

function walkSnapshot(
	value: unknown,
	depth: number,
	seen: WeakSet<object>,
	budget: { n: number },
): unknown {
	if (depth > MAX_TRAJECTORY_STATE_DEPTH) return TRAJECTORY_STATE_BOUNDED;
	if (value === null || typeof value !== "object") return value as JsonValue;
	if (seen.has(value)) return TRAJECTORY_STATE_BOUNDED;
	seen.add(value);
	budget.n += 1;
	if (budget.n > MAX_TRAJECTORY_STATE_NODES) return TRAJECTORY_STATE_BOUNDED;
	if (Array.isArray(value)) {
		return value.map((entry) => walkSnapshot(entry, depth + 1, seen, budget));
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		out[key] = walkSnapshot(entry, depth + 1, seen, budget);
	}
	return out;
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
				const stateSnapshot = state
					? snapshotStateForTrajectory(state)
					: null;

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

				const stateSnapshot = state
					? snapshotStateForTrajectory(state)
					: null;

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
		systemPrompt: requiredTrajectoryString(actionContext, "systemPrompt", {
			allowEmpty: true,
		}),
		userPrompt: requiredTrajectoryString(actionContext, "userPrompt", {
			allowEmpty: true,
		}),
		response: requiredTrajectoryString(actionContext, "response", {
			allowEmpty: true,
		}),
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

			const stateSnapshot = state
				? snapshotStateForTrajectory(state)
				: null;

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
