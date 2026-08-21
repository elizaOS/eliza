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
import {
	getStreamingContext,
	toWellFormedUnicode,
	truncateWellFormed,
	unwrapUserMessageText,
} from "@elizaos/core";
import { skillDownloadAbortError } from "../services/skill-package-bytes";
import type { AgentSkillsService } from "../services/skills";
import { describeSkillReference, extractSlugFromMessage } from "./parse-helpers";
import { createAgentSkillsActionValidator } from "./validators";

const SKILL_SEARCH_LIMIT = 5;
const SKILL_INSTALL_TEXT_MAX_CHARS = 3_000;

function truncateInstallSkillText(text: string): string {
	const wellFormed = toWellFormedUnicode(text);
	return wellFormed.length <= SKILL_INSTALL_TEXT_MAX_CHARS
		? wellFormed
		: `${truncateWellFormed(wellFormed, SKILL_INSTALL_TEXT_MAX_CHARS)}\n\n[truncated install result]`;
}

export const installSkillAction = {
	name: "SKILL",
	contexts: ["automation", "settings", "connectors"],
	contextGate: { anyOf: ["automation", "settings", "connectors"] },
	roleGate: { minRole: "USER" },
	similes: [
		"INSTALL_SKILL",
		"DOWNLOAD_SKILL",
		"ADD_SKILL",
		"GET_SKILL",
		"FETCH_SKILL",
	],
	description:
		"Install skill from ClawHub registry. Security-scanned before activation. Provide slug/search term, e.g. install weather.",
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
	validate: createAgentSkillsActionValidator(),

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

		// Parse the user's actual words, not the external-content security
		// envelope hardenIncomingUserMessage wraps around untrusted messages.
		const text = unwrapUserMessageText(message);
		const slug = extractSlugFromMessage(text);

		if (!slug) {
			const errorText =
				"I couldn't determine which skill to install. " +
				'Please specify a skill name or slug, e.g. "install weather".';
			if (callback) await callback({ text: errorText });
			return { success: false, error: new Error(errorText) };
		}

		const installSignal = getStreamingContext()?.abortSignal;
		const cancellationResult = (
			cause: unknown,
			skillReference: string,
		): ActionResult => {
			const installError =
				installSignal?.aborted
					? skillDownloadAbortError(installSignal, cause)
					: cause instanceof Error
						? cause
						: new Error(String(cause));
			return {
				success: false,
				error: installError,
				text: `Failed to install skill "${skillReference}": ${installError.message}`,
			};
		};
		if (installSignal?.aborted) {
			return cancellationResult(installSignal.reason, slug);
		}

		// Check if already installed
		const loadedSkills = service.getLoadedSkills();
		const existing = loadedSkills.find(
			(s) => s.slug === slug || s.name.toLowerCase() === slug.toLowerCase(),
		);
		if (existing) {
			if (installSignal?.aborted) {
				return cancellationResult(installSignal.reason, slug);
			}
			const resultText = `Skill **${existing.name}** (\`${existing.slug}\`) is already installed.`;
			if (callback) await callback({ text: resultText });
			if (installSignal?.aborted) {
				return cancellationResult(installSignal.reason, slug);
			}
			return {
				success: true,
				text: resultText,
				data: { slug: existing.slug, alreadyInstalled: true },
			};
		}

		// Try to find the skill in the registry first. Echoes are display-clamped:
		// only a name-shaped slug is quoted back, never an arbitrary blob.
		if (callback) {
			await callback({
				text: `Searching for ${describeSkillReference(slug)} in the skill registry...`,
			});
		}
		if (installSignal?.aborted) {
			return cancellationResult(installSignal.reason, slug);
		}

		// Search to find best match
		let searchResults: Awaited<ReturnType<AgentSkillsService["search"]>>;
		try {
			searchResults = await service.search(slug, SKILL_SEARCH_LIMIT, {
				signal: installSignal,
			});
		} catch (cause) {
			// error-policy:J1 the action boundary owns cancellation of registry
			// discovery as well as package download.
			const result = cancellationResult(cause, slug);
			if (callback && !installSignal?.aborted) {
				await callback({ text: result.text });
			}
			return result;
		}
		if (installSignal?.aborted) {
			return cancellationResult(installSignal.reason, slug);
		}
		const bestMatch =
			searchResults.find(
				(r) =>
					r.slug === slug || r.displayName.toLowerCase() === slug.toLowerCase(),
			) ?? searchResults[0];

		if (!bestMatch) {
			const errorText = `No skill matching ${describeSkillReference(slug)} found in the registry.`;
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
		if (installSignal?.aborted) {
			return cancellationResult(installSignal.reason, installSlug);
		}

		let success: boolean;
		try {
			success = await service.install(installSlug, {
				signal: installSignal,
				throwOnDownloadError: true,
			});
		} catch (cause) {
			// error-policy:J1 the action boundary returns the original typed error in
			// ActionResult instead of leaking a rejected handler promise.
			const result = cancellationResult(cause, installSlug);
			if (callback && !installSignal?.aborted) {
				await callback({ text: result.text });
			}
			return result;
		}
		if (installSignal?.aborted) {
			return cancellationResult(installSignal.reason, installSlug);
		}

		if (!success) {
			// install() returns false for non-lifecycle failures: ordinary network
			// errors, security-scan blocks (auto-deleted), or other issues. Typed
			// caller cancellation and deadline failures reject to the action boundary.
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
			if (installSignal?.aborted) {
				return cancellationResult(installSignal.reason, installSlug);
			}
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
		if (installSignal?.aborted) {
			return cancellationResult(installSignal.reason, installSlug);
		}
		if (callback) await callback({ text: boundedResultText });
		if (installSignal?.aborted) {
			return cancellationResult(installSignal.reason, installSlug);
		}

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
					actions: ["SKILL"],
				},
			},
		],
	],
} satisfies Action;

export default installSkillAction;
