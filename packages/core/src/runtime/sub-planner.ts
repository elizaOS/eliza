import { actionToJsonSchema } from "../actions/action-schema";
import { emitStreamingHook, getStreamingContext } from "../streaming-context";
import type { Action, ActionResult, IAgentRuntime } from "../types";
import type { ContextEvent, ContextObject } from "../types/context-object";
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
	const execute = params.execute ?? executePlannedToolCall;
	const context = buildSubPlannerContext(
		params.context,
		params.action,
		childActions,
	);
	await emitAppendedContextEvents(
		context.events.slice(params.context.events?.length ?? 0),
	);

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
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: subPlannerStageId ?? params.parentStageId,
		executeToolCall: async (toolCall) => {
			if (!childActionNames.has(toolCall.name)) {
				return {
					success: false,
					error: `Tool ${toolCall.name} is not available to sub-planner ${params.action.name}`,
				};
			}

			const result = await execute(params.runtime, params.ctx, toolCall, {
				...(params.options ?? {}),
				actions: childActions,
			});
			return actionResultToPlannerToolResult(result);
		},
	});
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
					parameters: actionToJsonSchema(action),
					action,
					metadata: {
						parentAction: parentAction.name,
					},
				},
			})),
		],
	};
}
