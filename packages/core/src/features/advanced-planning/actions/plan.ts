import { v4 as uuidv4 } from "uuid";
import {
	CANONICAL_SUBACTION_KEY,
	DEFAULT_SUBACTION_KEYS,
	normalizeSubaction,
} from "../../../actions/subaction-dispatch.ts";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
import type { JsonValue } from "../types.ts";

type PlanningActionOptions = HandlerOptions & {
	abortSignal?: AbortSignal;
	previousResults?: ActionResult[];
	chainContext?: {
		chainId?: string;
		totalActions?: number;
	};
};

const PLAN_SUBACTIONS = ["create", "update", "finalize", "review"] as const;
type PlanSubaction = (typeof PLAN_SUBACTIONS)[number];

type JsonRecord = Record<string, JsonValue>;

const DEFAULT_PLAN_GOAL = "Multi-phase project plan with coordinated execution";

function planningFailureResult(
	actionName: string,
	message: string,
	extraData: Record<string, JsonValue> = {},
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

function readPlanSubaction(
	options: PlanningActionOptions | undefined,
): PlanSubaction {
	const params = options?.parameters as
		| Record<string, JsonValue | undefined>
		| undefined;
	for (const key of DEFAULT_SUBACTION_KEYS) {
		const normalized = normalizeSubaction(params?.[key]);
		if (
			normalized &&
			(PLAN_SUBACTIONS as readonly string[]).includes(normalized)
		) {
			return normalized as PlanSubaction;
		}
	}
	return "create";
}

function getParameters(
	options: PlanningActionOptions | undefined,
): Record<string, JsonValue | undefined> {
	return (
		(options?.parameters as
			| Record<string, JsonValue | undefined>
			| undefined) ?? {}
	);
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringParameter(
	params: Record<string, JsonValue | undefined>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function readPositiveIntegerParameter(
	params: Record<string, JsonValue | undefined>,
	keys: string[],
	fallback: number,
): number {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return Math.max(1, Math.min(12, Math.floor(value)));
		}
	}
	return fallback;
}

function readStringArrayParameter(
	params: Record<string, JsonValue | undefined>,
	keys: string[],
): string[] | undefined {
	for (const key of keys) {
		const value = params[key];
		if (Array.isArray(value)) {
			const strings = value.filter(
				(item): item is string =>
					typeof item === "string" && item.trim().length > 0,
			);
			if (strings.length > 0) {
				return strings.map((item) => item.trim());
			}
		}
	}
	return undefined;
}

function cloneJsonRecord(record: JsonRecord): JsonRecord {
	return JSON.parse(JSON.stringify(record)) as JsonRecord;
}

function getPlanFromParameters(
	params: Record<string, JsonValue | undefined>,
): JsonRecord | undefined {
	const plan = params.plan ?? params.currentPlan;
	return isJsonRecord(plan) ? plan : undefined;
}

function getPhases(plan: JsonRecord): JsonRecord[] {
	return Array.isArray(plan.phases)
		? plan.phases.filter((phase): phase is JsonRecord => isJsonRecord(phase))
		: [];
}

function getTasks(phase: JsonRecord): JsonRecord[] {
	return Array.isArray(phase.tasks)
		? phase.tasks.filter((task): task is JsonRecord => isJsonRecord(task))
		: [];
}

function countPlanTasks(plan: JsonRecord): number {
	return getPhases(plan).reduce(
		(total, phase) => total + getTasks(phase).length,
		0,
	);
}

function buildDefaultPhase(index: number, total: number): JsonRecord {
	const phaseNumber = index + 1;
	const phaseNames =
		total === 1
			? ["Setup and Execution"]
			: [
					"Discovery and Requirements",
					"Implementation",
					"Validation and Handoff",
				];
	const name = phaseNames[index] ?? `Phase ${phaseNumber}`;
	const taskVerb =
		phaseNumber === 1
			? "Define"
			: phaseNumber === total
				? "Validate"
				: "Execute";

	return {
		id: `phase_${phaseNumber}`,
		name,
		description: `${name} workstream`,
		tasks: [
			{
				id: `task_${phaseNumber}_1`,
				name: `${taskVerb} phase ${phaseNumber} deliverables`,
				description: `Produce the concrete outputs for ${name.toLowerCase()}.`,
				action: "REPLY",
				dependencies: phaseNumber > 1 ? [`task_${phaseNumber - 1}_1`] : [],
				estimatedDuration: "60 minutes",
			},
		],
	};
}

function buildPlan(params: Record<string, JsonValue | undefined>): JsonRecord {
	const goal =
		readStringParameter(params, ["goal", "description"]) ?? DEFAULT_PLAN_GOAL;
	const phaseCount = readPositiveIntegerParameter(
		params,
		["phaseCount", "phases"],
		1,
	);
	const name =
		readStringParameter(params, ["name", "title"]) ??
		(goal === DEFAULT_PLAN_GOAL
			? "Comprehensive Project Plan"
			: `${goal} Plan`);
	const successCriteria = readStringArrayParameter(params, [
		"successCriteria",
		"criteria",
	]) ?? ["All phases completed successfully"];

	return {
		id: uuidv4(),
		name,
		description: goal,
		createdAt: Date.now(),
		status: "draft",
		phases: Array.from({ length: phaseCount }, (_, index) =>
			buildDefaultPhase(index, phaseCount),
		),
		executionStrategy:
			readStringParameter(params, ["executionStrategy", "executionModel"]) ??
			"sequential",
		totalEstimatedDuration: `${phaseCount} hour${phaseCount === 1 ? "" : "s"}`,
		successCriteria,
	};
}

async function handleCreate(
	options: PlanningActionOptions | undefined,
	callback: HandlerCallback | undefined,
): Promise<ActionResult> {
	const plan = buildPlan(getParameters(options));
	const phases = getPhases(plan);
	const taskCount = countPlanTasks(plan);

	if (callback) {
		await callback({
			text: `I've created a comprehensive project plan with ${phases.length} phase(s).`,
			actions: ["PLAN"],
			source: "planning",
		});
	}

	return {
		success: true,
		data: {
			actionName: "PLAN",
			[CANONICAL_SUBACTION_KEY]: "create",
			phaseCount: phases.length,
			taskCount,
			planId: plan.id,
			plan,
		},
		text: `Created ${phases.length}-phase plan`,
	};
}

function handleUpdate(
	options: PlanningActionOptions | undefined,
): ActionResult {
	const params = getParameters(options);
	const plan = getPlanFromParameters(params);
	const planId =
		readStringParameter(params, ["planId", "id"]) ??
		(plan?.id && typeof plan.id === "string" ? plan.id : undefined);
	const updates: JsonRecord = {};
	const name = readStringParameter(params, ["name", "title"]);
	const description = readStringParameter(params, ["goal", "description"]);
	const status = readStringParameter(params, ["status"]);
	const notes = readStringParameter(params, ["notes", "feedback", "reason"]);
	const successCriteria = readStringArrayParameter(params, [
		"successCriteria",
		"criteria",
	]);

	if (name) {
		updates.name = name;
	}
	if (description) {
		updates.description = description;
	}
	if (status) {
		updates.status = status;
	}
	if (successCriteria) {
		updates.successCriteria = successCriteria;
	}

	if (!plan && !planId) {
		return planningFailureResult(
			"PLAN",
			"Cannot update plan without plan or planId",
			{
				[CANONICAL_SUBACTION_KEY]: "update",
				errorCode: "missing_plan",
			},
		);
	}

	if (Object.keys(updates).length === 0 && !notes) {
		return planningFailureResult("PLAN", "No plan updates were provided", {
			[CANONICAL_SUBACTION_KEY]: "update",
			errorCode: "empty_update",
			...(planId ? { planId } : {}),
		});
	}

	const revision: JsonRecord = {
		updatedAt: Date.now(),
		changes: Object.keys(updates),
	};
	if (notes) {
		revision.notes = notes;
	}

	if (!plan) {
		return {
			success: true,
			text: `Prepared update for plan ${planId}`,
			data: {
				actionName: "PLAN",
				[CANONICAL_SUBACTION_KEY]: "update",
				planId: planId ?? "",
				patch: {
					...updates,
					updatedAt: revision.updatedAt,
					revision,
				},
				requiresPersistence: true,
			},
		};
	}

	const updatedPlan = cloneJsonRecord(plan);
	for (const [key, value] of Object.entries(updates)) {
		updatedPlan[key] = value;
	}
	updatedPlan.updatedAt = revision.updatedAt;
	const existingHistory = Array.isArray(updatedPlan.revisionHistory)
		? updatedPlan.revisionHistory
		: [];
	updatedPlan.revisionHistory = [...existingHistory, revision];

	return {
		success: true,
		text: `Updated plan ${String(updatedPlan.id ?? planId ?? "")}`.trim(),
		data: {
			actionName: "PLAN",
			[CANONICAL_SUBACTION_KEY]: "update",
			planId: String(updatedPlan.id ?? planId ?? ""),
			updatedPlan,
			changeCount: Object.keys(updates).length,
			requiresPersistence: false,
		},
	};
}

function reviewPlan(plan: JsonRecord): JsonRecord {
	const errors: string[] = [];
	const warnings: string[] = [];
	const phases = getPhases(plan);

	if (typeof plan.id !== "string" || plan.id.trim().length === 0) {
		errors.push("Plan is missing id");
	}
	if (typeof plan.name !== "string" || plan.name.trim().length === 0) {
		warnings.push("Plan is missing name");
	}
	if (
		typeof plan.description !== "string" ||
		plan.description.trim().length === 0
	) {
		warnings.push("Plan is missing description");
	}
	if (phases.length === 0) {
		errors.push("Plan has no phases");
	}

	let taskCount = 0;
	for (const [phaseIndex, phase] of phases.entries()) {
		const phaseLabel =
			typeof phase.id === "string" && phase.id
				? phase.id
				: `phase ${phaseIndex + 1}`;
		const tasks = getTasks(phase);
		if (typeof phase.name !== "string" || phase.name.trim().length === 0) {
			warnings.push(`${phaseLabel} is missing name`);
		}
		if (tasks.length === 0) {
			errors.push(`${phaseLabel} has no tasks`);
		}
		taskCount += tasks.length;
		for (const [taskIndex, task] of tasks.entries()) {
			const taskLabel =
				typeof task.id === "string" && task.id
					? task.id
					: `${phaseLabel} task ${taskIndex + 1}`;
			if (typeof task.name !== "string" || task.name.trim().length === 0) {
				errors.push(`${taskLabel} is missing name`);
			}
			if (
				typeof task.description !== "string" ||
				task.description.trim().length === 0
			) {
				warnings.push(`${taskLabel} is missing description`);
			}
		}
	}

	if (
		!Array.isArray(plan.successCriteria) ||
		plan.successCriteria.length === 0
	) {
		warnings.push("Plan has no success criteria");
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		phaseCount: phases.length,
		taskCount,
		reviewedAt: Date.now(),
	};
}

function handleReview(
	options: PlanningActionOptions | undefined,
): ActionResult {
	const plan = getPlanFromParameters(getParameters(options));
	if (!plan) {
		return planningFailureResult(
			"PLAN",
			"Cannot review plan without plan data",
			{
				[CANONICAL_SUBACTION_KEY]: "review",
				errorCode: "missing_plan",
			},
		);
	}

	const review = reviewPlan(plan);
	const valid = review.valid === true;
	return {
		success: true,
		text: valid
			? `Reviewed plan ${String(plan.id ?? "")}: ready`
			: `Reviewed plan ${String(plan.id ?? "")}: ${Array.isArray(review.errors) ? review.errors.length : 0} issue(s)`,
		data: {
			actionName: "PLAN",
			[CANONICAL_SUBACTION_KEY]: "review",
			planId: String(plan.id ?? ""),
			review,
		},
	};
}

function handleFinalize(
	options: PlanningActionOptions | undefined,
): ActionResult {
	const params = getParameters(options);
	const plan = getPlanFromParameters(params);
	const planId =
		readStringParameter(params, ["planId", "id"]) ??
		(plan?.id && typeof plan.id === "string" ? plan.id : undefined);
	const notes = readStringParameter(params, ["notes", "summary"]);

	if (!plan && !planId) {
		return planningFailureResult(
			"PLAN",
			"Cannot finalize plan without plan or planId",
			{
				[CANONICAL_SUBACTION_KEY]: "finalize",
				errorCode: "missing_plan",
			},
		);
	}

	const finalizedAt = Date.now();
	const finalization: JsonRecord = {
		finalizedAt,
		status: "finalized",
	};
	if (notes) {
		finalization.notes = notes;
	}

	if (!plan) {
		return {
			success: true,
			text: `Prepared finalization for plan ${planId}`,
			data: {
				actionName: "PLAN",
				[CANONICAL_SUBACTION_KEY]: "finalize",
				planId: planId ?? "",
				finalization,
				requiresPersistence: true,
			},
		};
	}

	const finalizedPlan = cloneJsonRecord(plan);
	finalizedPlan.status = "finalized";
	finalizedPlan.finalizedAt = finalizedAt;
	finalizedPlan.updatedAt = finalizedAt;
	if (notes) {
		finalizedPlan.finalSummary = notes;
	}
	finalizedPlan.review = reviewPlan(finalizedPlan);

	return {
		success: true,
		text: `Finalized plan ${String(finalizedPlan.id ?? planId ?? "")}`.trim(),
		data: {
			actionName: "PLAN",
			[CANONICAL_SUBACTION_KEY]: "finalize",
			planId: String(finalizedPlan.id ?? planId ?? ""),
			finalizedPlan,
			requiresPersistence: false,
		},
	};
}

export const planAction: Action = {
	name: "PLAN",
	contexts: ["tasks", "automation", "code", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Project plan router. action=create makes multi-phase plans; update/review/finalize operate on supplied plan data or return persistence-ready patches.",
	similes: [
		"CREATE_PLAN",
		"PLAN_PROJECT",
		"GENERATE_PLAN",
		"MAKE_PLAN",
		"PROJECT_PLAN",
	],
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "action",
			description:
				"Operation: create | update | finalize | review. Default create.",
			required: false,
			schema: {
				type: "string",
				enum: [...PLAN_SUBACTIONS],
			},
		},
		{
			name: "goal",
			description: "Goal or project outcome.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "phaseCount",
			description: "Requested phase count.",
			required: false,
			schema: { type: "number" },
		},
		{
			name: "plan",
			description: "Existing plan object for update, review, or finalize.",
			required: false,
			schema: { type: "object" },
		},
		{
			name: "planId",
			description: "Existing plan id when only a patch/finalization is needed.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "notes",
			description: "Update, review, or finalization notes.",
			required: false,
			schema: { type: "string" },
		},
	],

	validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) => {
		return hasActionContext(message, state, {
			contexts: ["tasks", "automation", "code", "agent_internal"],
			keywordKeys: ["action.createPlan.request"],
		});
	},

	handler: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: PlanningActionOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const subaction = readPlanSubaction(options);
		try {
			if (subaction === "create") {
				return handleCreate(options, callback);
			}
			if (subaction === "update") {
				return handleUpdate(options);
			}
			if (subaction === "review") {
				return handleReview(options);
			}
			if (subaction === "finalize") {
				return handleFinalize(options);
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			const text = `Failed to ${subaction} plan: ${errorMessage}`;
			if (callback) {
				await callback({
					text,
					actions: ["PLAN"],
					source: "planning",
				});
			}
			return planningFailureResult("PLAN", text, {
				errorCode: "plan_action_failed",
				errorMessage,
				[CANONICAL_SUBACTION_KEY]: subaction,
			});
		}

		return planningFailureResult(
			"PLAN",
			`Unsupported plan action: ${subaction}`,
			{
				errorCode: "unsupported_plan_action",
				[CANONICAL_SUBACTION_KEY]: subaction,
			},
		);
	},
	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "Plan a project to migrate our auth service.",
					source: "chat",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Created a multi-phase plan.",
					actions: ["PLAN"],
					thought:
						"Open-ended migration request maps to PLAN with action=create; the planner returns phases and tasks.",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Build me a 3-phase plan for the website redesign.",
					source: "chat",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Created a 3-phase plan.",
					actions: ["PLAN"],
					thought:
						"Explicit phase count maps to PLAN with action=create and phaseCount=3.",
				},
			},
		],
	],
};
