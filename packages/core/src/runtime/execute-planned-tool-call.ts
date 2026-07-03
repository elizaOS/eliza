import { validateToolArgs } from "../actions/validate-tool-args";
import { evaluateConnectorAccountPolicies } from "../connectors/account-manager";
import { checkSenderRole } from "../roles";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "../trajectory-context";
import { withActionStep } from "../trajectory-utils";
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
import { privateActionAllowedOnTurn } from "./private-action-gate";

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
	options: { suppressData?: boolean } = {},
): Record<string, ContentValue> {
	const record: Record<string, ContentValue> = {};
	for (const [key, value] of Object.entries(result)) {
		if (options.suppressData && (key === "data" || key === "values")) {
			record[key] = sensitiveActionResultMarker(value);
			continue;
		}
		record[key] = toContentValue(value);
	}
	return record;
}

function sensitiveActionResultMarker(
	value: unknown,
): Record<string, ContentValue> {
	const actionName =
		isContentRecord(value) && typeof value.actionName === "string"
			? value.actionName
			: undefined;
	return {
		...(actionName ? { actionName } : {}),
		suppressed: true,
		reason: "sensitive_action_result",
	};
}

function readMetadataString(message: Memory, key: string): string | undefined {
	const metadata = isContentRecord(message.metadata) ? message.metadata : null;
	const value = metadata?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function runWithMessageTrajectoryContext<T>(
	runtime: IAgentRuntime,
	message: Memory,
	fn: () => Promise<T> | T,
): Promise<T> | T {
	const activeContext = getTrajectoryContext();
	const trajectoryId = readMetadataString(message, "trajectoryId");
	const runId =
		typeof runtime.getCurrentRunId === "function"
			? runtime.getCurrentRunId()
			: undefined;
	if (
		typeof activeContext?.trajectoryStepId === "string" &&
		activeContext.trajectoryStepId.trim().length > 0
	) {
		if (
			trajectoryId &&
			!(
				typeof activeContext.trajectoryId === "string" &&
				activeContext.trajectoryId.trim().length > 0
			)
		) {
			return runWithTrajectoryContext(
				{
					...activeContext,
					trajectoryId,
					...(runId ? { runId } : {}),
					...(message.roomId ? { roomId: message.roomId } : {}),
					...(message.id ? { messageId: message.id } : {}),
				},
				fn,
			);
		}
		return fn();
	}

	const trajectoryStepId = readMetadataString(message, "trajectoryStepId");
	if (!trajectoryStepId) {
		return fn();
	}

	return runWithTrajectoryContext(
		{
			...activeContext,
			...(trajectoryId ? { trajectoryId } : {}),
			trajectoryStepId,
			...(runId ? { runId } : {}),
			...(message.roomId ? { roomId: message.roomId } : {}),
			...(message.id ? { messageId: message.id } : {}),
		},
		fn,
	);
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
	const validation = validateToolArgs(
		action,
		dropEmptyOptionalArgs(
			action,
			dropUndeclaredPlannerWrapperArgs(action, normalizedArgs),
		),
	);
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
		source: executorCtx.message.content.source,
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
				runtime.logger.warn(
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
		const callback = executorCtx.callback;
		const actionCallback: typeof executorCtx.callback = callback
			? (response, actionName) => callback(response, actionName ?? action.name)
			: undefined;
		const result = await runWithMessageTrajectoryContext(
			runtime,
			executorCtx.message,
			async () => {
				// Egress (#10469): this is the true execution boundary. Restore real
				// secrets into the handler args ONLY here — the model, transcripts, logs,
				// and trajectory upstream kept the placeholders. Fail loud if the model
				// emitted a this-turn placeholder we cannot resolve, so a placeholder is
				// never sent to a real command/connector/endpoint. No-op (and zero cost)
				// when secret-swap is disabled: there is no turn session on the context.
				const secretSwapSession = getTrajectoryContext()?.secretSwapSession;
				if (secretSwapSession && handlerOptions.parameters !== undefined) {
					handlerOptions.parameters = secretSwapSession.restoreInValue(
						handlerOptions.parameters,
						{ failOnUnresolved: true },
					);
				}
				// Egress (#10469 / #7007): restore real named-entity PII here too —
				// including the REPLY action's own text, so the tool call runs against the
				// real recipient and the user sees their real contacts, while the model,
				// trajectory, and logs kept the surrogates. Best-effort (no failOnUnresolved):
				// a surrogate the model rewrote, or a genuinely new name it introduced, is
				// simply left as-is.
				const piiSwapSession = getTrajectoryContext()?.piiSwapSession;
				if (piiSwapSession && handlerOptions.parameters !== undefined) {
					handlerOptions.parameters = piiSwapSession.restoreInValue(
						handlerOptions.parameters,
					);
				}
				return runWithActionRoutingContext(
					{ actionName: action.name, modelClass: action.modelClass },
					() =>
						withActionStep(runtime, action.name, () =>
							action.handler(
								runtime,
								executorCtx.message,
								executorCtx.state,
								handlerOptions,
								actionCallback,
								executorCtx.responses,
							),
						),
				);
			},
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
					actionResult: actionResultToContentRecord(resultForEvent, {
						suppressData: action.suppressActionResultClipboard === true,
					}),
					source: executorCtx.message.content.source,
					error:
						typeof resultForEvent.error === "string"
							? resultForEvent.error
							: undefined,
				},
			})
			.catch((err) => {
				runtime.logger.warn(
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

	return emitToolResult(toolCall, resultForEvent, {
		suppressData: action.suppressActionResultClipboard === true,
	});
}

async function emitToolResult(
	toolCall: PlannerToolCall | PlannedToolCall,
	result: ActionResult,
	options: { suppressData?: boolean } = {},
): Promise<ActionResult> {
	const streamingContext = getStreamingContext();
	const status = result.success ? "completed" : "failed";
	const streamingToolCall = plannedToolCallToStreamingToolCall(
		toolCall,
		status,
	);
	streamingToolCall.result = actionResultToStreamingResult(result, options);
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
		runtime.logger.debug(
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
	options: { suppressData?: boolean } = {},
): ToolCall["result"] {
	return {
		success: result.success,
		text: result.text,
		userFacingText: result.userFacingText,
		verifiedUserFacing: result.verifiedUserFacing,
		error: result.error ? stringifyError(result.error) : undefined,
		data: options.suppressData
			? sensitiveActionResultMarker(result.data)
			: result.data,
		values:
			options.suppressData && result.values !== undefined
				? sensitiveActionResultMarker(result.values)
				: result.values,
		continueChain: result.continueChain,
	} as ToolCall["result"];
}

export const _resetActionRolePolicyCacheForTests = _resetCacheForTests;

/**
 * The single authoritative access gate for running an action's handler.
 * Enforces (in order): the private-action turn gate, ACTION_ROLE_POLICY, the
 * action's contextGate, and the action's roleGate. Returns a human-readable
 * reason string when the action must be blocked, or `undefined` when allowed.
 *
 * Exported so alternate execution entry points (e.g. the pre-LLM shortcut gate
 * in services/message.ts) enforce the exact same policy instead of duplicating
 * it — callers MUST supply already-resolved `ctx.userRoles`.
 */
export function getGateFailure(
	action: Action,
	ctx: ExecutePlannedToolCallContext,
): string | undefined {
	// Private actions may only run inside the agent's own autonomous loop.
	// The planner exposure gate already withholds them on user turns; this is a
	// defense-in-depth backstop so a hallucinated tool call cannot run one.
	if (!privateActionAllowedOnTurn(action, ctx.message)) {
		return `Action ${action.name} is private and can only run in the agent's autonomous loop`;
	}

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
 * Short-form enum completion. When the action has a single closed-enum
 * parameter, accept three input shapes from the planner:
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
 * No-op when the action doesn't fit the single-enum-parameter pattern or when
 * the input doesn't look like a short-form emission.
 */
export function expandEnumShortForm(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
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

/**
 * Treat an empty-string value on a declared OPTIONAL parameter as omitted.
 *
 * Strict tool schemas force the model to emit every key, so `""` is its only
 * way to say "unset" for a parameter it doesn't want (observed live in the
 * #10694 trajectories: the planner emitted `BACKGROUND {preset: ""}` on a
 * color-only turn and enum validation rejected the whole call). Dropping the
 * key before validation restores the intended "omitted" semantics. Required
 * parameters are left untouched so an empty required value still fails loudly.
 */
export function dropEmptyOptionalArgs(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
	let filtered: Record<string, unknown> | undefined;
	for (const parameter of action.parameters ?? []) {
		if (parameter.required === true) continue;
		if (args[parameter.name] === "") {
			filtered ??= { ...args };
			delete filtered[parameter.name];
		}
	}
	return filtered ?? args;
}

const PLANNER_WRAPPER_ONLY_ARG_KEYS = new Set(["subaction", "thought"]);
const PLANNER_DISCRIMINATOR_ALIASES = ["action", "op", "operation"] as const;

function dropUndeclaredPlannerWrapperArgs(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
	let filtered: Record<string, unknown> | undefined;
	const declaredParameters = action.parameters ?? [];

	for (const key of Object.keys(args)) {
		if (
			PLANNER_WRAPPER_ONLY_ARG_KEYS.has(key) &&
			!declaredParameters.some((parameter) => parameter.name === key)
		) {
			filtered ??= { ...args };
			if (key === "subaction" && typeof args.subaction === "string") {
				const target = declaredParameters.find((parameter) => {
					if (
						!PLANNER_DISCRIMINATOR_ALIASES.includes(
							parameter.name as (typeof PLANNER_DISCRIMINATOR_ALIASES)[number],
						)
					) {
						return false;
					}
					const schema = parameter.schema as {
						enumValues?: unknown[];
						enum?: unknown[];
					};
					const enumValues = schema.enumValues ?? schema.enum;
					return (
						!Array.isArray(enumValues) || enumValues.includes(args.subaction)
					);
				});
				if (target && filtered[target.name] === undefined) {
					filtered[target.name] = args.subaction;
					delete filtered[key];
					continue;
				}
				if (
					target &&
					filtered[target.name] !== undefined &&
					filtered[target.name] !== args.subaction
				) {
					continue;
				}
			}
			delete filtered[key];
		}
	}

	return filtered ?? args;
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
