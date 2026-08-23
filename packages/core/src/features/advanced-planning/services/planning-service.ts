/**
 * Runs the PlanningService for the advanced-planning capability: the long-lived
 * service that turns goals into action plans and executes them. `createSimplePlan`
 * wraps a model's chosen actions into a sequential plan; `createComprehensivePlan`
 * prompts a TEXT_LARGE model to decompose a goal, then validates and enhances the
 * result (unknown actions and malformed output fail before execution).
 * `executePlan` runs a plan's steps in sequential, parallel, or DAG order
 * (topological, via a min-heap ready queue) with per-step retry/backoff, an
 * in-memory PlanWorkingMemory, and abort-based cancellation tracked in
 * `planExecutions`.
 *
 * `validatePlan` checks structure and, for DAG plans, circular dependencies;
 * `adaptPlan` re-prompts the model to revise a plan mid-execution. Registered and
 * disposed by createAdvancedPlanningPlugin.
 */
import { v4 as uuidv4 } from "uuid";
import { ElizaError, isElizaError } from "../../../errors.ts";
import { logger } from "../../../logger.ts";
import { settleActionHandler } from "../../../runtime/action-handler-settlement.ts";
import { runWithActionRoutingContext } from "../../../runtime/action-routing-context.ts";
import {
	parseJsonObject,
	stringifyForModel,
} from "../../../runtime/json-output.ts";
import { tagsPermitAutomaticRetry } from "../../../types/effects.ts";
import {
	type ActionContext,
	type ActionParameters,
	type ActionResult,
	asUUID,
	type Content,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	ModelType,
	Service,
	type State,
	type UUID,
} from "../../../types/index.ts";
import { isObjectRecord as isRecord } from "../../../utils/type-guards.ts";
import type { JsonValue, PlanningContext, RetryPolicy } from "../types.ts";

type ExtendedHandlerOptions = HandlerOptions & {
	abortSignal?: AbortSignal;
	previousResults?: ActionResult[];
	context?: {
		workingMemory: Record<string, JsonValue>;
	};
};

interface ActionStep {
	id?: UUID;
	actionName?: string;
	status?: "pending" | "completed" | "failed";
	error?: string;
	result?: ActionResult;
	parameters?: ActionParameters;
	dependencies?: UUID[];
	retryPolicy?: RetryPolicy;
	onError?: "abort" | "continue" | "skip";
	_dependencyStrings?: string[];
}

function parseJsonRecord(response: string): Record<string, unknown> {
	const parsed = parseJsonObject<Record<string, unknown>>(response);
	if (!parsed) {
		throw new ElizaError("Planning model returned invalid JSON", {
			code: "PLANNING_MODEL_OUTPUT_INVALID",
		});
	}
	return parsed;
}

interface PlanState {
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	currentStepIndex?: number;
	startTime?: number;
	endTime?: number;
	error?: string;
}

interface ActionPlan {
	id?: UUID;
	goal?: string;
	thought: string;
	totalSteps: number;
	currentStep: number;
	steps: ActionStep[];
	executionModel?: "sequential" | "parallel" | "dag";
	state?: PlanState;
	metadata?: Record<string, JsonValue>;
}

interface PlanExecutionResult {
	planId: UUID;
	success: boolean;
	completedSteps: number;
	totalSteps: number;
	results: ActionResult[];
	errors?: Error[];
	duration?: number;
}

type WorkingMemory = Record<string, JsonValue>;
type RuntimeAction = IAgentRuntime["actions"][number];

function normalizeActionParameters(value: unknown): ActionParameters {
	if (value === undefined || value === null) {
		return {};
	}

	if (isRecord(value)) {
		return value as ActionParameters;
	}

	if (typeof value === "string" && value.trim().length > 0) {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (isRecord(parsed)) {
				return parsed as ActionParameters;
			}
		} catch (error) {
			// error-policy:J3 model-supplied parameter JSON is an untrusted input boundary
			throw new ElizaError("Action parameters contain invalid JSON", {
				code: "PLANNING_ACTION_PARAMETERS_INVALID",
				cause: error,
			});
		}
	}

	throw new ElizaError("Action parameters must be a JSON object", {
		code: "PLANNING_ACTION_PARAMETERS_INVALID",
		context: { valueType: typeof value },
	});
}

function normalizeDependencyStrings(value: unknown): string[] {
	if (value === undefined || value === null) {
		return [];
	}

	if (Array.isArray(value)) {
		if (!value.every((entry) => typeof entry === "string")) {
			throw new ElizaError("Plan dependencies must contain only strings", {
				code: "PLANNING_DEPENDENCIES_INVALID",
			});
		}
		return value.map((entry) => entry.trim()).filter(Boolean);
	}

	if (typeof value === "string" && value.trim().length > 0) {
		const trimmed = value.trim();
		if (trimmed.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				if (
					Array.isArray(parsed) &&
					parsed.every((entry) => typeof entry === "string")
				) {
					return parsed.map((entry) => entry.trim()).filter(Boolean);
				}
			} catch (error) {
				// error-policy:J3 model-supplied dependency JSON is an untrusted input boundary
				throw new ElizaError("Plan dependencies contain invalid JSON", {
					code: "PLANNING_DEPENDENCIES_INVALID",
					cause: error,
				});
			}
			throw new ElizaError("Plan dependencies must be a string array", {
				code: "PLANNING_DEPENDENCIES_INVALID",
			});
		}
		return [trimmed];
	}

	throw new ElizaError("Plan dependencies must be a string or string array", {
		code: "PLANNING_DEPENDENCIES_INVALID",
		context: { valueType: typeof value },
	});
}

function parseModelSteps(value: unknown): ActionStep[] {
	if (!Array.isArray(value)) {
		throw new ElizaError("Planning model steps must be an array", {
			code: "PLANNING_STEPS_INVALID",
		});
	}

	const steps: ActionStep[] = [];
	const stepIdMap = new Map<string, UUID>();
	for (const [index, candidate] of value.entries()) {
		if (!isRecord(candidate)) {
			throw new ElizaError("Planning model returned a malformed step", {
				code: "PLANNING_STEP_INVALID",
				context: { stepIndex: index },
			});
		}

		const actionName =
			typeof candidate.action === "string"
				? candidate.action.trim()
				: typeof candidate.actionName === "string"
					? candidate.actionName.trim()
					: "";
		if (!actionName) {
			throw new ElizaError("Planning step is missing an action name", {
				code: "PLANNING_STEP_ACTION_MISSING",
				context: { stepIndex: index },
			});
		}

		const originalId =
			typeof candidate.id === "string" && candidate.id.trim().length > 0
				? candidate.id.trim()
				: `step_${index + 1}`;
		if (stepIdMap.has(originalId)) {
			throw new ElizaError("Planning model returned duplicate step IDs", {
				code: "PLANNING_STEP_ID_DUPLICATE",
				context: { stepId: originalId },
			});
		}

		const actualId = asUUID(uuidv4());
		stepIdMap.set(originalId, actualId);
		steps.push({
			id: actualId,
			actionName,
			parameters: normalizeActionParameters(candidate.parameters),
			dependencies: [],
			_dependencyStrings: normalizeDependencyStrings(candidate.dependencies),
		});
	}

	if (steps.length === 0) {
		throw new ElizaError("Planning model returned no executable steps", {
			code: "PLANNING_STEPS_MISSING",
		});
	}

	for (const step of steps) {
		const dependencies: UUID[] = [];
		for (const dependency of step._dependencyStrings ?? []) {
			const resolvedId = stepIdMap.get(dependency);
			if (!resolvedId) {
				throw new ElizaError("Planning step references an unknown dependency", {
					code: "PLANNING_DEPENDENCY_UNKNOWN",
					context: { dependency },
				});
			}
			dependencies.push(resolvedId);
		}
		step.dependencies = dependencies;
		delete step._dependencyStrings;
	}

	return steps;
}

class PlanWorkingMemory {
	private memory = new Map<string, JsonValue>();

	set(key: string, value: JsonValue): void {
		this.memory.set(key, value);
	}

	get(key: string): JsonValue | undefined {
		return this.memory.get(key);
	}

	has(key: string): boolean {
		return this.memory.has(key);
	}

	delete(key: string): boolean {
		return this.memory.delete(key);
	}

	clear(): void {
		this.memory.clear();
	}

	entries(): IterableIterator<[string, JsonValue]> {
		return this.memory.entries();
	}

	serialize(): Record<string, JsonValue> {
		return Object.fromEntries(this.memory);
	}
}

export class PlanningService extends Service {
	static serviceType = "planning";

	serviceType = "planning";
	capabilityDescription = "Planning and action coordination";

	private planExecutions = new Map<
		UUID,
		{
			state: PlanState;
			workingMemory: WorkingMemory;
			results: ActionResult[];
			abortController?: AbortController;
		}
	>();

	static async start(runtime: IAgentRuntime): Promise<PlanningService> {
		const service = new PlanningService(runtime);
		logger.info("PlanningService started successfully");
		return service;
	}

	async createSimplePlan(
		_runtime: IAgentRuntime,
		message: Memory,
		_state: State,
		responseContent?: Content,
	): Promise<ActionPlan> {
		// Action selection comes from the model's decision (the `<response>`
		// actions field), never from keyword-matching the user's text. When
		// the model chose no actions, the documented model-output contract
		// treats the turn as a plain REPLY. Keyword routing (e.g.
		// `text.includes("email"|"search"|"analyze")`) is avoided because it
		// is brittle, English-only, and runs actions the model never decided
		// to run (#10470, #10424).
		const actions =
			responseContent?.actions && responseContent.actions.length > 0
				? responseContent.actions
				: ["REPLY"];

		const planId = asUUID(uuidv4());
		const stepIds: UUID[] = [];
		const steps: ActionStep[] = actions.map((actionName, index) => {
			const stepId = asUUID(uuidv4());
			stepIds.push(stepId);
			return {
				id: stepId,
				actionName,
				parameters: {
					message: responseContent?.text || message.content.text || "",
					thought: responseContent?.thought || "",
					providers: responseContent?.providers || [],
				} satisfies ActionParameters,
				dependencies: index > 0 ? [stepIds[index - 1]] : [],
			};
		});

		return {
			id: planId,
			goal: responseContent?.text || `Execute actions: ${actions.join(", ")}`,
			thought:
				responseContent?.thought || `Executing ${actions.length} action(s)`,
			totalSteps: steps.length,
			currentStep: 0,
			steps,
			executionModel: "sequential",
			state: { status: "pending" },
			metadata: {
				createdAt: Date.now(),
				estimatedDuration: steps.length * 5000,
				priority: 1,
				tags: ["simple", "message-handling"],
			},
		};
	}

	async createComprehensivePlan(
		runtime: IAgentRuntime,
		context: PlanningContext,
		message?: Memory,
		state?: State,
	): Promise<ActionPlan> {
		if (context.goal.trim() === "") {
			throw new Error("Planning context must have a non-empty goal");
		}
		if (
			context.constraints !== undefined &&
			!Array.isArray(context.constraints)
		) {
			throw new Error("Planning context constraints must be an array");
		}
		if (
			context.availableActions !== undefined &&
			!Array.isArray(context.availableActions)
		) {
			throw new Error("Planning context availableActions must be an array");
		}
		if (
			context.preferences !== undefined &&
			typeof context.preferences !== "object"
		) {
			throw new Error("Planning context preferences must be an object");
		}

		const planningPrompt = this.buildPlanningPrompt(context, message, state);

		const planningResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: planningPrompt,
			temperature: 0.3,
		});

		const parsedPlan = this.parsePlanningResponse(
			String(planningResponse),
			context,
		);
		const enhancedPlan = await this.enhancePlan(runtime, parsedPlan);

		if (!enhancedPlan.id) {
			throw new Error("Enhanced plan missing id");
		}

		return enhancedPlan;
	}

	async executePlan(
		runtime: IAgentRuntime,
		plan: ActionPlan,
		message: Memory,
		callback?: HandlerCallback,
	): Promise<PlanExecutionResult> {
		const startTime = Date.now();
		const workingMemory = new PlanWorkingMemory();
		const results: ActionResult[] = [];
		const errors: Error[] = [];
		const abortController = new AbortController();

		const executionState: PlanState = {
			status: "running",
			startTime,
			currentStepIndex: 0,
		};

		if (!plan.id) {
			throw new Error("Plan missing id");
		}

		this.planExecutions.set(plan.id, {
			state: executionState,
			workingMemory: workingMemory.serialize(),
			results,
			abortController,
		});

		const actionByName = this.buildActionLookup(runtime);

		try {
			if (plan.executionModel === "sequential") {
				await this.executeSequential(
					runtime,
					actionByName,
					plan,
					message,
					workingMemory,
					results,
					errors,
					callback,
					abortController.signal,
				);
			} else if (plan.executionModel === "parallel") {
				await this.executeParallel(
					runtime,
					actionByName,
					plan,
					message,
					workingMemory,
					results,
					errors,
					callback,
					abortController.signal,
				);
			} else if (plan.executionModel === "dag") {
				await this.executeDAG(
					runtime,
					actionByName,
					plan,
					message,
					workingMemory,
					results,
					errors,
					callback,
					abortController.signal,
				);
			} else {
				throw new Error(`Unsupported execution model: ${plan.executionModel}`);
			}

			executionState.status = errors.length > 0 ? "failed" : "completed";
			executionState.endTime = Date.now();

			return {
				planId: plan.id,
				success: errors.length === 0,
				completedSteps: results.length,
				totalSteps: plan.steps.length,
				results,
				errors: errors.length > 0 ? errors : undefined,
				duration: Date.now() - startTime,
			};
		} catch (error) {
			// error-policy:J1 plan execution translates step failures into one structured result
			executionState.status = "failed";
			executionState.endTime = Date.now();
			executionState.error =
				error instanceof Error ? error.message : String(error);

			const err = error instanceof Error ? error : new Error(String(error));
			return {
				planId: plan.id,
				success: false,
				completedSteps: results.length,
				totalSteps: plan.steps.length,
				results,
				errors: [err, ...errors],
				duration: Date.now() - startTime,
			};
		} finally {
			this.planExecutions.delete(plan.id);
		}
	}

	async validatePlan(
		runtime: IAgentRuntime,
		plan: ActionPlan,
	): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
		const issues: string[] = [];
		const actionByName = this.buildActionLookup(runtime);

		if (!plan.id || !plan.goal || !plan.steps) {
			issues.push("Plan missing required fields (id, goal, or steps)");
		}

		if (plan.steps.length === 0) {
			issues.push("Plan has no steps");
		}

		for (const step of plan.steps) {
			if (!step.id || !step.actionName) {
				issues.push("Step missing required fields (id or actionName)");
				continue;
			}

			if (!actionByName.has(step.actionName)) {
				issues.push(`Action '${step.actionName}' not found in runtime`);
			}
		}

		const stepIds = new Set(
			plan.steps.map((s) => s.id).filter((id): id is UUID => Boolean(id)),
		);
		for (const step of plan.steps) {
			if (step.dependencies) {
				for (const depId of step.dependencies) {
					if (!stepIds.has(depId)) {
						issues.push(
							`Step '${String(step.id)}' has invalid dependency '${String(depId)}'`,
						);
					}
				}
			}
		}

		if (plan.executionModel === "dag") {
			const hasCycle = this.detectCycles(plan.steps);
			if (hasCycle) {
				issues.push("Plan has circular dependencies");
			}
		}

		return {
			valid: issues.length === 0,
			errors: issues,
			warnings: [],
		};
	}

	async adaptPlan(
		runtime: IAgentRuntime,
		plan: ActionPlan,
		currentStepIndex: number,
		results: ActionResult[],
		error?: Error,
	): Promise<ActionPlan> {
		const adaptationPrompt = this.buildAdaptationPrompt(
			plan,
			currentStepIndex,
			results,
			error,
		);
		const adaptationResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: adaptationPrompt,
			temperature: 0.4,
		});

		const adaptedPlan = this.parseAdaptationResponse(
			String(adaptationResponse),
			plan,
			currentStepIndex,
		);
		return this.enhancePlan(runtime, adaptedPlan);
	}

	async getPlanStatus(planId: UUID): Promise<PlanState | null> {
		const execution = this.planExecutions.get(planId);
		return execution?.state || null;
	}

	async cancelPlan(planId: UUID): Promise<boolean> {
		const execution = this.planExecutions.get(planId);
		if (!execution) {
			return false;
		}

		execution.abortController?.abort();
		execution.state.status = "cancelled";
		execution.state.endTime = Date.now();
		return true;
	}

	async stop(): Promise<void> {
		for (const [, execution] of this.planExecutions) {
			execution.abortController?.abort();
			execution.state.status = "cancelled";
			execution.state.endTime = Date.now();
		}

		this.planExecutions.clear();
	}

	private buildPlanningPrompt(
		context: PlanningContext,
		message?: Memory,
		state?: State,
	): string {
		const availableActions = (context.availableActions || []).join(", ");
		const constraints = (context.constraints || [])
			.map(
				(c: NonNullable<PlanningContext["constraints"]>[number]) =>
					`${c.type}: ${c.description || c.value}`,
			)
			.join(", ");

		return `Create a comprehensive action plan to achieve the following goal.

GOAL: ${context.goal}

AVAILABLE ACTIONS: ${availableActions}
CONSTRAINTS: ${constraints}

EXECUTION MODEL: ${context.preferences?.executionModel || "sequential"}
MAX STEPS: ${context.preferences?.maxSteps || 10}

${message ? `CONTEXT MESSAGE: ${message.content.text}` : ""}
${state ? `CURRENT STATE:\n${stringifyForModel(state.values)}` : ""}

Return JSON only, with no prose, markdown, or code fences, using this shape:
{
  "goal": ${JSON.stringify(context.goal)},
  "execution_model": ${JSON.stringify(context.preferences?.executionModel || "sequential")},
  "steps": [
    {
      "id": "step_1",
      "action": "ACTION_NAME",
      "parameters": { "key": "value" },
      "dependencies": ["step_0"],
      "description": "What this step accomplishes"
    }
  ],
  "estimated_duration": 30000
}

Focus on:
1. Breaking down the goal into logical, executable steps
2. Ensuring each step uses available actions
3. Managing dependencies between steps
4. Providing realistic time estimates
5. Including error handling considerations`;
	}

	private parsePlanningResponse(
		response: string,
		context: PlanningContext,
	): ActionPlan {
		try {
			const parsedResponse = parseJsonRecord(response);

			const planId = asUUID(uuidv4());

			const goal =
				(typeof parsedResponse.goal === "string"
					? parsedResponse.goal
					: null) || context.goal;
			const executionModelValue =
				(typeof parsedResponse.execution_model === "string"
					? parsedResponse.execution_model
					: null) ||
				context.preferences?.executionModel ||
				"sequential";
			if (
				executionModelValue !== "sequential" &&
				executionModelValue !== "parallel" &&
				executionModelValue !== "dag"
			) {
				throw new ElizaError(
					"Planning model returned an invalid execution model",
					{
						code: "PLANNING_EXECUTION_MODEL_INVALID",
						context: { executionModel: executionModelValue },
					},
				);
			}

			const estimatedDurationRaw = parsedResponse.estimated_duration;
			const estimatedDuration =
				estimatedDurationRaw === undefined
					? 30000
					: typeof estimatedDurationRaw === "number"
						? estimatedDurationRaw
						: typeof estimatedDurationRaw === "string" &&
								estimatedDurationRaw.trim() !== ""
							? Number(estimatedDurationRaw)
							: Number.NaN;
			if (!Number.isFinite(estimatedDuration) || estimatedDuration < 0) {
				throw new ElizaError(
					"Planning model returned an invalid estimated duration",
					{
						code: "PLANNING_ESTIMATED_DURATION_INVALID",
						context: { estimatedDuration: estimatedDurationRaw },
					},
				);
			}

			const steps = parseModelSteps(parsedResponse.steps);

			return {
				id: planId,
				goal,
				thought: `Plan to achieve: ${goal}`,
				totalSteps: steps.length,
				currentStep: 0,
				steps,
				executionModel: executionModelValue,
				state: { status: "pending" },
				metadata: {
					createdAt: Date.now(),
					estimatedDuration,
					priority: 1,
					tags: ["comprehensive"],
				},
			};
		} catch (error) {
			// error-policy:J2 add plan-construction context while preserving the model-output failure
			throw new ElizaError("Failed to build action plan", {
				code: "ACTION_PLAN_BUILD_FAILED",
				cause: error,
			});
		}
	}

	private async enhancePlan(
		runtime: IAgentRuntime,
		plan: ActionPlan,
	): Promise<ActionPlan> {
		for (const step of plan.steps) {
			const normalize = (s: string): string =>
				s.toLowerCase().replace(/_/g, "");
			const stepName = step.actionName ?? "";
			const stepNorm = normalize(stepName);
			const action = runtime.actions.find((a) => {
				const nameMatch = normalize(a.name) === stepNorm;
				const simileMatch = (a.similes ?? []).some(
					(s) => normalize(s) === stepNorm,
				);
				return nameMatch || simileMatch;
			});
			if (!action) {
				throw new ElizaError("Plan references an unavailable action", {
					code: "PLANNING_ACTION_UNAVAILABLE",
					context: { actionName: step.actionName },
				});
			}
		}

		for (const step of plan.steps) {
			if (!step.retryPolicy) {
				step.retryPolicy = {
					maxRetries: 2,
					backoffMs: 1000,
					backoffMultiplier: 2,
					onError: "abort",
				};
			}
		}

		return plan;
	}

	private async executeSequential(
		runtime: IAgentRuntime,
		actionByName: Map<string, RuntimeAction>,
		plan: ActionPlan,
		message: Memory,
		workingMemory: PlanWorkingMemory,
		results: ActionResult[],
		errors: Error[],
		callback?: HandlerCallback,
		abortSignal?: AbortSignal,
	): Promise<void> {
		for (let i = 0; i < plan.steps.length; i++) {
			if (abortSignal?.aborted) {
				throw new Error("Plan execution aborted");
			}

			const step = plan.steps[i];
			try {
				const result = await this.executeStep(
					runtime,
					actionByName,
					step,
					message,
					workingMemory,
					results,
					callback,
					abortSignal,
				);
				results.push(result);

				if (plan.id) {
					const execution = this.planExecutions.get(plan.id);
					if (execution) {
						execution.state.currentStepIndex = i + 1;
					}
				}
			} catch (error) {
				// error-policy:J1 each plan step applies its declared abort/continue policy
				const err = error instanceof Error ? error : new Error(String(error));
				errors.push(err);

				const onError = step.onError ?? step.retryPolicy?.onError ?? "abort";
				if (onError === "abort") {
					throw err;
				}
			}
		}
	}

	private async executeParallel(
		runtime: IAgentRuntime,
		actionByName: Map<string, RuntimeAction>,
		plan: ActionPlan,
		message: Memory,
		workingMemory: PlanWorkingMemory,
		results: ActionResult[],
		errors: Error[],
		callback?: HandlerCallback,
		abortSignal?: AbortSignal,
	): Promise<void> {
		const promises = plan.steps.map(async (step) => {
			try {
				const result = await this.executeStep(
					runtime,
					actionByName,
					step,
					message,
					workingMemory,
					results,
					callback,
					abortSignal,
				);
				return { result, error: null as Error | null };
			} catch (e) {
				// error-policy:J1 parallel fan-out settles each step into the aggregate plan result
				return {
					result: null as ActionResult | null,
					error: e instanceof Error ? e : new Error(String(e)),
				};
			}
		});

		const stepResults = await Promise.all(promises);
		for (const { result, error } of stepResults) {
			if (error) {
				errors.push(error);
			} else if (result) {
				results.push(result);
			}
		}
	}

	private async executeDAG(
		runtime: IAgentRuntime,
		actionByName: Map<string, RuntimeAction>,
		plan: ActionPlan,
		message: Memory,
		workingMemory: PlanWorkingMemory,
		results: ActionResult[],
		errors: Error[],
		callback?: HandlerCallback,
		abortSignal?: AbortSignal,
	): Promise<void> {
		const order = this.buildDagExecutionOrder(plan.steps);
		const stepById = new Map<UUID, ActionStep>();
		for (const step of plan.steps) {
			if (step.id) {
				stepById.set(step.id, step);
			}
		}

		for (const stepId of order) {
			if (abortSignal?.aborted) {
				throw new Error("Plan execution aborted");
			}
			const step = stepById.get(stepId);
			if (!step) continue;

			try {
				const result = await this.executeStep(
					runtime,
					actionByName,
					step,
					message,
					workingMemory,
					results,
					callback,
					abortSignal,
				);
				results.push(result);
			} catch (e) {
				// error-policy:J1 DAG execution aggregates independent step failures for the plan boundary
				errors.push(e instanceof Error ? e : new Error(String(e)));
			}
		}
	}

	private async executeStep(
		runtime: IAgentRuntime,
		actionByName: Map<string, RuntimeAction>,
		step: ActionStep,
		message: Memory,
		workingMemory: PlanWorkingMemory,
		previousResults: ActionResult[],
		callback?: HandlerCallback,
		abortSignal?: AbortSignal,
	): Promise<ActionResult> {
		if (!step.actionName) {
			throw new Error("Step missing actionName");
		}

		const action = actionByName.get(step.actionName);
		if (!action) {
			throw new Error(`Action '${step.actionName}' not found`);
		}

		const actionContext: ActionContext = {
			previousResults,
			getPreviousResult: (actionName: string) =>
				previousResults.find((r) => {
					const data = (r.data ?? {}) as Record<string, JsonValue>;
					return (
						data.actionName === actionName ||
						data.stepId === (step.id ? String(step.id) : "")
					);
				}),
		};

		let retries = 0;
		const requestedRetries = step.retryPolicy?.maxRetries ?? 0;
		const maxRetries = tagsPermitAutomaticRetry(action.tags)
			? requestedRetries
			: 0;

		while (retries <= maxRetries) {
			if (abortSignal?.aborted) {
				throw new Error("Plan execution aborted");
			}

			try {
				const options = {
					actionContext,
					parameters: step.parameters,
					context: {
						workingMemory: workingMemory.serialize(),
					},
					abortSignal,
					previousResults,
				} satisfies ExtendedHandlerOptions;
				const actionResult = await settleActionHandler({
					runtime,
					action,
					callback,
					handlerError: "rethrow",
					invoke: (actionCallback) =>
						runWithActionRoutingContext(
							{ actionName: action.name, modelClass: action.modelClass },
							() =>
								action.handler(
									runtime,
									message,
									{ values: {}, data: {}, text: "" },
									options,
									actionCallback,
								),
						),
				});

				return {
					...actionResult,
					data: {
						...(actionResult.data ?? {}),
						stepId: step.id ? String(step.id) : "",
						executedAt: Date.now(),
						actionName: action.name,
					},
				};
			} catch (error) {
				// error-policy:J1 action invocation enforces the step's bounded retry contract
				if (
					isElizaError(error) &&
					error.code === "ACTION_RESULT_INVALID_AFTER_HANDLER"
				) {
					throw error;
				}
				retries++;
				if (retries > maxRetries) {
					throw error;
				}
				const backoffMs =
					(step.retryPolicy?.backoffMs ?? 1000) *
					(step.retryPolicy?.backoffMultiplier ?? 2) ** (retries - 1);
				await new Promise((resolve) => setTimeout(resolve, backoffMs));
			}
		}

		throw new Error("Maximum retries exceeded");
	}

	private detectCycles(steps: ActionStep[]): boolean {
		const visited = new Set<UUID>();
		const recursionStack = new Set<UUID>();

		const dfs = (stepId: UUID): boolean => {
			if (recursionStack.has(stepId)) return true;
			if (visited.has(stepId)) return false;

			visited.add(stepId);
			recursionStack.add(stepId);

			const step = steps.find((s) => s.id === stepId);
			if (step?.dependencies) {
				for (const depId of step.dependencies) {
					if (dfs(depId)) return true;
				}
			}

			recursionStack.delete(stepId);
			return false;
		};

		for (const step of steps) {
			if (step.id && dfs(step.id)) {
				return true;
			}
		}
		return false;
	}

	private buildActionLookup(
		runtime: IAgentRuntime,
	): Map<string, RuntimeAction> {
		const actionByName = new Map<string, RuntimeAction>();
		for (const action of runtime.actions) {
			actionByName.set(action.name, action);
		}
		return actionByName;
	}

	private buildDagExecutionOrder(steps: ActionStep[]): UUID[] {
		const depsRemaining = new Map<UUID, number>();
		const dependents = new Map<UUID, UUID[]>();
		const indexById = new Map<UUID, number>();

		for (let i = 0; i < steps.length; i += 1) {
			const id = steps[i]?.id;
			if (!id) continue;
			const dependencies = steps[i].dependencies ?? [];
			depsRemaining.set(id, dependencies.length);
			indexById.set(id, i);
			for (const dep of dependencies) {
				const list = dependents.get(dep);
				if (list) {
					list.push(id);
				} else {
					dependents.set(dep, [id]);
				}
			}
		}

		const readyHeap: number[] = [];
		for (const [id, idx] of indexById) {
			if ((depsRemaining.get(id) ?? 0) === 0) {
				this.pushReadyStep(readyHeap, idx);
			}
		}

		const order: UUID[] = [];
		while (readyHeap.length > 0) {
			const idx = this.popReadyStep(readyHeap);
			if (idx === undefined) break;
			const step = steps[idx];
			if (!step?.id) continue;
			const stepId = step.id;
			order.push(stepId);

			const nextSteps = dependents.get(stepId);
			if (!nextSteps) continue;
			for (const nextId of nextSteps) {
				const remaining = depsRemaining.get(nextId);
				if (remaining === undefined || remaining <= 0) continue;
				const updated = remaining - 1;
				depsRemaining.set(nextId, updated);
				if (updated === 0) {
					const nextIdx = indexById.get(nextId);
					if (nextIdx !== undefined) {
						this.pushReadyStep(readyHeap, nextIdx);
					}
				}
			}
		}

		if (order.length !== indexById.size) {
			throw new Error(
				"No steps ready to execute - possible circular dependency",
			);
		}

		return order;
	}

	private pushReadyStep(heap: number[], value: number): void {
		heap.push(value);
		let index = heap.length - 1;
		while (index > 0) {
			const parent = Math.floor((index - 1) / 2);
			if (heap[parent] <= heap[index]) break;
			const tmp = heap[parent];
			heap[parent] = heap[index];
			heap[index] = tmp;
			index = parent;
		}
	}

	private popReadyStep(heap: number[]): number | undefined {
		if (heap.length === 0) return undefined;
		const result = heap[0];
		const last = heap.pop();
		if (last === undefined || heap.length === 0) {
			return result;
		}
		heap[0] = last;
		let index = 0;
		const length = heap.length;
		while (true) {
			const left = index * 2 + 1;
			const right = left + 1;
			if (left >= length) break;
			let smallest = left;
			if (right < length && heap[right] < heap[left]) {
				smallest = right;
			}
			if (heap[index] <= heap[smallest]) break;
			const tmp = heap[index];
			heap[index] = heap[smallest];
			heap[smallest] = tmp;
			index = smallest;
		}
		return result;
	}

	private buildAdaptationPrompt(
		plan: ActionPlan,
		currentStepIndex: number,
		results: ActionResult[],
		error?: Error,
	): string {
		return `Adapt the current plan to address an execution issue.

ORIGINAL PLAN:
${stringifyForModel(plan)}
CURRENT STEP INDEX: ${currentStepIndex}
COMPLETED RESULTS:
${stringifyForModel({ results })}
${error ? `ERROR: ${error.message}` : ""}

Analyze the situation and provide an adapted plan that:
1. Addresses the current issue
2. Maintains the original goal
3. Uses available actions effectively
4. Considers what has already been completed

Return the adapted plan as JSON only, with the same shape as the original planning response.`;
	}

	private parseAdaptationResponse(
		response: string,
		originalPlan: ActionPlan,
		currentStepIndex: number,
	): ActionPlan {
		try {
			const parsedResponse = parseJsonRecord(response);
			const adaptedSteps = parseModelSteps(parsedResponse.steps);

			const prevMeta = originalPlan.metadata ?? {};
			const prevAdaptations = (prevMeta.adaptations ?? []) as JsonValue;
			const nextAdaptations = Array.isArray(prevAdaptations)
				? [...prevAdaptations, `Adapted at step ${currentStepIndex}`]
				: [`Adapted at step ${currentStepIndex}`];

			return {
				...originalPlan,
				id: asUUID(uuidv4()),
				steps: [
					...originalPlan.steps.slice(0, currentStepIndex),
					...adaptedSteps,
				],
				metadata: {
					...prevMeta,
					adaptations: nextAdaptations,
				},
			};
		} catch (error) {
			// error-policy:J2 preserve malformed adaptation output for the caller to handle
			throw new ElizaError("Failed to adapt action plan", {
				code: "PLAN_ADAPTATION_FAILED",
				cause: error,
				context: { currentStepIndex },
			});
		}
	}
}
