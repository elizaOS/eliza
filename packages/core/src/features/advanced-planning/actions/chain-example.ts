import { v4 as uuidv4 } from "uuid";
import type {
	Action,
	ActionResult,
	AgentContext,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import type { JsonValue } from "../types.ts";

const PLANNING_CONTEXTS = [
	"general",
	"tasks",
	"automation",
	"agent_internal",
] satisfies AgentContext[];
const PLANNING_KEYWORD_KEYS = [
	"action.createPlan.request",
	"action.triggerCreate.request",
	"validate.taskIntent",
];

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

export const analyzeInputAction: Action = {
	name: "ANALYZE_INPUT",
	contexts: PLANNING_CONTEXTS,
	roleGate: { minRole: "USER" },
	description: "Analyzes user input and extracts key information",
	parameters: [
		{
			name: "input",
			description:
				"Optional text to analyze. Defaults to the current message text.",
			required: false,
			schema: { type: "string" },
		},
	],

	validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) =>
		hasActionContextOrKeyword(message, state, {
			contexts: PLANNING_CONTEXTS,
			keywordKeys: PLANNING_KEYWORD_KEYS,
			keywords: ["analyze", "analysis", "break down", "inspect input"],
		}),

	handler: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: PlanningActionOptions,
		_callback?: HandlerCallback,
	): Promise<ActionResult> => {
		if (options?.abortSignal?.aborted) {
			return planningFailureResult(
				"ANALYZE_INPUT",
				"Input analysis was canceled before it could finish.",
				{ errorCode: "analysis_aborted" },
			);
		}

		const text = message.content.text || "";
		const words = text.trim() ? text.split(/\s+/) : [];
		const hasNumbers = /\d/.test(text);
		const lowerText = text.toLowerCase();
		const sentiment =
			lowerText.includes("urgent") ||
			lowerText.includes("emergency") ||
			lowerText.includes("critical")
				? "urgent"
				: lowerText.includes("good")
					? "positive"
					: lowerText.includes("bad")
						? "negative"
						: "neutral";

		const analysis = {
			wordCount: words.length,
			hasNumbers,
			sentiment,
			topics: words.filter((w) => w.length >= 5).map((w) => w.toLowerCase()),
			timestamp: Date.now(),
		};

		return {
			success: true,
			data: analysis,
			text: `Analyzed ${words.length} words with ${sentiment} sentiment`,
		};
	},
};

export const processAnalysisAction: Action = {
	name: "PROCESS_ANALYSIS",
	contexts: PLANNING_CONTEXTS,
	roleGate: { minRole: "USER" },
	description: "Processes the analysis results and makes decisions",
	parameters: [],

	validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) =>
		hasActionContextOrKeyword(message, state, {
			contexts: PLANNING_CONTEXTS,
			keywordKeys: PLANNING_KEYWORD_KEYS,
			keywords: ["process analysis", "next step", "decide", "decision"],
		}),

	handler: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: PlanningActionOptions,
		_callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const previousResults =
			options?.previousResults ?? options?.actionContext?.previousResults;
		const previousResult = previousResults?.[0];
		if (!previousResult?.data) {
			return planningFailureResult(
				"PROCESS_ANALYSIS",
				"No analysis data was available to process.",
				{ errorCode: "missing_analysis_data" },
			);
		}

		const data = previousResult.data as {
			wordCount: number;
			sentiment: string;
		};

		const decisions = {
			needsMoreInfo: data.wordCount < 5,
			isComplex: data.wordCount > 20,
			requiresAction: data.sentiment !== "neutral" || data.wordCount > 8,
			suggestedResponse:
				data.sentiment === "positive"
					? "Thank you for the positive feedback!"
					: data.sentiment === "negative"
						? "I understand your concerns and will help address them."
						: "I can help you with that.",
		};

		await new Promise((resolve) => setTimeout(resolve, 200));

		if (options?.abortSignal?.aborted) {
			return planningFailureResult(
				"PROCESS_ANALYSIS",
				"Analysis processing was canceled before it could finish.",
				{ errorCode: "processing_aborted" },
			);
		}

		return {
			success: true,
			data: {
				analysis: data,
				decisions,
				processedAt: Date.now(),
				// Chain control flags stored in data for downstream access
				shouldContinue: !decisions.needsMoreInfo,
			},
			text: decisions.suggestedResponse,
			continueChain: !decisions.needsMoreInfo,
		};
	},
};

export const executeFinalAction: Action = {
	name: "EXECUTE_FINAL",
	contexts: PLANNING_CONTEXTS,
	roleGate: { minRole: "USER" },
	description: "Executes the final action based on processing results",
	suppressPostActionContinuation: true,
	parameters: [],

	validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) =>
		hasActionContextOrKeyword(message, state, {
			contexts: PLANNING_CONTEXTS,
			keywordKeys: PLANNING_KEYWORD_KEYS,
			keywords: [
				"execute final",
				"finish plan",
				"final action",
				"complete plan",
			],
		}),

	handler: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: PlanningActionOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const previousResults =
			options?.previousResults ?? options?.actionContext?.previousResults;
		const processingResult = previousResults?.find(
			(r) =>
				(r.data as Record<string, JsonValue> | undefined)?.decisions !==
				undefined,
		);

		const processingData = processingResult?.data as
			| { decisions?: { suggestedResponse: string; requiresAction: boolean } }
			| undefined;

		if (!processingData?.decisions) {
			return planningFailureResult(
				"EXECUTE_FINAL",
				"No processed planning result was available to execute.",
				{ errorCode: "missing_processing_results" },
			);
		}

		const execution = {
			action: processingData.decisions.requiresAction ? "REPLY" : "ACKNOWLEDGE",
			message: processingData.decisions.suggestedResponse,
			metadata: {
				chainId: options?.chainContext?.chainId,
				totalSteps: options?.chainContext?.totalActions,
				completedAt: Date.now(),
			},
		};

		await new Promise((resolve) => setTimeout(resolve, 100));

		if (callback) {
			await callback({
				text: execution.message,
				source: "chain_example",
			});
		}

		return {
			success: true,
			data: {
				actionName: "EXECUTE_FINAL",
				...execution,
				metadata: {
					chainId: String(execution.metadata.chainId || ""),
					totalSteps: Number(execution.metadata.totalSteps || 0),
					completedAt: Number(execution.metadata.completedAt || Date.now()),
				},
			},
			text: execution.message,
		};
	},
};

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
		return hasActionContextOrKeyword(message, state, {
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
};
