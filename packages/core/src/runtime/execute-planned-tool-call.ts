import { validateToolArgs } from "../actions/validate-tool-args";
import { evaluateConnectorAccountPolicies } from "../connectors/account-manager";
import { checkSenderRole } from "../roles";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import type {
	Action,
	ActionParameters,
	ActionResult,
	ContentValue,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	StreamChunkCallback,
} from "../types";
import type { AgentContext, RoleGate, RoleGateRole } from "../types/contexts";
import { EventType } from "../types/events";
import type { ToolCall } from "../types/model";
import type { UUID } from "../types/primitives";
import type { State } from "../types/state";
import { satisfiesContextGate, satisfiesRoleGate } from "./context-gates";
import { parseJsonObject } from "./json-output";
import type { PlannerToolCall } from "./planner-loop";

export interface PlannedToolCall {
	id?: string;
	name: string;
	params?: Record<string, unknown>;
	args?: unknown;
	arguments?: unknown;
}

export interface ExecutePlannedToolCallContext {
	message: Memory;
	state?: State;
	activeContexts?: readonly AgentContext[];
	userRoles?: readonly RoleGateRole[];
	previousResults?: readonly ActionResult[];
	callback?: Parameters<Action["handler"]>[4];
	responses?: Memory[];
}

export type ExecutePlannedToolCallOptions = HandlerOptions & {
	actions?: readonly Action[];
	onStreamChunk?: StreamChunkCallback;
};

export async function executePlannedToolCall(
	runtime: IAgentRuntime,
	ctx: ExecutePlannedToolCallContext,
	toolCall: PlannerToolCall | PlannedToolCall,
	options: ExecutePlannedToolCallOptions = {},
): Promise<ActionResult> {
	const action = (options.actions ?? runtime.actions).find(
		(candidate) => candidate.name === toolCall.name,
	);
	if (!action) {
		return emitToolResult(
			toolCall,
			failureResult(toolCall.name, `Action not found: ${toolCall.name}`),
		);
	}

	const executorCtx = await withResolvedUserRoles(runtime, ctx);
	const gateFailure = getGateFailure(action, executorCtx);
	if (gateFailure) {
		return emitToolResult(toolCall, failureResult(action.name, gateFailure));
	}

	const validation = validateToolArgs(action, normalizeToolArgs(toolCall));
	if (!validation.valid) {
		return emitToolResult(
			toolCall,
			failureResult(
				action.name,
				validation.errors.join("; ") ||
					`Invalid arguments for action ${action.name}`,
				{ parameterErrors: validation.errors },
			),
		);
	}
	const accountPolicy = await evaluateConnectorAccountPolicies(
		runtime,
		action,
		{
			message: executorCtx.message,
			parameters: validation.args as Record<string, unknown>,
		},
	);
	if (!accountPolicy.allowed) {
		return emitToolResult(
			toolCall,
			failureResult(
				action.name,
				accountPolicy.reason ??
					`Action ${action.name} is not allowed for the selected connector account`,
			),
		);
	}

	const previousResults = [...(executorCtx.previousResults ?? [])];
	const parameters =
		action.parameters && action.parameters.length > 0
			? (validation.args as ActionParameters | undefined)
			: undefined;
	const { actions: _scopedActions, ...handlerOptionOverrides } = options;
	const handlerOptions: HandlerOptions = {
		...handlerOptionOverrides,
		parameters,
		parameterErrors: undefined,
		actionContext: options.actionContext ?? {
			previousResults,
			getPreviousResult: (actionName: string) =>
				previousResults.find(
					(result) => result.data?.actionName === actionName,
				),
		},
	};

	const messageId = executorCtx.message.id as UUID | undefined;
	const roomId = executorCtx.message.roomId as UUID;
	const worldId = (executorCtx.message.worldId ?? roomId) as UUID;
	const actionStartContent = {
		text: `Executing action: ${action.name}`,
		actions: [action.name],
		actionStatus: "executing" as const,
		source: executorCtx.message.content?.source,
	};
	if (typeof runtime.emitEvent === "function") {
		await runtime
			.emitEvent(EventType.ACTION_STARTED, {
				runtime,
				...(messageId ? { messageId } : {}),
				roomId,
				world: worldId,
				content: actionStartContent,
			})
			.catch((err) => {
				runtime.logger?.warn?.(
					{
						src: "execute-planned-tool-call",
						action: action.name,
						eventType: EventType.ACTION_STARTED,
						err: err instanceof Error ? err.message : String(err),
					},
					"emitEvent failed",
				);
			});
	}

	let resultForEvent: ActionResult;
	try {
		const result = await action.handler(
			runtime,
			executorCtx.message,
			executorCtx.state,
			handlerOptions,
			executorCtx.callback,
			executorCtx.responses,
		);
		resultForEvent = normalizeActionResult(action.name, result);
	} catch (error) {
		resultForEvent = failureResult(action.name, stringifyError(error), {
			error,
		});
	}

	if (typeof runtime.emitEvent === "function") {
		await runtime
			.emitEvent(EventType.ACTION_COMPLETED, {
				runtime,
				...(messageId ? { messageId } : {}),
				roomId,
				world: worldId,
				content: {
					text: resultForEvent.text ?? `Action ${action.name} completed`,
					actions: [action.name],
					actionStatus: resultForEvent.success ? "completed" : "failed",
					actionResult: resultForEvent as unknown as {
						[key: string]: ContentValue;
					},
					source: executorCtx.message.content?.source,
					error:
						typeof resultForEvent.error === "string"
							? resultForEvent.error
							: undefined,
				},
			})
			.catch((err) => {
				runtime.logger?.warn?.(
					{
						src: "execute-planned-tool-call",
						action: action.name,
						eventType: EventType.ACTION_COMPLETED,
						err: err instanceof Error ? err.message : String(err),
					},
					"emitEvent failed",
				);
			});
	}

	return emitToolResult(toolCall, resultForEvent);
}

async function emitToolResult(
	toolCall: PlannerToolCall | PlannedToolCall,
	result: ActionResult,
): Promise<ActionResult> {
	const streamingContext = getStreamingContext();
	const status = result.success ? "completed" : "failed";
	const streamingToolCall = plannedToolCallToStreamingToolCall(
		toolCall,
		status,
	);
	streamingToolCall.result = actionResultToStreamingResult(result);
	await emitStreamingHook(streamingContext, "onToolResult", {
		toolCall: streamingToolCall,
		toolCallId: streamingToolCall.id,
		result: streamingToolCall.result,
		status,
		...(streamingContext?.messageId
			? { messageId: streamingContext.messageId }
			: {}),
	});
	return result;
}

async function withResolvedUserRoles(
	runtime: IAgentRuntime,
	ctx: ExecutePlannedToolCallContext,
): Promise<ExecutePlannedToolCallContext> {
	if (ctx.userRoles?.length) {
		return ctx;
	}
	return {
		...ctx,
		userRoles: await resolveToolCallUserRoles(runtime, ctx.message),
	};
}

async function resolveToolCallUserRoles(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<RoleGateRole[]> {
	if (
		typeof message.entityId === "string" &&
		message.entityId === runtime.agentId
	) {
		return ["OWNER"];
	}

	try {
		const result = await checkSenderRole(runtime, message);
		if (result?.role) {
			return [result.role as RoleGateRole];
		}
	} catch (error) {
		runtime.logger?.debug?.(
			{
				src: "execute-planned-tool-call",
				error: error instanceof Error ? error.message : String(error),
			},
			"sender role lookup failed; defaulting to USER",
		);
	}

	return ["USER"];
}

function plannedToolCallToStreamingToolCall(
	toolCall: PlannerToolCall | PlannedToolCall,
	status: "completed" | "failed",
): ToolCall {
	return {
		id: toolCall.id ?? toolCall.name,
		name: toolCall.name,
		arguments: normalizeToolArgs(toolCall) as ToolCall["arguments"],
		status,
	};
}

function actionResultToStreamingResult(
	result: ActionResult,
): ToolCall["result"] {
	return {
		success: result.success,
		text: result.text,
		error: result.error ? stringifyError(result.error) : undefined,
		data: result.data,
		values: result.values,
		continueChain: result.continueChain,
	} as ToolCall["result"];
}

function getGateFailure(
	action: Action,
	ctx: ExecutePlannedToolCallContext,
): string | undefined {
	const contextGate = action.contextGate ?? {
		contexts: action.contexts,
		roleGate: action.roleGate,
	};

	if (!satisfiesContextGate(ctx.activeContexts, contextGate, ctx.userRoles)) {
		return `Action ${action.name} is not allowed in the current context`;
	}

	if (
		!satisfiesRoleGate(ctx.userRoles, action.roleGate as RoleGate | undefined)
	) {
		return `Action ${action.name} is not allowed for the current role`;
	}

	return undefined;
}

function normalizeToolArgs(
	toolCall: PlannerToolCall | PlannedToolCall,
): Record<string, unknown> {
	const raw =
		"params" in toolCall && toolCall.params !== undefined
			? toolCall.params
			: "args" in toolCall && toolCall.args !== undefined
				? toolCall.args
				: "arguments" in toolCall
					? toolCall.arguments
					: undefined;

	if (typeof raw === "string") {
		return parseJsonObject<Record<string, unknown>>(raw) ?? {};
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	return {};
}

function normalizeActionResult(
	actionName: string,
	result: unknown,
): ActionResult {
	const rawResult = result as ActionResult | boolean | null | undefined;
	if (
		rawResult === undefined ||
		rawResult === null ||
		typeof rawResult === "boolean"
	) {
		return {
			success: rawResult !== false,
			data: { actionName },
		};
	}

	const resultData =
		typeof rawResult.data === "object" &&
		rawResult.data !== null &&
		!Array.isArray(rawResult.data)
			? rawResult.data
			: {};

	return {
		...rawResult,
		success: "success" in rawResult ? rawResult.success : true,
		data: {
			actionName,
			...resultData,
		},
	};
}

function failureResult(
	actionName: string,
	message: string,
	extraData: Record<string, unknown> = {},
): ActionResult {
	return {
		success: false,
		text: message,
		error: message,
		data: {
			actionName,
			...extraData,
		},
	};
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
