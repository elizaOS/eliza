import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../types/index.ts";
import {
	formatActionResultsForPrompt,
	MAX_ACTION_RESULT_TEXT_CHARS,
	truncateMiddle,
} from "../../../utils/action-results.js";
import { sliceToFitBudget } from "../../../utils/slice-to-fit-budget.js";
import { addHeader } from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("ACTION_STATE");
const ACTION_HISTORY_TARGET_CHARS = 20000;
const MAX_RUNS = 3;
const MAX_THOUGHT_CHARS = 2000;

type WorkingMemoryEntry = {
	actionName: string;
	result: ActionResult;
	timestamp: number;
};

function formatDataForPrompt(data: unknown): string {
	try {
		return JSON.stringify(data, null, 2);
	} catch {
		return String(data);
	}
}

/**
 * Provider for sharing action execution state and plan between actions
 * Makes previous action results and execution plan available to subsequent actions
 */
export const actionStateProvider: Provider = {
	name: spec.name,
	description: spec.description,
	position: spec.position ?? 150,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		try {
		const actionResults = state.data.actionResults ?? [];
		const actionPlan = state.data.actionPlan;
		const workingMemory = state.data.workingMemory;

		// Format action plan for display
		let planText = "";
		if (actionPlan && actionPlan.totalSteps > 1) {
			const completedSteps = actionPlan.steps.filter(
				(s) => s.status === "completed",
			).length;
			const failedSteps = actionPlan.steps.filter(
				(s) => s.status === "failed",
			).length;

			planText = addHeader(
				"# Action Execution Plan",
				[
					`**Plan:** ${actionPlan.thought}`,
					`**Progress:** Step ${actionPlan.currentStep} of ${actionPlan.totalSteps}`,
					`**Status:** ${completedSteps} completed, ${failedSteps} failed`,
					"",
					"## Steps:",
					...actionPlan.steps.map((step, index: number) => {
						const icon =
							step.status === "completed"
								? "✓"
								: step.status === "failed"
									? "✗"
									: index < actionPlan.currentStep - 1
										? "○"
										: index === actionPlan.currentStep - 1
											? "→"
											: "○";
						const status =
							step.status === "pending" && index === actionPlan.currentStep - 1
								? "in progress"
								: step.status;
						let stepText = `${icon} **Step ${index + 1}:** ${step.action} (${status})`;

						if (step.error) {
							stepText += `\n   Error: ${step.error}`;
						}
						if (step.result?.text) {
							stepText += `\n   Result: ${truncateMiddle(
								step.result.text,
								MAX_ACTION_RESULT_TEXT_CHARS,
							)}`;
						}

						return stepText;
					}),
					"",
				].join("\n"),
			);
		}

		// Format previous action results
		let resultsText = "";
		if (actionResults.length > 0) {
			resultsText = formatActionResultsForPrompt(actionResults, {
				header: "# Current Chain Action Results",
			});
		} else {
			resultsText = "";
		}

		// Format working memory
		let memoryText = "";
		if (workingMemory && Object.keys(workingMemory).length > 0) {
			const entries = Object.entries(workingMemory) as Array<
				[string, WorkingMemoryEntry]
			>;
			const topEntries: Array<[string, WorkingMemoryEntry]> = [];
			for (const entry of entries) {
				if (topEntries.length < 10) {
					topEntries.push(entry);
					topEntries.sort((a, b) => b[1].timestamp - a[1].timestamp);
					continue;
				}
				if (entry[1].timestamp > topEntries[9][1].timestamp) {
					topEntries[9] = entry;
					topEntries.sort((a, b) => b[1].timestamp - a[1].timestamp);
				}
			}
			const memoryEntries = topEntries
				.map(([key, entry]) => {
					const result: ActionResult = entry.result;
					const resultText =
						typeof result.text === "string" && result.text.trim().length > 0
							? truncateMiddle(result.text, MAX_ACTION_RESULT_TEXT_CHARS)
							: result.data
								? formatDataForPrompt(result.data)
								: "(no output)";
					return `**${entry.actionName || key}**: ${resultText}`;
				})
				.join("\n");

			memoryText = addHeader("# Working Memory", memoryEntries);
		}

		// Get recent action result memories from the database
		// Get messages with type 'action_result' from the room
		const recentMessages = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			limit: 20,
			unique: false,
		});

		const recentActionMemories = recentMessages.filter(
			(msg) => msg.content && msg.content.type === "action_result",
		);

		// Format recent action memories
		let actionMemoriesText = "";
		if (recentActionMemories.length > 0) {
			// Group by runId using Map
			const groupedByRun = new Map<string, Memory[]>();

			for (const mem of recentActionMemories) {
				const runId: string = String(mem.content?.runId || "unknown");
				if (!groupedByRun.has(runId)) {
					groupedByRun.set(runId, []);
				}
				const memories = groupedByRun.get(runId);
				if (memories) {
					memories.push(mem);
				}
			}

			// Take only the most recent runs, then apply budget trimming
			const allRuns = Array.from(groupedByRun.entries());
			const recentRuns = allRuns.slice(-MAX_RUNS);

			const selectedRuns = sliceToFitBudget(
				recentRuns,
				([runId, memories]) => {
					const textChars = memories.reduce((sum, memory) => {
						const content = memory.content;
						return (
							sum +
							String(content?.actionName || "").length +
							String(content?.actionStatus || "").length +
							String(content?.planStep || "").length +
							Math.min(
								String(content?.text || "").length,
								MAX_ACTION_RESULT_TEXT_CHARS,
							)
						);
					}, 0);
					return textChars + runId.length + 80;
				},
				ACTION_HISTORY_TARGET_CHARS,
				{ fromEnd: true },
			);

			const formattedMemories = selectedRuns
				.map(([runId, memories]) => {
					const sortedMemories = memories.sort(
						(a: Memory, b: Memory) => (a.createdAt || 0) - (b.createdAt || 0),
					);

					const runText = sortedMemories
						.map((mem: Memory) => {
							const memContent = mem.content;
							const actionName = memContent?.actionName || "Unknown";
							const status = memContent?.actionStatus || "unknown";
							const planStep = memContent?.planStep || "";
							const rawText = memContent?.text || "";
							const text = truncateMiddle(
								rawText,
								MAX_ACTION_RESULT_TEXT_CHARS,
							);

							let memText = `  - ${actionName} (${status})`;
							if (planStep) {
								memText += ` [${planStep}]`;
							}
							if (text && text !== `Executed action: ${actionName}`) {
								memText += `: ${text}`;
							}

							return memText;
						})
						.join("\n");

					const firstMemory = sortedMemories[0];
					const rawThought = String(firstMemory?.content?.planThought || "");
					const thought =
						rawThought.length > MAX_THOUGHT_CHARS
							? `${rawThought.slice(0, MAX_THOUGHT_CHARS)}…`
							: rawThought;
					return `**Run ${runId.slice(0, 8)}**${thought ? ` - ${thought}` : ""}\n${runText}`;
				})
				.join("\n\n");

			actionMemoriesText = addHeader(
				"# Recent Action History",
				formattedMemories,
			);
		}

		// Combine all text sections
		const allText = [planText, resultsText, memoryText, actionMemoriesText]
			.filter(Boolean)
			.join("\n\n");

			return {
				data: {
					actionResults,
					actionPlan,
					workingMemory,
					recentActionMemories,
				},
				values: {
					hasActionResults: actionResults.length > 0,
					hasActionPlan: !!actionPlan,
					currentActionStep: actionPlan?.currentStep || 0,
					totalActionSteps: actionPlan?.totalSteps || 0,
					actionResults: resultsText,
					completedActions: actionResults.filter((r) => r.success).length,
					failedActions: actionResults.filter((r) => !r.success).length,
				},
				text: allText || "No action state available",
			};
		} catch (error) {
			return {
				data: {
					actionResults: [],
					actionPlan: null,
					workingMemory: null,
					recentActionMemories: [],
					error: error instanceof Error ? error.message : String(error),
				},
				values: {
					hasActionResults: false,
					hasActionPlan: false,
					currentActionStep: 0,
					totalActionSteps: 0,
					actionResults: "",
					completedActions: 0,
					failedActions: 0,
				},
				text: "No action state available",
			};
		}
	},
};
