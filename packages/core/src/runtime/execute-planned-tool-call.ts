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
import {
	_resetActionRolePolicyCacheForTests as _resetCacheForTests,
	resolveActionRolePolicyRole,
} from "./action-role-policy";
import { runWithActionRoutingContext } from "./action-routing-context";
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

function isContentRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toContentValue(value: unknown): ContentValue {
	if (
		value === undefined ||
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value as ContentValue;
	}
	if (Array.isArray(value)) {
		return value.map(toContentValue);
	}
	if (isContentRecord(value)) {
		const record: Record<string, ContentValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			record[key] = toContentValue(entry);
		}
		return record;
	}
	return String(value);
}

function actionResultToContentRecord(
	result: ActionResult,
): Record<string, ContentValue> {
	const record: Record<string, ContentValue> = {};
	for (const [key, value] of Object.entries(result)) {
		record[key] = toContentValue(value);
	}
	return record;
}

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

	const normalizedArgs = expandEnumShortForm(
		action,
		normalizeToolArgs(toolCall),
	);
	const validation = validateToolArgs(action, normalizedArgs);
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

	if (action.validate) {
		let valid = false;
		try {
			valid = await action.validate(
				runtime,
				executorCtx.message,
				executorCtx.state,
				handlerOptions,
			);
		} catch (error) {
			return emitToolResult(
				toolCall,
				failureResult(action.name, stringifyError(error), { error }),
			);
		}
		if (!valid) {
			return emitToolResult(
				toolCall,
				failureResult(
					action.name,
					`Action ${action.name} is not available for the current state`,
				),
			);
		}
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
		const result = await runWithActionRoutingContext(
			{ actionName: action.name, modelClass: action.modelClass },
			() =>
				action.handler(
					runtime,
					executorCtx.message,
					executorCtx.state,
					handlerOptions,
					executorCtx.callback,
					executorCtx.responses,
				),
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
					actionResult: actionResultToContentRecord(resultForEvent),
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

export const _resetActionRolePolicyCacheForTests = _resetCacheForTests;

function getGateFailure(
	action: Action,
	ctx: ExecutePlannedToolCallContext,
): string | undefined {
	const policyRole = resolveActionRolePolicyRole(action);
	if (policyRole) {
		return satisfiesRoleGate(ctx.userRoles, { minRole: policyRole })
			? undefined
			: `Action ${action.name} is not allowed for the current role`;
	}

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

/**
 * Wave 2-D: short-form enum completion. When `MILADY_SHORT_FORM_ENUMS=1` is
 * set AND the action has a single closed-enum parameter, accept three input
 * shapes from the planner:
 *
 *   1. canonical:        `{ <paramName>: "<enum_value>" }`
 *   2. bare-string:      `"<enum_value>"`  (the entire args is the string)
 *   3. dispatch-shape:   `{ action: <name>, parameters: "<enum_value>" }`
 *
 * Shapes 2 and 3 are expanded into shape 1 here so `validateToolArgs` sees
 * the full JSON-schema shape and strict validation is unchanged. Anything
 * else flows through untouched — including planner emissions that don't
 * match an enum value, which are then caught by `validateToolArgs` and
 * surfaced as a normal failure.
 *
 * No-op when the flag is unset, when the action doesn't fit the
 * single-enum-parameter pattern, or when the input doesn't look like a
 * short-form emission.
 */
export function expandEnumShortForm(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (process.env.MILADY_SHORT_FORM_ENUMS !== "1") return args;
	const parameters = action.parameters ?? [];
	if (parameters.length !== 1) return args;
	const param = parameters[0];
	if (!param) return args;
	const schema = param.schema as {
		enumValues?: unknown[];
		enum?: unknown[];
	};
	const enumValues = schema.enumValues ?? schema.enum;
	if (!Array.isArray(enumValues) || enumValues.length === 0) return args;
	const validValues = new Set(
		enumValues
			.filter(
				(value): value is string | number | boolean =>
					typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean",
			)
			.map((value) => String(value)),
	);
	if (validValues.size === 0) return args;

	// Shape 1: already the canonical shape — nothing to do.
	if (
		typeof args[param.name] === "string" ||
		typeof args[param.name] === "number" ||
		typeof args[param.name] === "boolean"
	) {
		return args;
	}

	// Shape 3: `{ parameters: "<enum_value>" }` — the planner used the
	// PLAN_ACTIONS dispatch envelope with a bare string in `parameters`.
	// Drop the original `parameters` key after expansion so strict
	// validation (which forbids unknown fields when `additionalProperties`
	// is false) doesn't reject the now-canonical args.
	if (
		"parameters" in args &&
		(typeof args.parameters === "string" ||
			typeof args.parameters === "number" ||
			typeof args.parameters === "boolean") &&
		validValues.has(String(args.parameters))
	) {
		const { parameters: shortFormValue, ...rest } = args;
		return { ...rest, [param.name]: shortFormValue };
	}

	return args;
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
