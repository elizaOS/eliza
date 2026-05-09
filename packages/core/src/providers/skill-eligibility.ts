/**
 * Skill Eligibility Provider
 *
 * Provides LLM context about which skills are eligible for use,
 * which are ineligible, and why. Helps the LLM make informed
 * decisions about skill usage and suggest fixes for missing deps.
 *
 * @module providers/skill-eligibility
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../types/index.js";
import type { Service } from "../types/service.js";

// ============================================================
// TYPES (matching plugin-agent-skills types)
// ============================================================

interface IneligibilityReason {
	type: "bin" | "env" | "config";
	missing: string;
	message: string;
	suggestion?: string;
}

interface SkillEligibility {
	slug: string;
	eligible: boolean;
	reasons: IneligibilityReason[];
	checkedAt: number;
	installOptions?: Array<{
		id: string;
		kind: string;
		package?: string;
		formula?: string;
		label?: string;
	}>;
}

interface SkillWithSource {
	slug: string;
	name: string;
	description: string;
	source: string;
	sourceDir: string;
}

const MAX_SKILL_ELIGIBLE_LIST = 10;
const MAX_SKILL_INELIGIBLE_LIST = 12;
const MAX_SKILL_REASON_ITEMS = 5;
const MAX_SKILL_COMPACT_LIST = 12;

interface AgentSkillsServiceLike extends Service {
	getLoadedSkills(): SkillWithSource[];
	checkSkillEligibility(slug: string): Promise<SkillEligibility>;
	getAllSkillEligibility(): Promise<Map<string, SkillEligibility>>;
	getEligibleSkills(): Promise<SkillWithSource[]>;
	getIneligibleSkills(): Promise<
		Array<{
			skill: SkillWithSource;
			eligibility: SkillEligibility;
		}>
	>;
}

// ============================================================
// PROVIDER
// ============================================================

/**
 * Skill Eligibility Provider
 *
 * Injects information about skill eligibility into the LLM context:
 * - List of eligible skills that are ready to use
 * - List of ineligible skills with reasons and suggested fixes
 * - Summary of what's missing (binaries, env vars, config)
 */
export const skillEligibilityProvider: Provider = {
	name: "skill_eligibility",
	description:
		"Shows which skills are eligible and which have missing dependencies",
	position: -5, // After skill metadata, before instructions
	dynamic: true,
	contexts: ["general", "agent_internal"],
	contextGate: { anyOf: ["general", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		// Try to get the agent skills service
		const service = runtime.getService<AgentSkillsServiceLike>(
			"AGENT_SKILLS_SERVICE",
		);

		if (!service) {
			return { text: "", values: {}, data: {} };
		}

		try {
			const [eligible, ineligible] = await Promise.all([
				service.getEligibleSkills(),
				service.getIneligibleSkills(),
			]);

			// If all skills are eligible, return simple message
			if (ineligible.length === 0) {
				return {
					text: `**Skill Status:** All ${eligible.length} installed skills are ready to use.`,
					values: {
						eligibleCount: eligible.length,
						ineligibleCount: 0,
					},
					data: {
						eligible: eligible.map((s) => s.slug),
						ineligible: [],
					},
				};
			}

			// Build detailed output
			const lines: string[] = [];
			lines.push(`## Skill Eligibility`);
			lines.push("");

			// Eligible skills
			if (eligible.length > 0) {
				lines.push(`### Ready to Use (${eligible.length})`);
				for (const skill of eligible.slice(0, MAX_SKILL_ELIGIBLE_LIST)) {
					lines.push(`- **${skill.name}** (${skill.slug})`);
				}
				if (eligible.length > MAX_SKILL_ELIGIBLE_LIST) {
					lines.push(
						`- ...and ${eligible.length - MAX_SKILL_ELIGIBLE_LIST} more`,
					);
				}
				lines.push("");
			}

			// Ineligible skills with reasons
			lines.push(`### Missing Dependencies (${ineligible.length})`);
			lines.push("");

			for (const { skill, eligibility } of ineligible.slice(
				0,
				MAX_SKILL_INELIGIBLE_LIST,
			)) {
				lines.push(`#### ${skill.name} (${skill.slug})`);

				// Group reasons by type
				const binReasons = eligibility.reasons.filter((r) => r.type === "bin");
				const envReasons = eligibility.reasons.filter((r) => r.type === "env");
				const configReasons = eligibility.reasons.filter(
					(r) => r.type === "config",
				);

				if (binReasons.length > 0) {
					lines.push(
						`- Missing binaries: ${binReasons
							.slice(0, MAX_SKILL_REASON_ITEMS)
							.map((r) => r.missing)
							.join(", ")}`,
					);
					// Show installation suggestions
					for (const reason of binReasons) {
						if (reason.suggestion) {
							lines.push(`  - ${reason.suggestion}`);
						}
					}
				}

				if (envReasons.length > 0) {
					lines.push(
						`- Missing env vars: ${envReasons
							.slice(0, MAX_SKILL_REASON_ITEMS)
							.map((r) => r.missing)
							.join(", ")}`,
					);
				}

				if (configReasons.length > 0) {
					lines.push(
						`- Missing config: ${configReasons
							.slice(0, MAX_SKILL_REASON_ITEMS)
							.map((r) => r.missing)
							.join(", ")}`,
					);
				}

				lines.push("");
			}

			// Add summary of fixes
			const allReasons = ineligible.flatMap((i) => i.eligibility.reasons);
			const missingBins = [
				...new Set(
					allReasons.filter((r) => r.type === "bin").map((r) => r.missing),
				),
			];
			const missingEnv = [
				...new Set(
					allReasons.filter((r) => r.type === "env").map((r) => r.missing),
				),
			];

			if (missingBins.length > 0 || missingEnv.length > 0) {
				lines.push("### To enable more skills:");
				if (missingBins.length > 0) {
					lines.push(
						`- Install: ${missingBins.slice(0, 5).join(", ")}${missingBins.length > 5 ? ` (+${missingBins.length - 5} more)` : ""}`,
					);
				}
				if (missingEnv.length > 0) {
					lines.push(
						`- Set env: ${missingEnv.slice(0, 5).join(", ")}${missingEnv.length > 5 ? ` (+${missingEnv.length - 5} more)` : ""}`,
					);
				}
			}

			return {
				text: lines.join("\n"),
				values: {
					eligibleCount: eligible.length,
					ineligibleCount: ineligible.length,
					missingBinaries: missingBins,
					missingEnvVars: missingEnv,
				},
				data: {
					eligible: eligible.map((s) => s.slug),
					ineligible: ineligible
						.slice(0, MAX_SKILL_INELIGIBLE_LIST)
						.map((i) => ({
							slug: i.skill.slug,
							reasons: i.eligibility.reasons.slice(0, MAX_SKILL_REASON_ITEMS),
						})),
					truncated: ineligible.length > MAX_SKILL_INELIGIBLE_LIST,
				},
			};
		} catch (_error) {
			// Service might not support eligibility checking
			return {
				text: "",
				values: { eligibleCount: 0, ineligibleCount: 0 },
				data: { eligible: [], ineligible: [] },
			};
		}
	},
};

/**
 * Compact Skill Eligibility Provider
 *
 * A more compact version that only shows ineligible skills.
 * Good for systems with many skills.
 */
export const skillEligibilityCompactProvider: Provider = {
	name: "skill_eligibility_compact",
	description: "Compact view of ineligible skills only",
	position: -5,
	dynamic: true,
	contexts: ["general", "agent_internal"],
	contextGate: { anyOf: ["general", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		const service = runtime.getService<AgentSkillsServiceLike>(
			"AGENT_SKILLS_SERVICE",
		);

		if (!service) {
			return { text: "", values: {}, data: {} };
		}

		try {
			const ineligible = await service.getIneligibleSkills();

			if (ineligible.length === 0) {
				return { text: "", values: {}, data: { ineligible: [] } }; // All skills ready, no need to mention
			}

			const visibleIneligible = ineligible.slice(0, MAX_SKILL_COMPACT_LIST);
			const skillNames = visibleIneligible.map((i) => i.skill.slug).join(", ");
			const missingBins = [
				...new Set(
					visibleIneligible.flatMap((i) =>
						i.eligibility.reasons
							.filter((r) => r.type === "bin")
							.map((r) => r.missing),
					),
				),
			].slice(0, MAX_SKILL_REASON_ITEMS);

			let text = `⚠️ Skills unavailable: ${skillNames}`;
			if (ineligible.length > visibleIneligible.length) {
				text += ` (+${ineligible.length - visibleIneligible.length} more)`;
			}
			if (missingBins.length > 0) {
				text += ` (missing: ${missingBins.join(", ")})`;
			}

			return {
				text,
				values: {
					ineligibleCount: ineligible.length,
				},
				data: {
					ineligible: visibleIneligible.map((i) => i.skill.slug),
					missingBins,
					omittedCount: ineligible.length - visibleIneligible.length,
				},
			};
		} catch (error) {
			return {
				text: "",
				values: { ineligibleCount: 0 },
				data: {
					ineligible: [],
					missingBins: [],
					error: error instanceof Error ? error.message : String(error),
				},
			};
		}
	},
};

export default skillEligibilityProvider;
