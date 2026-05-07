import { validateToolArgs } from "../actions/validate-tool-args";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import type {
	Action,
	ActionParameters,
	ActionResult,
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

	const gateFailure = getGateFailure(action, ctx);
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

	const previousResults = [...(ctx.previousResults ?? [])];
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

	const messageId = ctx.message.id as UUID | undefined;
	const roomId = ctx.message.roomId as UUID;
	const worldId = (ctx.message.worldId ?? roomId) as UUID;
	const actionStartContent = {
		text: `Executing action: ${action.name}`,
		actions: [action.name],
		actionStatus: "executing" as const,
		source: ctx.message.content?.source,
	};
	if (typeof runtime.emitEvent === "function") {
		await runtime
			.emitEvent(EventType.ACTION_STARTED, {
				runtime,
				messageId,
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
			ctx.message,
			ctx.state,
			handlerOptions,
			ctx.callback,
			ctx.responses,
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
				messageId,
				roomId,
				world: worldId,
				content: {
					text: resultForEvent.text ?? `Action ${action.name} completed`,
					actions: [action.name],
					actionStatus: resultForEvent.success ? "completed" : "failed",
					source: ctx.message.content?.source,
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
		messageId: streamingContext?.messageId,
	});
	return result;
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
