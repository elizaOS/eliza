/**
 * Agent Skills Providers
 *
 * Implements progressive disclosure for skill information:
 * - Level 1 (Metadata): Always in context (~100 tokens per skill)
 * - Level 2 (Instructions): When skill triggers (<5k tokens)
 * - Level 3 (Resources): As needed (unlimited, executed without loading)
 */

import type {
  Provider,
  IAgentRuntime,
  Memory,
  State,
  ProviderResult,
} from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";
import type { Skill, SkillCatalogEntry } from "../types";

// ============================================================
// LEVEL 1: METADATA PROVIDER
// Always included in context - minimal footprint
// ============================================================

/**
 * Skills Overview Provider (Low Resolution)
 *
 * Provides a minimal summary of installed and available skills.
 * Good for initial awareness without consuming context.
 */
export const skillsOverviewProvider: Provider = {
  name: "agent_skills_overview",
  description: "Low-res overview of available Agent Skills (names only)",
  position: -20,
  dynamic: true,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = await runtime.getService<AgentSkillsService>(
      "AGENT_SKILLS_SERVICE",
    );
    if (!service) return { text: "" };

    const stats = service.getCatalogStats();
    const installed = service.getLoadedSkills();

    // Get catalog from cache only
    const catalog = await service.getCatalog({ notOlderThan: Infinity });

    const availableCount = catalog.length;
    const examples = catalog
      .slice(0, 5)
      .map((s) => s.displayName)
      .join(", ");

    const text = `**Skills:** ${stats.installed} installed, ${availableCount} available
Examples: ${examples}...
Use GET_SKILL_GUIDANCE to find skills for specific tasks.`;

    return {
      text,
      values: {
        installedCount: stats.installed,
        availableCount,
      },
      data: {
        installed: installed.map((s) => s.slug),
        catalogSize: availableCount,
      },
    };
  },
};

// ============================================================
// LEVEL 1.5: SUMMARY PROVIDER
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
  position: -10,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = await runtime.getService<AgentSkillsService>(
      "AGENT_SKILLS_SERVICE",
    );
    if (!service) return { text: "" };

    const skills = service.getLoadedSkills();

    if (skills.length === 0) {
      return {
        text: "**Skills:** None installed. Use GET_SKILL_GUIDANCE to find and install skills.",
        values: { skillCount: 0 },
        data: { skills: [] },
      };
    }

    // Use XML format as recommended by Agent Skills spec
    const xml = service.generateSkillsPromptXml({ includeLocation: true });

    const text = `## Installed Skills (${skills.length})

${xml}

*More skills available via GET_SKILL_GUIDANCE*`;

    return {
      text,
      values: {
        skillCount: skills.length,
        installedSkills: skills.map((s) => s.slug).join(", "),
      },
      data: {
        skills: skills.map((s: Skill) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          version: s.version,
        })),
      },
    };
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
  position: 5,

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    const service = await runtime.getService<AgentSkillsService>(
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
        ? instructions.body.substring(0, maxChars) + "\n\n...[truncated]"
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
  position: 10,
  dynamic: true,
  private: true,

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = await runtime.getService<AgentSkillsService>(
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
    for (const [category, skills] of Object.entries(categories).slice(0, 8)) {
      const skillNames = skills
        .slice(0, 3)
        .map((s) => s.name)
        .join(", ");
      const more = skills.length > 3 ? ` +${skills.length - 3} more` : "";
      categoryText += `- **${category}**: ${skillNames}${more}\n`;
    }

    return {
      text: `## Available Skill Categories

${categoryText}
Use GET_SKILL_GUIDANCE to find and use any skill.`,
      data: { categories },
    };
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

  // Exact slug match
  if (contextLower.includes(skill.slug.toLowerCase())) score += 10;

  // Exact name match
  if (contextLower.includes(skill.name.toLowerCase())) score += 8;

  // Keyword matches from name
  const nameWords = skill.name.split(/[\s-_]+/).filter((w) => w.length > 3);
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

  const descWords = skill.description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !stopwords.has(w));

  for (const word of descWords) {
    if (contextLower.includes(word)) score += 1;
  }

  // Trigger word matches (from description)
  const triggerMatch = skill.description.match(
    /Use (?:when|for|to)\s+([^.]+)/i,
  );
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
      if (!categories["Other"]) categories["Other"] = [];
      categories["Other"].push({ slug: skill.slug, name: skill.displayName });
    }
  }

  return categories;
}

// Legacy export
export const skillsProvider = skillsSummaryProvider;

// Also export with clawhub prefix for backwards compatibility
export const clawhub_skills = skillsSummaryProvider;
export const clawhub_skills_overview = skillsOverviewProvider;
export const clawhub_skill_instructions = skillInstructionsProvider;
export const clawhub_catalog = catalogAwarenessProvider;
