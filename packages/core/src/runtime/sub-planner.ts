import { actionToJsonSchema } from "../actions/action-schema";
import { PLAN_ACTIONS_TOOL, PLAN_ACTIONS_TOOL_NAME } from "../actions/to-tool";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import type { Action, ActionResult, IAgentRuntime } from "../types";
import type { ContextEvent, ContextObject } from "../types/context-object";
import type { JSONSchema, ToolDefinition } from "../types/model";
import {
	type ExecutePlannedToolCallContext,
	type ExecutePlannedToolCallOptions,
	executePlannedToolCall,
} from "./execute-planned-tool-call";
import {
	actionResultToPlannerToolResult,
	type PlannerLoopParams,
	type PlannerLoopResult,
	type PlannerRuntime,
	type PlannerToolCall,
	runPlannerLoop,
} from "./planner-loop";
import type { RecordedStage, TrajectoryRecorder } from "./trajectory-recorder";

/**
 * Unwrap a `PLAN_ACTIONS` tool call into its target action. Mirrors the
 * helper in services/message.ts — duplicated here to keep the sub-planner
 * import surface tight (no cycle through services).
 *
 * Preserves the optional `subaction` hint on `params.subaction` for
 * router-style actions.
 */
function unwrapSubPlannerToolCall(toolCall: PlannerToolCall): PlannerToolCall {
	if (toolCall.name !== PLAN_ACTIONS_TOOL_NAME) {
		return toolCall;
	}
	const params = toolCall.params ?? {};
	const rawAction = params.action;
	const actionName = typeof rawAction === "string" ? rawAction.trim() : "";
	const rawSubaction = params.subaction;
	const subaction =
		typeof rawSubaction === "string" && rawSubaction.trim().length > 0
			? rawSubaction.trim()
			: undefined;
	const rawActionParameters = params.parameters;
	const baseParameters =
		rawActionParameters &&
		typeof rawActionParameters === "object" &&
		!Array.isArray(rawActionParameters)
			? (rawActionParameters as Record<string, unknown>)
			: {};
	const mergedParameters: Record<string, unknown> = subaction
		? { ...baseParameters, subaction }
		: baseParameters;
	return {
		id: toolCall.id,
		name: actionName,
		params: mergedParameters,
	};
}

function normalizeSubPlannerActionIdentifier(actionName: string): string {
	return actionName
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
}

function buildSubPlannerActionLookup(
	actions: readonly Action[],
): Map<string, Action> {
	const lookup = new Map<string, Action>();
	for (const action of actions) {
		const names = [action.name, ...(action.similes ?? [])];
		for (const name of names) {
			if (typeof name !== "string" || name.trim().length === 0) {
				continue;
			}
			lookup.set(normalizeSubPlannerActionIdentifier(name), action);
		}
	}
	return lookup;
}

export function actionHasSubActions(action: Action): boolean {
	return Array.isArray(action.subActions) && action.subActions.length > 0;
}

export function resolveSubActions(
	runtime: Pick<IAgentRuntime, "actions">,
	action: Action,
): Action[] {
	const subActions = action.subActions ?? [];
	const resolved: Action[] = [];
	const seen = new Set<string>();

	for (const entry of subActions) {
		const child =
			typeof entry === "string"
				? runtime.actions.find((candidate) => candidate.name === entry)
				: entry;
		if (!child) {
			throw new Error(`Sub-action not found: ${entry}`);
		}
		if (!seen.has(child.name)) {
			seen.add(child.name);
			resolved.push(child);
		}
	}

	return resolved;
}

export function detectSubActionCycles(actions: readonly Action[]): string[][] {
	const actionsByName = new Map(actions.map((action) => [action.name, action]));
	const cycles: string[][] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const stack: string[] = [];
	const cycleKeys = new Set<string>();

	function visit(action: Action): void {
		if (visiting.has(action.name)) {
			const start = stack.indexOf(action.name);
			if (start >= 0) {
				const cycle = [...stack.slice(start), action.name];
				const key = cycle.join(">");
				if (!cycleKeys.has(key)) {
					cycleKeys.add(key);
					cycles.push(cycle);
				}
			}
			return;
		}
		if (visited.has(action.name)) {
			return;
		}

		visiting.add(action.name);
		stack.push(action.name);

		for (const child of action.subActions ?? []) {
			const childAction =
				typeof child === "string" ? actionsByName.get(child) : child;
			if (childAction) {
				visit(childAction);
			}
		}

		stack.pop();
		visiting.delete(action.name);
		visited.add(action.name);
	}

	for (const action of actions) {
		visit(action);
	}

	return cycles;
}

export type SubPlannerExecute = (
	runtime: IAgentRuntime,
	ctx: ExecutePlannedToolCallContext,
	toolCall: PlannerToolCall,
	options: ExecutePlannedToolCallOptions,
) => Promise<ActionResult> | ActionResult;

export interface RunSubPlannerParams {
	runtime: IAgentRuntime & PlannerRuntime;
	action: Action;
	context: ContextObject;
	ctx: ExecutePlannedToolCallContext;
	options?: ExecutePlannedToolCallOptions;
	config?: PlannerLoopParams["config"];
	evaluate?: PlannerLoopParams["evaluate"];
	onToolCallEnqueued?: PlannerLoopParams["onToolCallEnqueued"];
	modelType?: PlannerLoopParams["modelType"];
	evaluatorEffects?: PlannerLoopParams["evaluatorEffects"];
	provider?: string;
	execute?: SubPlannerExecute;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
}

export async function runSubPlanner(
	params: RunSubPlannerParams,
): Promise<PlannerLoopResult> {
	const childActions = resolveSubActions(params.runtime, params.action);
	if (childActions.length === 0) {
		throw new Error(`Action ${params.action.name} has no sub-actions`);
	}

	const cycles = detectSubActionCycles([params.action, ...childActions]);
	if (cycles.length > 0) {
		throw new Error(
			`Sub-action cycle detected: ${cycles.map((cycle) => cycle.join(" -> ")).join("; ")}`,
		);
	}

	const childActionNames = new Set(childActions.map((action) => action.name));
	const childActionLookup = buildSubPlannerActionLookup(childActions);
	// Sub-planner only ever needs the Stage 2 PLAN_ACTIONS tool — Stage 1
	// routing already happened at the top level. Holding the tool list to a
	// single stable entry keeps the prompt-cache key byte-stable across
	// descents within the same sub-planner. Child action specs render into
	// the sub-planner's available-actions block; the LLM picks one by name
	// and passes it back via PLAN_ACTIONS({ action, … }).
	const tools: ToolDefinition[] = [PLAN_ACTIONS_TOOL];
	const execute = params.execute ?? executePlannedToolCall;
	const context = buildSubPlannerContext(
		params.context,
		params.action,
		childActions,
	);
	await emitAppendedContextEvents(
		context.events.slice(params.context.events?.length ?? 0),
	);

	// Sub-actions are authorized by the parent action's `subActions` declaration —
	// that declaration IS the gate. We expand the active context set to include
	// every child's declared contexts (and the parent's) so the per-action
	// context gate in execute-planned-tool-call.ts admits them. Without this,
	// children with non-overlapping `contexts` (e.g. RESEARCH gated to
	// `research_workflow`, but its child WEB_SEARCH gated to `web`) get rejected
	// even though the parent explicitly authorized them.
	const expandedActiveContexts = unionContexts(
		params.ctx.activeContexts,
		params.action.contexts,
		...childActions.map((child) => child.contexts),
	);
	const subPlannerCtx: ExecutePlannedToolCallContext = {
		...params.ctx,
		activeContexts: expandedActiveContexts,
	};

	// Mark a sub-planner descent so trajectory consumers can render the tree.
	const subPlannerStageId = await recordSubPlannerStage({
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: params.parentStageId,
		actionName: params.action.name,
		childActionNames: [...childActionNames],
	});

	return runPlannerLoop({
		runtime: params.runtime,
		context,
		config: params.config,
		evaluate: params.evaluate,
		onToolCallEnqueued: params.onToolCallEnqueued,
		modelType: params.modelType,
		evaluatorEffects: params.evaluatorEffects,
		provider: params.provider,
		tools,
		toolChoice: "auto",
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: subPlannerStageId ?? params.parentStageId,
		executeToolCall: async (toolCall) => {
			const unwrapped = unwrapSubPlannerToolCall(toolCall);
			if (!unwrapped.name) {
				return {
					success: false,
					error: `${PLAN_ACTIONS_TOOL_NAME} requires a non-empty action in sub-planner ${params.action.name}`,
				};
			}
			const resolvedChildAction =
				childActionLookup.get(
					normalizeSubPlannerActionIdentifier(unwrapped.name),
				) ??
				(childActionNames.has(unwrapped.name)
					? { name: unwrapped.name }
					: null);
			if (!resolvedChildAction) {
				return {
					success: false,
					error: `Action ${unwrapped.name} is not available to sub-planner ${params.action.name}`,
				};
			}

			const result = await execute(
				params.runtime,
				subPlannerCtx,
				{ ...unwrapped, name: resolvedChildAction.name },
				{
					...(params.options ?? {}),
					actions: childActions,
				},
			);
			return actionResultToPlannerToolResult(result);
		},
	});
}

function unionContexts(
	...lists: Array<readonly string[] | undefined>
): string[] {
	const seen = new Set<string>();
	for (const list of lists) {
		if (!list) continue;
		for (const ctx of list) {
			if (typeof ctx === "string" && ctx.length > 0) {
				seen.add(ctx);
			}
		}
	}
	return [...seen];
}

async function recordSubPlannerStage(args: {
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	actionName: string;
	childActionNames: string[];
}): Promise<string | undefined> {
	if (!args.recorder || !args.trajectoryId) return undefined;
	try {
		const startedAt = Date.now();
		const stageId = `stage-subplanner-${args.actionName}-${startedAt}`;
		const stage: RecordedStage = {
			stageId,
			kind: "subPlanner",
			parentStageId: args.parentStageId,
			startedAt,
			endedAt: startedAt,
			latencyMs: 0,
			model: undefined,
			tool: undefined,
		};
		// Track child surface area in the stage payload so the CLI can reason
		// about the sub-planner scope. We piggyback on the model field's
		// providerMetadata convention by placing it on the tool.args slot —
		// but to keep the schema clean we use a synthetic `tool` block.
		stage.tool = {
			name: `sub-planner:${args.actionName}`,
			args: { childActions: args.childActionNames },
			result: null,
			success: true,
			durationMs: 0,
		};
		await args.recorder.recordStage(args.trajectoryId, stage);
		return stageId;
	} catch {
		// Recorder failures must not break the runtime.
		return undefined;
	}
}

async function emitAppendedContextEvents(
	events: readonly ContextEvent[],
): Promise<void> {
	const streamingContext = getStreamingContext();
	for (const event of events) {
		await emitStreamingHook(streamingContext, "onContextEvent", event);
	}
}

function buildSubPlannerContext(
	context: ContextObject,
	parentAction: Action,
	childActions: readonly Action[],
): ContextObject {
	return {
		...context,
		metadata: {
			...(context.metadata ?? {}),
			subPlannerParentAction: parentAction.name,
		},
		events: [
			...context.events,
			...childActions.map((action) => ({
				id: `sub-planner:${parentAction.name}:tool:${action.name}`,
				type: "tool" as const,
				source: "sub-planner",
				tool: {
					name: action.name,
					description:
						action.descriptionCompressed ??
						action.compressedDescription ??
						action.description,
					parameters: actionToJsonSchema(action) as JSONSchema,
					action,
					metadata: {
						parentAction: parentAction.name,
					},
				},
			})),
		],
	};
}
