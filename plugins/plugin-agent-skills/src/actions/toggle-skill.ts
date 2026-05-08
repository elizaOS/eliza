/**
 * Toggle Skill Action
 *
 * Allows the agent to enable or disable an installed skill.
 * Respects security scan acknowledgment requirements — skills
 * with unacknowledged findings cannot be enabled.
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
import { detectEnableIntent, extractSlugFromMessage } from "./parse-helpers";
import { createAgentSkillsActionValidator } from "./validators";

export const toggleSkillAction = {
	name: "SKILL",
	contexts: ["automation", "settings"],
	contextGate: { anyOf: ["automation", "settings"] },
	roleGate: { minRole: "USER" },
	similes: [],
	description:
		"Enable or disable an installed skill. Say 'enable <skill>' or 'disable <skill>'.",
	descriptionCompressed: "Enable/disable installed skill.",
	parameters: [
		{
			name: "slug",
			description: "Installed skill slug or name to enable or disable.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "enabled",
			description: "Whether to enable true or disable false the skill.",
			required: false,
			schema: { type: "boolean" },
		},
	],
	validate: createAgentSkillsActionValidator({
		keywords: [
			"enable",
			"disable",
			"toggle",
			"skill",
			"activate",
			"deactivate",
		],
		regex:
			/\b(?:enable|disable|toggle|activate|deactivate|turn\s+on|turn\s+off)\b.*\bskill\b|\bskill\b.*\b(?:enable|disable|toggle|activate|deactivate)\b/i,
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
		const enable = detectEnableIntent(text);

		if (!slug) {
			const errorText =
				"I couldn't determine which skill to toggle. " +
				'Please specify the skill name, e.g. "enable weather" or "disable github".';
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		if (enable === null) {
			const errorText =
				"I couldn't determine whether to enable or disable the skill. " +
				`Please say "enable ${slug}" or "disable ${slug}".`;
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		// Find the skill — check both exact slug and fuzzy name match
		const loadedSkills = service.getLoadedSkills();
		const exactMatch = loadedSkills.find(
			(s) => s.slug === slug || s.name.toLowerCase() === slug,
		);
		const fuzzyMatch =
			exactMatch ??
			loadedSkills.find(
				(s) => s.slug.includes(slug) || s.name.toLowerCase().includes(slug),
			);

		if (!fuzzyMatch) {
			const available = loadedSkills
				.slice(0, 10)
				.map((s) => s.slug)
				.join(", ");
			const errorText = `Skill "${slug}" not found. Available skills: ${available}`;
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		// Actually toggle via the service's public method.
		// This checks scan status internally and returns false if blocked.
		const toggled = service.setSkillEnabled(fuzzyMatch.slug, enable);

		if (!toggled && enable) {
			// Toggle was rejected — most likely due to unacknowledged scan findings
			const scanStatus = service.getSkillScanStatus(fuzzyMatch.slug);
			const report = await service.getSkillScanReport(fuzzyMatch.slug);
			const findingCount = report
				? report.findings.length + report.manifestFindings.length
				: 0;
			const errorText =
				`Cannot enable "${fuzzyMatch.name}" — it has ${findingCount} security finding(s) ` +
				`(scan status: ${scanStatus ?? "unknown"}). ` +
				"The user must review and acknowledge the findings in the Eliza app before this skill can be enabled.";
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		if (!toggled) {
			const errorText = `Failed to ${enable ? "enable" : "disable"} skill "${fuzzyMatch.slug}".`;
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const action = enable ? "enabled" : "disabled";
		const resultText = `Skill **${fuzzyMatch.name}** (\`${fuzzyMatch.slug}\`) has been ${action}.`;

		if (callback) await callback({ text: resultText });

		return {
			success: true,
			text: resultText,
			data: {
				slug: fuzzyMatch.slug,
				name: fuzzyMatch.name,
				enabled: enable,
			},
		};
	},

	examples: [
		[
			{
				name: "{{userName}}",
				content: { text: "Enable the weather skill" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Skill **Weather** (`weather`) has been enabled.",
					actions: ["SKILL"],
				},
			},
		],
		[
			{
				name: "{{userName}}",
				content: { text: "Disable the github skill" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Skill **GitHub** (`github`) has been disabled.",
					actions: ["SKILL"],
				},
			},
		],
	],
} satisfies Action;

export default toggleSkillAction;
