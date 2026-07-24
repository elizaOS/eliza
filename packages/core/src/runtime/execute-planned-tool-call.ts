/**
 * Executes one planner-selected tool call against its Action: resolves the
 * action, applies role and connector-account gates, normalizes and validates
 * the args, restores real secrets/PII at the egress boundary, runs the handler
 * inside the trajectory / action-routing context, and emits ACTION_STARTED /
 * ACTION_COMPLETED around a normalized ActionResult.
 */
import { validateToolArgs } from "../actions/validate-tool-args";
import { evaluateConnectorAccountPolicies } from "../connectors/account-manager";
import { checkSenderRole } from "../roles";
import {
	emitStreamingHook,
	getStreamingContext,
	runWithSuppressedModelStream,
} from "../streaming-context";
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
import type { AgentContext, RoleGateRole } from "../types/contexts";
import { EventType } from "../types/events";
import type { ToolCall } from "../types/model";
import type { UUID } from "../types/primitives";
import type { State } from "../types/state";
import { actionGateFailure } from "./action-gate";
import { _resetActionRolePolicyCacheForTests as _resetCacheForTests } from "./action-role-policy";
import { runWithActionRoutingContext } from "./action-routing-context";
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

/**
 * A result may opt out per invocation because multi-mode actions only return
 * sensitive data for some operations. Static action metadata remains the
 * stronger default for actions whose every result is sensitive.
 */
export function shouldSuppressActionResultClipboard(
	action: Pick<Action, "suppressActionResultClipboard"> | undefined,
	result: { data?: Readonly<Record<string, unknown>> },
): boolean {
	return (
		action?.suppressActionResultClipboard === true ||
		result.data?.suppressActionResultClipboard === true
	);
}

/**
 * Keep the outcome and intentional user-facing projections while removing the
 * structured payload that must not enter planner prompts or client clipboards.
 */
export function projectActionResultForClipboard(
	action: Pick<Action, "name" | "suppressActionResultClipboard"> | undefined,
	result: ActionResult,
	actionName = action?.name,
): ActionResult {
	if (!shouldSuppressActionResultClipboard(action, result)) {
		return result;
	}

	const resultActionName =
		typeof result.data?.actionName === "string"
			? result.data.actionName
			: undefined;
	const safeActionName = actionName ?? resultActionName;
	return {
		success: result.success,
		...(result.text !== undefined ? { text: result.text } : {}),
		...(result.transcriptVisibility !== undefined
			? { transcriptVisibility: result.transcriptVisibility }
			: {}),
		...(result.userFacingText !== undefined
			? { userFacingText: result.userFacingText }
			: {}),
		...(result.verifiedUserFacing !== undefined
			? { verifiedUserFacing: result.verifiedUserFacing }
			: {}),
		...(safeActionName ? { data: { actionName: safeActionName } } : {}),
		...(result.turnComplete !== undefined
			? { turnComplete: result.turnComplete }
			: {}),
		...(result.continueChain !== undefined
			? { continueChain: result.continueChain }
			: {}),
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
	const gateFailure = actionGateFailure(action, executorCtx);
	if (gateFailure) {
		return emitToolResult(toolCall, failureResult(action.name, gateFailure));
	}

	const normalizedArgs = expandEnumShortForm(
		action,
		flattenUndeclaredParametersEnvelope(action, normalizeToolArgs(toolCall)),
	);
	const validation = validateToolArgs(
		action,
		normalizeParamAliases(
			action,
			dropEmptyOptionalArgs(
				action,
				dropUndeclaredPlannerWrapperArgs(action, normalizedArgs),
			),
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
							runWithSuppressedModelStream(() =>
								action.handler(
									runtime,
									executorCtx.message,
									executorCtx.state,
									handlerOptions,
									actionCallback,
									executorCtx.responses,
								),
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
	const suppressActionResult = shouldSuppressActionResultClipboard(
		action,
		resultForEvent,
	);

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
						suppressData: suppressActionResult,
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
		suppressData: suppressActionResult,
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
		turnComplete: result.turnComplete,
		continueChain: result.continueChain,
	} as ToolCall["result"];
}

export const _resetActionRolePolicyCacheForTests = _resetCacheForTests;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Recover the hybrid native-call shape weak models produce after copying the
 * plain-JSON planner envelope into a tool's argument object. The unwrap is
 * intentionally schema-bounded: a real `parameters` field, an unknown nested
 * key, or a conflicting duplicate stays untouched so strict validation still
 * surfaces the malformed call instead of guessing at intent.
 */
function flattenUndeclaredParametersEnvelope(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const declaredParameters = action.parameters ?? [];
	if (declaredParameters.some((parameter) => parameter.name === "parameters")) {
		return args;
	}

	const nested = args.parameters;
	if (!isPlainRecord(nested)) return args;

	const declaredNames = new Set(
		declaredParameters.map((parameter) => parameter.name),
	);
	const nestedEntries = Object.entries(nested);
	if (nestedEntries.some(([key]) => !declaredNames.has(key))) return args;
	if (
		nestedEntries.some(
			([key, value]) =>
				Object.hasOwn(args, key) && !Object.is(args[key], value),
		)
	) {
		return args;
	}

	const { parameters: _parameters, ...outerArgs } = args;
	return { ...nested, ...outerArgs };
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
	// Strict provider schemas can force placeholder values for every property.
	// Non-strict polymorphic tools preserve optional empty strings because the
	// resolved child contract may define "" as an intentional mutation.
	if (action.toolSchemaStrict === false) return args;

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

/**
 * Rename an incoming arg key to the declared parameter that claims it via its
 * `aliases` list, so the planner isn't punished for a natural name variant
 * (`to`/`recipient` for `target`, `description`/`prompt` for `instructions`,
 * `scheduledFor` for `scheduledAtIso`). This is the same curated,
 * structurally-gated remap the sibling `dropUndeclaredPlannerWrapperArgs`
 * already performs for the `subaction`→discriminator shape.
 *
 * SAFETY: only renames a key to a declared param that explicitly claims it, and
 * only when (a) that param is absent from args, (b) the key is not itself a
 * declared param, and (c) exactly one declared param claims the key. Any arg no
 * param's `aliases` claims flows through untouched and still hits
 * `Unexpected argument` in `validateToolArgs` — the runaway-arg bound and its
 * tests are unaffected. Never clobbers an explicitly-provided canonical value.
 */
export function normalizeParamAliases(
	action: Action,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const parameters = action.parameters ?? [];
	const hasAliases = parameters.some((p) => p.aliases && p.aliases.length > 0);
	if (!hasAliases) return args;

	const declaredNames = new Set(parameters.map((p) => p.name));
	let renamed: Record<string, unknown> | undefined;

	for (const key of Object.keys(args)) {
		if (declaredNames.has(key)) continue; // key is itself a real param
		const claimants = parameters.filter((p) => p.aliases?.includes(key));
		if (claimants.length !== 1) continue; // unknown, or ambiguous → let it reject
		const target = claimants[0].name;
		// Don't overwrite a canonical value the planner already provided.
		const current = (renamed ?? args)[target];
		if (current !== undefined && current !== null) continue;
		renamed ??= { ...args };
		renamed[target] = renamed[key];
		delete renamed[key];
	}

	return renamed ?? args;
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
