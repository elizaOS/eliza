import { logger } from "../../../../logger.ts";
import type { Provider, ProviderResult } from "../../../../types/components.ts";
import type { Memory } from "../../../../types/memory.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { State } from "../../../../types/state.ts";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { ExperienceService } from "../service";
import { formatExperienceForPrompt } from "../utils/experienceFormatter.ts";

/**
 * Simple experience provider that injects relevant experiences into context
 * Similar to the knowledge provider but focused on agent learnings
 */
const spec = requireProviderSpec("experienceProvider");

export const experienceProvider: Provider = {
	name: spec.name,
	description:
		"Provides relevant past experiences and learnings for the current context",

	dynamic: true,
	async get(
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> {
		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;

		if (!experienceService) {
			return { text: "", data: {}, values: {} };
		}

		// Get message text for context
		const messageText = message.content.text || "";
		if (messageText.length < 10) {
			return { text: "", data: {}, values: {} };
		}

		const semanticExperiences = await experienceService.queryExperiences({
			query: messageText,
			limit: 5,
			minConfidence: 0.6,
			minImportance: 0.5,
			includeRelated: true,
		});
		const topExperiences = await experienceService.listExperiences({
			limit: 3,
			minConfidence: 0.7,
			minImportance: 0.7,
		});
		const relevantExperiences = [
			...new Map(
				[...semanticExperiences, ...topExperiences].map((experience) => [
					experience.id,
					experience,
				]),
			).values(),
		].slice(0, 7);

		if (relevantExperiences.length === 0) {
			return { text: "", data: {}, values: {} };
		}

		// Format experiences for context injection
		const experienceText = relevantExperiences
			.map((experience, index) => formatExperienceForPrompt(experience, index))
			.join("\n\n");

		const contextText = `[RELEVANT EXPERIENCES]\n${experienceText}\n[/RELEVANT EXPERIENCES]`;

		logger.debug(
			`[experienceProvider] Injecting ${relevantExperiences.length} relevant experiences`,
		);

		return {
			text: contextText,
			data: {
				experiences: relevantExperiences,
				count: relevantExperiences.length,
			},
			values: {
				experienceCount: relevantExperiences.length.toString(),
			},
		};
	},
};
