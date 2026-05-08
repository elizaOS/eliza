/**
 * Get Skill Details Action
 *
 * Get detailed information about a specific skill from the registry.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";
import { createAgentSkillsActionValidator } from "./validators";

type GetSkillDetailsOptions = {
	parameters?: {
		slug?: unknown;
	};
	slug?: unknown;
};

const SKILL_DETAILS_TEXT_MAX_CHARS = 4_000;

function truncateSkillDetailsText(text: string): string {
	return text.length <= SKILL_DETAILS_TEXT_MAX_CHARS
		? text
		: `${text.slice(0, SKILL_DETAILS_TEXT_MAX_CHARS)}\n\n[truncated skill details]`;
}

export const getSkillDetailsAction = {
	name: "SKILL",
	contexts: ["knowledge", "automation", "settings"],
	contextGate: { anyOf: ["knowledge", "automation", "settings"] },
	roleGate: { minRole: "USER" },
	similes: ["SKILL_INFO", "SKILL_DETAILS"],
	description:
		"Get detailed information about a specific skill including version, owner, and stats.",
	descriptionCompressed: "Get skill version, owner, stats.",
	validate: createAgentSkillsActionValidator({
		keywords: ["get", "skill", "details", "info", "tell", "more"],
		regex: /\b(?:skill|details|info|tell\s+me\s+about)\b/i,
	}),

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options: unknown,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		try {
			const service = runtime.getService<AgentSkillsService>(
				"AGENT_SKILLS_SERVICE",
			);
			if (!service) {
				throw new Error("AgentSkillsService not available");
			}

			const opts = options as GetSkillDetailsOptions | undefined;
			const explicitSlug =
				typeof opts?.parameters?.slug === "string"
					? opts.parameters.slug
					: typeof opts?.slug === "string"
						? opts.slug
						: null;
			const slug =
				explicitSlug || extractSlugFromText(message.content?.text || "");

			if (!slug) {
				return {
					success: false,
					error: new Error("Skill slug is required"),
				};
			}

			const details = await service.getSkillDetails(slug);
			if (!details) {
				const text = `Skill "${slug}" not found in the registry.`;
				if (callback) await callback({ text });
				return { success: false, error: new Error(text) };
			}

			const isInstalled = await service.isInstalled(slug);

			const text = `## ${details.skill.displayName}

**Slug:** \`${details.skill.slug}\`
**Version:** ${details.latestVersion.version}
**Status:** ${isInstalled ? "✅ Installed" : "📦 Available"}

${details.skill.summary}

**Stats:**
- Downloads: ${details.skill.stats.downloads}
- Stars: ${details.skill.stats.stars}
- Versions: ${details.skill.stats.versions}

${details.owner ? `**Author:** ${details.owner.displayName} (@${details.owner.handle})` : ""}

${details.latestVersion.changelog ? `**Changelog:** ${details.latestVersion.changelog}` : ""}`;
			const boundedText = truncateSkillDetailsText(text);

			if (callback) await callback({ text: boundedText });

			return {
				success: true,
				text: boundedText,
				data: {
					details,
					isInstalled,
					outputTruncated: boundedText !== text,
				},
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (callback) {
				await callback({ text: `Error getting skill details: ${errorMsg}` });
			}
			return {
				success: false,
				error: error instanceof Error ? error : new Error(errorMsg),
			};
		}
	},

	parameters: [
		{
			name: "slug",
			description: "Skill slug to inspect, e.g. pdf-processing.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	examples: [
		[
			{
				name: "{{userName}}",
				content: { text: "Tell me about the pdf-processing skill" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "## PDF Processing\n\n**Slug:** `pdf-processing`\n**Version:** 1.2.0\n**Status:** ✅ Installed...",
					actions: ["SKILL"],
				},
			},
		],
	],
} satisfies Action;

function extractSlugFromText(text: string): string | null {
	// Try to extract a slug-like pattern
	const match = text.match(/\b([a-z][a-z0-9-]*[a-z0-9])\b/);
	return match ? match[1] : null;
}

export default getSkillDetailsAction;
