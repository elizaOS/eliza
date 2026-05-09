/**
 * Enabled Skills Provider
 *
 * Surfaces the canonical list of enabled-and-eligible skills with descriptions
 * to the planning LLM. Renders right before action selection so USE_SKILL has
 * a current map of slugs to descriptions to invoke against.
 *
 * Empty when no skills are enabled — never pollutes the prompt.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";

const MAX_DESCRIPTION_CHARS = 120;
const MAX_SKILLS_LISTED = 50;

function truncateDescription(value: string): string {
	const cleaned = value.replace(/\s+/g, " ").trim();
	if (cleaned.length <= MAX_DESCRIPTION_CHARS) return cleaned;
	return `${cleaned.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

export const enabledSkillsProvider: Provider = {
	name: "enabled_skills",
	description:
		"Canonical list of enabled, eligible skills with descriptions for USE_SKILL",
	descriptionCompressed: "Enabled skills with descriptions for USE_SKILL.",
	position: -10,
	contexts: ["agent_internal", "settings"],
	contextGate: { anyOf: ["agent_internal", "settings"] },
	cacheStable: false,
	cacheScope: "turn",
	dynamic: true,

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const service = runtime.getService<AgentSkillsService>(
				"AGENT_SKILLS_SERVICE",
			);
			if (!service) return { text: "" };

			const eligible = await service.getEligibleSkills();
			const enabled = eligible.filter((skill) =>
				service.isSkillEnabled(skill.slug),
			);

			if (enabled.length === 0) {
				return { text: "" };
			}

			const listed = enabled.slice(0, MAX_SKILLS_LISTED);
			const remaining = enabled.length - listed.length;

		const lines = listed.map((skill) => {
			const description = truncateDescription(skill.description || "");
			const tail = description ? ` — ${description}` : "";
			return `- **${skill.name}** (\`${skill.slug}\`)${tail}`;
		});

		const overflow =
			remaining > 0
				? `\n\n…and ${remaining} more — use SKILL op=search to find them.`
				: "";

		const text =
			`## Enabled skills\n` +
			`Use USE_SKILL with one of these slugs to invoke:\n` +
			`${lines.join("\n")}${overflow}`;

			return {
				text,
				values: {
					enabledSkillCount: enabled.length,
					enabledSkillSlugs: listed.map((s) => s.slug).join(", "),
				},
				data: {
					enabledSkills: listed.map((skill) => ({
						slug: skill.slug,
						name: skill.name,
						description: skill.description,
					})),
					truncated: remaining > 0,
					totalEnabled: enabled.length,
				},
			};
		} catch {
			return { text: "", values: {}, data: {} };
		}
	},
};

export default enabledSkillsProvider;
