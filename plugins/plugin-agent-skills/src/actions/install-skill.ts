/**
 * Install Skill Action
 *
 * Allows the agent to explicitly install a skill from the ClawHub registry.
 * All installed skills go through the security scanner automatically.
 * Blocked skills are rejected; skills with findings start disabled.
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
import { extractSlugFromMessage } from "./parse-helpers";
import { createAgentSkillsActionValidator } from "./validators";

const SKILL_SEARCH_LIMIT = 5;
const SKILL_INSTALL_TEXT_MAX_CHARS = 3_000;

function truncateInstallSkillText(text: string): string {
	return text.length <= SKILL_INSTALL_TEXT_MAX_CHARS
		? text
		: `${text.slice(0, SKILL_INSTALL_TEXT_MAX_CHARS)}\n\n[truncated install result]`;
}

export const installSkillAction: Action = {
	name: "INSTALL_SKILL",
	contexts: ["automation", "settings", "connectors"],
	contextGate: { anyOf: ["automation", "settings", "connectors"] },
	roleGate: { minRole: "USER" },
	similes: ["DOWNLOAD_SKILL", "ADD_SKILL", "GET_SKILL"],
	description:
		"Install a skill from the ClawHub registry. The skill will be security-scanned before activation. " +
		'Provide a skill slug or search term, e.g. "install weather" or "add github".',
	descriptionCompressed:
		"Install skill from ClawHub registry. Security-scanned before activation.",
	parameters: [
		{
			name: "slug",
			description: "Skill slug or search term to install.",
			required: false,
			schema: { type: "string" },
		},
	],
	validate: createAgentSkillsActionValidator({
		keywords: ["install", "download", "add", "get", "skill"],
		regex:
			/\b(?:install|download|add|get)\b.*\bskill\b|\bskill\b.*\b(?:install|download|add)\b/i,
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
				"I couldn't determine which skill to install. " +
				'Please specify a skill name or slug, e.g. "install weather".';
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		// Check if already installed
		const loadedSkills = service.getLoadedSkills();
		const existing = loadedSkills.find(
			(s) => s.slug === slug || s.name.toLowerCase() === slug.toLowerCase(),
		);
		if (existing) {
			const resultText = `Skill **${existing.name}** (\`${existing.slug}\`) is already installed.`;
			if (callback) await callback({ text: resultText });
			return {
				success: true,
				text: resultText,
				data: { slug: existing.slug, alreadyInstalled: true },
			};
		}

		// Try to find the skill in the registry first
		if (callback) {
			await callback({
				text: `Searching for "${slug}" in the skill registry...`,
			});
		}

		// Search to find best match
		const searchResults = await service.search(slug, SKILL_SEARCH_LIMIT);
		const bestMatch =
			searchResults.find(
				(r) =>
					r.slug === slug || r.displayName.toLowerCase() === slug.toLowerCase(),
			) ?? searchResults[0];

		if (!bestMatch) {
			const errorText = `No skill matching "${slug}" found in the registry.`;
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		// Install the best match
		const installSlug = bestMatch.slug;
		if (callback) {
			await callback({
				text: `Installing **${bestMatch.displayName}** (\`${installSlug}\`)...`,
			});
		}

		const success = await service.install(installSlug);

		if (!success) {
			// install() returns false for any failure: network errors, blocked
			// by security scan (skill is auto-deleted), or other issues.
			// The service logs the specific reason; we give a general message
			// since a blocked skill is already removed and its report is gone.
			const errorText =
				`Failed to install skill "${installSlug}". ` +
				"It may have been blocked by the security scanner (check logs for details).";
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		// Check scan status of the installed skill
		const scanStatus = service.getSkillScanStatus(installSlug);
		let resultText = `Skill **${bestMatch.displayName}** (\`${installSlug}\`) installed successfully.`;

		if (scanStatus === "critical" || scanStatus === "warning") {
			const report = await service.getSkillScanReport(installSlug);
			const findingCount = report
				? report.findings.length + report.manifestFindings.length
				: 0;
			resultText +=
				`\n\n**Security notice:** The skill has ${findingCount} security finding(s) ` +
				`(status: ${scanStatus}). It has been installed but is **disabled** until the ` +
				"user reviews and acknowledges the findings in the Eliza app.";
		} else {
			resultText += " The skill passed security scanning and is ready to use.";
		}

		const boundedResultText = truncateInstallSkillText(resultText);
		if (callback) await callback({ text: boundedResultText });

		return {
			success: true,
			text: boundedResultText,
			data: {
				slug: installSlug,
				name: bestMatch.displayName,
				scanStatus: scanStatus ?? "clean",
				searchLimit: SKILL_SEARCH_LIMIT,
				outputTruncated: boundedResultText !== resultText,
			},
		};
	},

	examples: [
		[
			{
				name: "{{userName}}",
				content: { text: "Install the weather skill" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Skill **Weather** (`weather`) installed successfully. The skill passed security scanning and is ready to use.",
					actions: ["INSTALL_SKILL"],
				},
			},
		],
	],
};

export default installSkillAction;
