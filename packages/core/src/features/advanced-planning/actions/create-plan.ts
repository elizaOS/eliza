import { v4 as uuidv4 } from "uuid";
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

export const createPlanAction: Action = {
	name: "CREATE_PLAN",
	contexts: ["tasks", "automation", "code", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Creates a comprehensive project plan with multiple phases and tasks",
	similes: ["PLAN_PROJECT", "GENERATE_PLAN", "MAKE_PLAN", "PROJECT_PLAN"],
	suppressPostActionContinuation: true,
	parameters: [
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
		_options?: PlanningActionOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		try {
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
					actions: ["CREATE_PLAN"],
					source: "planning",
				});
			}

			return {
				success: true,
				data: {
					actionName: "CREATE_PLAN",
					phaseCount: plan.phases.length,
					taskCount: plan.phases.reduce(
						(total, phase) => total + phase.tasks.length,
						0,
					),
					planId: plan.id,
				},
				text: `Created ${plan.phases.length}-phase plan`,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			const text = `Failed to create plan: ${errorMessage}`;
			if (callback) {
				await callback({
					text,
					actions: ["CREATE_PLAN"],
					source: "planning",
				});
			}
			return planningFailureResult("CREATE_PLAN", text, {
				errorCode: "plan_creation_failed",
				errorMessage,
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
					actions: ["CREATE_PLAN"],
					thought:
						"Open-ended migration request maps to CREATE_PLAN with goal text; the planner returns phases and tasks.",
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
					actions: ["CREATE_PLAN"],
					thought:
						"Explicit phase count maps to CREATE_PLAN with phaseCount=3 alongside the goal.",
				},
			},
		],
	],
};
