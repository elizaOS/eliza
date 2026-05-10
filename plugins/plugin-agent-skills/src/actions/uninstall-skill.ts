/**
 * Uninstall Skill Action
 *
 * Allows the agent to uninstall a non-bundled skill.
 * Bundled skills are read-only and cannot be removed.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { requireConfirmation } from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";
import { extractSlugFromMessage } from "./parse-helpers";
import { createAgentSkillsActionValidator } from "./validators";

const INSTALLED_SKILL_MATCH_LIMIT = 100;

export const uninstallSkillAction = {
	name: "SKILL",
	contexts: ["automation", "settings"],
	contextGate: { anyOf: ["automation", "settings"] },
	roleGate: { minRole: "USER" },
	similes: [
		"UNINSTALL_SKILL",
		"REMOVE_SKILL",
		"DELETE_SKILL",
		"PURGE_SKILL",
		"DROP_SKILL",
	],
	description:
		"Uninstall a non-bundled skill. Bundled skills cannot be removed. " +
		'Provide the skill slug, e.g. "uninstall weather".',
	descriptionCompressed: "Remove non-bundled skill.",
	parameters: [
		{
			name: "slug",
			description: "Installed skill slug or name to uninstall.",
			required: false,
			schema: { type: "string" },
		},
	],
	validate: createAgentSkillsActionValidator({
		keywords: ["uninstall", "remove", "delete", "skill"],
		regex:
			/\b(?:uninstall|remove|delete)\b.*\bskill\b|\bskill\b.*\b(?:uninstall|remove|delete)\b/i,
	}),

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		_options: unknown,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const service = runtime.getService<AgentSkillsService>(
			"AGENT_SKILLS_SERVICE",
		);
		if (!service) {
			const errorText = "AgentSkillsService not available.";
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const text = message.content?.text || "";
		const slug = extractSlugFromMessage(text);

		if (!slug) {
			const errorText =
				"I couldn't determine which skill to uninstall. " +
				'Please specify the skill name, e.g. "uninstall weather".';
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		// Find the skill
		const loadedSkills = service.getLoadedSkills().slice(0, INSTALLED_SKILL_MATCH_LIMIT);
		const match =
			loadedSkills.find(
				(s) => s.slug === slug || s.name.toLowerCase() === slug.toLowerCase(),
			) ??
			loadedSkills.find(
				(s) => s.slug.includes(slug) || s.name.toLowerCase().includes(slug),
			);

		if (!match) {
			const errorText = `Skill "${slug}" not found in installed skills.`;
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		// Check if bundled
		if (match.source === "bundled" || match.source === "plugin") {
			const errorText =
				`Skill **${match.name}** (\`${match.slug}\`) is a ${match.source} skill and cannot be uninstalled. ` +
				"You can disable it instead with: disable " +
				match.slug;
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const decision = await requireConfirmation({
			runtime,
			message,
			actionName: "SKILL",
			pendingKey: `uninstall:${match.slug}`,
			prompt: `Uninstall skill **${match.name}** (\`${match.slug}\`)? This removes its files. Reply "yes" to confirm.`,
			callback,
			metadata: { slug: match.slug, name: match.name },
		});
		if (decision.status === "pending") {
			return { success: true, data: { awaitingUserInput: true, slug: match.slug } };
		}
		if (decision.status === "cancelled") {
			const cancelText = `Uninstall of ${match.slug} cancelled.`;
			if (callback) await callback({ text: cancelText });
			return { success: true, text: cancelText, data: { cancelled: true, slug: match.slug } };
		}

		const success = await service.uninstall(match.slug);

		if (!success) {
			const errorText = `Failed to uninstall skill "${match.slug}".`;
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const resultText = `Skill **${match.name}** (\`${match.slug}\`) has been uninstalled.`;
		if (callback) await callback({ text: resultText });

		return {
			success: true,
			text: resultText,
			data: { slug: match.slug, name: match.name },
		};
	},

	examples: [
		[
			{
				name: "{{userName}}",
				content: { text: "Uninstall the weather skill" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Skill **Weather** (`weather`) has been uninstalled.",
					actions: ["SKILL"],
				},
			},
		],
	],
} satisfies Action;

export default uninstallSkillAction;
