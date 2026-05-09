/**
 * Agent Skills Providers
 *
 * Implements progressive disclosure for skill information:
 * - Level 1 (Metadata): Always in context (~100 tokens per skill)
 * - Level 2 (Instructions): When skill triggers (<5k tokens)
 * - Level 3 (Resources): As needed (unlimited, executed without loading)
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";
import type { Skill, SkillCatalogEntry } from "../types";

const MAX_SUMMARY_SKILLS = 50;
const MAX_SCAN_NOTICES = 10;
const MAX_CATALOG_CATEGORIES = 8;
const MAX_CATALOG_SKILLS_PER_CATEGORY = 3;

// ============================================================
// LEVEL 1: SUMMARY PROVIDER
// Installed skills with descriptions - good default
// ============================================================

/**
 * Skills Summary Provider (Medium Resolution)
 *
 * Lists installed skills with their descriptions.
 * Default provider for skill awareness.
 */
export const skillsSummaryProvider: Provider = {
	name: "agent_skills",
	description: "Medium-res list of installed Agent Skills with descriptions",
	descriptionCompressed: "medium-re list install Agent Skills w/ description",
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

			const skills = service.getLoadedSkills();

			if (skills.length === 0) {
				return {
					text: "**Skills:** None installed. Use SKILL op=search to browse the catalog and SKILL op=install to install one.",
					values: { skillCount: 0 },
					data: { skills: [] },
				};
			}

			const listedSkills = skills.slice(0, MAX_SUMMARY_SKILLS);
			const skillsJson = service.generateSkillsPromptJson({
				includeLocation: true,
			});

			// Build scan status annotations for skills that have been scanned
			const scanAnnotations: string[] = [];
			for (const skill of listedSkills) {
				const scanStatus = service.getSkillScanStatus(skill.slug);
				if (scanStatus && scanStatus !== "clean") {
					scanAnnotations.push(
						`- \`${skill.slug}\`: security scan status = **${scanStatus}** (requires acknowledgment to enable)`,
					);
				}
			}

			const scanSection =
				scanAnnotations.length > 0
					? `\n\n### Security Notices\n${scanAnnotations
							.slice(0, MAX_SCAN_NOTICES)
							.join("\n")}`
					: "";

			const text = `## Installed Skills (${skills.length})

${skillsJson}${scanSection}

*Use SKILL op=toggle to enable/disable skills. Use SKILL op=install to add new skills. Use SKILL op=uninstall to remove installed skills.*`;

			return {
				text,
				values: {
					skillCount: skills.length,
					installedSkills: listedSkills.map((s) => s.slug).join(", "),
				},
				data: {
					skills: listedSkills.map((s: Skill) => ({
						slug: s.slug,
						name: s.name,
						description: s.description,
						version: s.version,
						scanStatus: service.getSkillScanStatus(s.slug),
					})),
					truncated: skills.length > listedSkills.length,
				},
			};
		} catch {
			return { text: "", values: {}, data: {} };
		}
	},
};

// ============================================================
// LEVEL 2: INSTRUCTIONS PROVIDER
// Full instructions for contextually matched skills
// ============================================================

/**
 * Skill Instructions Provider (High Resolution)
 *
 * Provides full instructions from the most relevant skill
 * based on message context.
 */
export const skillInstructionsProvider: Provider = {
	name: "agent_skill_instructions",
	description: "High-res instructions from the most relevant skill",
	descriptionCompressed: "high-re instruction most relevant skill",
	position: 5,

	dynamic: true,
	contexts: ["agent_internal", "settings"],
	contextGate: { anyOf: ["agent_internal", "settings"] },
	cacheStable: false,
	cacheScope: "turn",
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		try {
			const service = runtime.getService<AgentSkillsService>(
				"AGENT_SKILLS_SERVICE",
			);
			if (!service) return { text: "" };

			const skills = service.getLoadedSkills();
			if (skills.length === 0) return { text: "" };

		// Build context from message and recent history
		const messageText = (message.content?.text || "").toLowerCase();
		const recentContext = getRecentContext(state);
		const fullContext = `${messageText} ${recentContext}`.toLowerCase();

		// Score skills by relevance
		const scoredSkills = skills
			.map((skill: Skill) => ({
				skill,
				score: calculateSkillRelevance(skill, fullContext),
			}))
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score);

		// Require minimum relevance score
		if (scoredSkills.length === 0 || scoredSkills[0].score < 3) {
			return { text: "" };
		}

		const topSkill = scoredSkills[0];
		const instructions = service.getSkillInstructions(topSkill.skill.slug);

		if (!instructions) return { text: "" };

		// Truncate if too long (respect ~5k token guideline)
		const maxChars = 4000;
		const truncatedBody =
			instructions.body.length > maxChars
				? `${instructions.body.substring(0, maxChars)}\n\n...[truncated]`
				: instructions.body;

		const text = `## Active Skill: ${topSkill.skill.name}

${truncatedBody}`;

			return {
				text,
				values: {
					activeSkill: topSkill.skill.slug,
					skillName: topSkill.skill.name,
					relevanceScore: topSkill.score,
					estimatedTokens: instructions.estimatedTokens,
				},
				data: {
					activeSkill: {
						slug: topSkill.skill.slug,
						name: topSkill.skill.name,
						score: topSkill.score,
					},
					otherMatches: scoredSkills.slice(1, 3).map((s) => ({
						slug: s.skill.slug,
						score: s.score,
					})),
				},
			};
		} catch {
			return { text: "", values: {}, data: {} };
		}
	},
};

// ============================================================
// CATALOG AWARENESS PROVIDER
// Shows catalog when user asks about capabilities
// ============================================================

/**
 * Catalog Awareness Provider
 *
 * Dynamically shows available skill categories when
 * the user asks about capabilities.
 */
export const catalogAwarenessProvider: Provider = {
	name: "agent_skills_catalog",
	description: "Awareness of skills available on the registry",
	descriptionCompressed: "Available skills on registry.",
	position: 10,
	dynamic: true,
	contexts: ["agent_internal", "settings"],
	contextGate: { anyOf: ["agent_internal", "settings"] },
	cacheStable: false,
	cacheScope: "turn",
	private: true,

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const service = runtime.getService<AgentSkillsService>(
				"AGENT_SKILLS_SERVICE",
			);
			if (!service) return { text: "" };

		const text = (message.content?.text || "").toLowerCase();
		const capabilityKeywords = [
			"what can you",
			"what skills",
			"capabilities",
			"what do you know",
			"help with",
		];

		if (!capabilityKeywords.some((kw) => text.includes(kw))) {
			return { text: "" };
		}

		const catalog = await service.getCatalog({ notOlderThan: Infinity });
		if (catalog.length === 0) return { text: "" };

		const categories = groupByCategory(catalog);

		let categoryText = "";
		for (const [category, skills] of Object.entries(categories).slice(
			0,
			MAX_CATALOG_CATEGORIES,
		)) {
			const skillNames = skills
				.slice(0, MAX_CATALOG_SKILLS_PER_CATEGORY)
				.map((s) => s.name)
				.join(", ");
			const more =
				skills.length > MAX_CATALOG_SKILLS_PER_CATEGORY
					? ` +${skills.length - MAX_CATALOG_SKILLS_PER_CATEGORY} more`
					: "";
			categoryText += `- **${category}**: ${skillNames}${more}\n`;
		}

		return {
			text: `## Available Skill Categories

${categoryText}
Use USE_SKILL to invoke an enabled skill, or SKILL op=search to find one.`,
			data: { categories },
		};
		} catch {
			return { text: "", values: {}, data: {} };
		}
	},
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function getRecentContext(state: State): string {
	const recentMessages = state.recentMessages || state.recentMessagesData || [];
	if (Array.isArray(recentMessages)) {
		return recentMessages
			.slice(-5)
			.map(
				(m: Memory | { content?: { text?: string } }) => m.content?.text || "",
			)
			.join(" ");
	}
	return "";
}

function calculateSkillRelevance(skill: Skill, context: string): number {
	let score = 0;
	const contextLower = context.toLowerCase();

	const { slug, name, description } = skill;

	// Exact slug match
	if (slug && contextLower.includes(slug.toLowerCase())) score += 10;

	// Exact name match
	if (name && contextLower.includes(name.toLowerCase())) score += 8;

	// Keyword matches from name
	const nameWords = name.split(/[\s-_]+/).filter((w) => w.length > 3);
	for (const word of nameWords) {
		if (contextLower.includes(word.toLowerCase())) score += 2;
	}

	// Keyword matches from description (selective)
	const stopwords = new Set([
		"the",
		"and",
		"for",
		"with",
		"this",
		"that",
		"from",
		"will",
		"can",
		"are",
		"use",
		"when",
		"how",
		"what",
		"your",
		"you",
		"our",
		"has",
		"have",
		"been",
		"skill",
		"agent",
		"search",
		"install",
	]);

	const descWords = description
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 4 && !stopwords.has(w));

	for (const word of descWords) {
		if (contextLower.includes(word)) score += 1;
	}

	// Trigger word matches (from description)
	const triggerMatch = description.match(/Use (?:when|for|to)\s+([^.]+)/i);
	if (triggerMatch) {
		const triggerWords = triggerMatch[1]
			.split(/[,;]/)
			.map((t) => t.trim().toLowerCase());
		for (const trigger of triggerWords) {
			if (trigger && contextLower.includes(trigger)) score += 3;
		}
	}

	return score;
}

function groupByCategory(
	skills: SkillCatalogEntry[],
): Record<string, Array<{ slug: string; name: string }>> {
	const categories: Record<string, Array<{ slug: string; name: string }>> = {};

	const categoryKeywords: Record<string, string[]> = {
		"AI & Models": [
			"ai",
			"llm",
			"model",
			"gpt",
			"claude",
			"openai",
			"anthropic",
		],
		"Browser & Web": ["browser", "web", "scrape", "chrome", "selenium"],
		"Code & Dev": ["code", "python", "javascript", "typescript", "git", "dev"],
		"Data & Analytics": ["data", "analytics", "csv", "json", "database"],
		"Finance & Trading": [
			"trading",
			"finance",
			"crypto",
			"market",
			"prediction",
		],
		Communication: ["email", "slack", "discord", "telegram", "chat"],
		Productivity: ["calendar", "task", "todo", "note", "document"],
		Other: [],
	};

	for (const skill of skills) {
		const text = `${skill.displayName} ${skill.summary || ""}`.toLowerCase();
		let assigned = false;

		for (const [category, keywords] of Object.entries(categoryKeywords)) {
			if (category === "Other") continue;
			if (keywords.some((kw) => text.includes(kw))) {
				if (!categories[category]) categories[category] = [];
				categories[category].push({
					slug: skill.slug,
					name: skill.displayName,
				});
				assigned = true;
				break;
			}
		}

		if (!assigned) {
			if (!categories.Other) categories.Other = [];
			categories.Other.push({ slug: skill.slug, name: skill.displayName });
		}
	}

	return categories;
}
