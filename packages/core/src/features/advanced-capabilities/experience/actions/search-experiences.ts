import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
} from "../../../../types/components.ts";
import type { Memory } from "../../../../types/memory.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { State } from "../../../../types/state.ts";
import type { ExperienceService } from "../service.ts";
import { formatExperienceForPrompt } from "../utils/experienceFormatter.ts";

const SEARCH_EXPERIENCES = "SEARCH_EXPERIENCES";

export const searchExperiencesAction: Action = {
	name: SEARCH_EXPERIENCES,
	similes: [
		"FIND_EXPERIENCES",
		"SEARCH_MEMORY_GRAPH",
		"EXPLORE_EXPERIENCES",
		"WHAT_HAVE_I_LEARNED",
	],
	description:
		"Search the agent's experience graph, return compact learnings, and provide follow-up actions for copying or chaining results.",
	examples: [
		[
			{
				name: "{{user}}",
				content: {
					text: "Search experiences about TypeScript build failures",
					actions: [SEARCH_EXPERIENCES],
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "I found matching experiences and a small related graph.",
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		const text =
			typeof message.content.text === "string"
				? message.content.text.toLowerCase()
				: "";
		if (!runtime.getService("EXPERIENCE")) {
			return false;
		}
		return (
			/\b(experience|experiences|learned|learning|memory graph)\b/.test(text) &&
			/\b(search|find|explore|what|show|recall|know)\b/.test(text)
		);
	},

	async handler(
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> {
		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;
		if (!experienceService) {
			return {
				success: false,
				text: "Experience service is unavailable.",
			};
		}

		const query = extractExperienceSearchQuery(message);
		const experiences = await experienceService.queryExperiences({
			query,
			limit: 7,
			minConfidence: 0.3,
			includeRelated: true,
		});
		const graph = await experienceService.getExperienceGraph({
			query,
			limit: 20,
			minConfidence: 0.3,
			includeRelated: true,
		});

		const resultText =
			experiences.length > 0
				? experiences
						.map((experience, index) =>
							formatExperienceForPrompt(experience, index),
						)
						.join("\n\n")
				: `No experiences found for "${query}".`;

		const text = `[EXPERIENCE SEARCH]\nQuery: ${query}\nMatches: ${experiences.length}\nGraph: ${graph.nodes.length} nodes, ${graph.links.length} links\n\n${resultText}`;
		if (callback) {
			await callback(
				{
					text,
					actions: [SEARCH_EXPERIENCES],
					source: message.content.source,
				},
				SEARCH_EXPERIENCES,
			);
		}

		logger.info(
			`[SearchExperiencesAction] Returned ${experiences.length} experiences for query "${query}"`,
		);

		return {
			success: true,
			text,
			data: {
				query,
				experiences,
				graph,
				postActions: [
					{
						id: "copy-experience-results",
						label: "Copy experience search results",
						action: "CLIPBOARD_WRITE",
						input: {
							title: `Experience search: ${query}`,
							content: resultText,
							tags: ["experience-search", "experience-graph"],
						},
					},
				],
			},
			values: {
				experienceSearchQuery: query,
				experienceSearchCount: String(experiences.length),
			},
			continueChain: experiences.length > 0,
		};
	},
};

function extractExperienceSearchQuery(message: Memory): string {
	const text =
		typeof message.content.text === "string" ? message.content.text : "";
	const normalized = text
		.replace(
			/^\s*(?:please\s+)?(?:search|find|explore|show|recall)\s+(?:my\s+|the\s+)?(?:experience|experiences|memory graph|learnings?)\s*(?:for|about|on)?\s*/i,
			"",
		)
		.replace(
			/^\s*what\s+(?:do\s+you|have\s+you|did\s+you)\s+(?:know|learn|remember)\s+(?:about|on)?\s*/i,
			"",
		)
		.trim();

	return normalized || text.trim() || "recent useful experiences";
}
