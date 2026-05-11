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

async function handleCreate(
	callback: HandlerCallback | undefined,
): Promise<ActionResult> {
	const plan = {
		id: uuidv4(),
		name: "Comprehensive Project Plan",
		description: "Multi-phase project plan with coordinated execution",
		createdAt: Date.now(),
		phases: [
			{
				id: "phase_1",
				name: "Setup and Infrastructure",
				description: "Initial project setup and infrastructure creation",
				tasks: [
					{
						id: "task_1_1",
						name: "Repository Setup",
						description:
							"Create GitHub repository with proper documentation",
						action: "CREATE_GITHUB_REPO",
						dependencies: [],
						estimatedDuration: "30 minutes",
					},
				],
			},
		],
		executionStrategy: "sequential",
		totalEstimatedDuration: "4 hours",
		successCriteria: ["All phases completed successfully"],
	};

	if (callback) {
		await callback({
			text: `I've created a comprehensive project plan with ${plan.phases.length} phase(s).`,
			actions: ["PLAN"],
			source: "planning",
		});
	}

	return {
		success: true,
		data: {
			actionName: "PLAN",
			[CANONICAL_SUBACTION_KEY]: "create",
			phaseCount: plan.phases.length,
			taskCount: plan.phases.reduce(
				(total, phase) => total + phase.tasks.length,
				0,
			),
			planId: plan.id,
		},
		text: `Created ${plan.phases.length}-phase plan`,
	};
}

function notYetImplemented(subaction: PlanSubaction): ActionResult {
	const text = `PLAN action=${subaction} not yet implemented`;
	return {
		success: false,
		text,
		error: text,
		data: {
			actionName: "PLAN",
			[CANONICAL_SUBACTION_KEY]: subaction,
			errorCode: "not_implemented",
		},
	};
}

export const planAction: Action = {
	name: "PLAN",
	contexts: ["tasks", "automation", "code", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Project planning router. action=create generates a multi-phase plan; update/finalize/review are reserved for future use.",
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
				"Operation: create | update | finalize | review. Defaults to create when omitted.",
			required: false,
			schema: {
				type: "string",
				enum: [...PLAN_SUBACTIONS],
			},
		},
		{
			name: "goal",
			description: "Optional goal or project outcome for the generated plan.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "phaseCount",
			description: "Optional requested number of plan phases.",
			required: false,
			schema: { type: "number" },
		},
	],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	) => {
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
				return await handleCreate(callback);
			}
			return notYetImplemented(subaction);
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
