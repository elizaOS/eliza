/**
 * OASF (Open Agentic Schema Framework) Skill Mapping Utility
 *
 * @description Maps Polyagent NPC types and characteristics to OASF taxonomy skills/domains
 * for agent discovery and capability matching. Integrates with Agent0 SDK v0.31.0 for
 * standardized agent capability representation.
 *
 * Based on: https://schema.oasf.outshift.com/skill_categories
 * Agent0 SDK v0.31.0 Integration
 *
 * @see https://sdk.ag0.xyz/ for Agent0 SDK documentation
 */

import type { ActorData } from "../game-types";

/**
 * OASF Skill Categories
 *
 * @description Primary taxonomy categories for agent capabilities. Used to classify
 * agent skills for discovery and matching. Follows hierarchical format:
 * category/subcategory/skill.
 */
export const OASFSkillCategories = {
  // Natural Language & Communication
  NLP: "natural_language_processing",
  DIALOGUE: "dialogue_systems",

  // Finance & Trading
  FINANCE: "finance_and_business",
  INVESTMENT: "finance_and_business/investment_services",
  TRADING: "finance_and_business/trading",
  RISK_ANALYSIS: "finance_and_business/risk_analysis",

  // Data & Analytics
  DATA_ENGINEERING: "data_engineering",
  DATA_ANALYSIS: "data_analysis",
  PREDICTION: "predictive_analytics",

  // Agent Orchestration
  AGENT_ORCHESTRATION: "agent_orchestration",
  MULTI_AGENT: "agent_orchestration/multi_agent_systems",

  // Information & Knowledge
  INFORMATION_RETRIEVAL: "information_retrieval",
  KNOWLEDGE_MANAGEMENT: "knowledge_management",

  // Content & Media
  CONTENT_CREATION: "content_creation",
  CONTENT_MODERATION: "content_moderation",

  // Social & Community
  SOCIAL_MEDIA: "social_media_management",
  COMMUNITY: "community_management",

  // Decision Support
  DECISION_SUPPORT: "decision_support_systems",
  REASONING: "reasoning_and_problem_solving",

  // Workflow & Automation
  WORKFLOW: "workflow_automation",
  TASK_PLANNING: "task_planning_and_scheduling",
} as const;

/**
 * OASF Domain Categories
 *
 * @description Business/application domains where agents operate. Used to classify
 * agents by their application domain for discovery. Follows hierarchical format:
 * domain/subdomain.
 */
export const OASFDomainCategories = {
  FINANCE: "finance_and_business",
  INVESTMENT: "finance_and_business/investment_services",
  TRADING_MARKETS: "finance_and_business/trading_and_markets",

  ENTERTAINMENT: "entertainment_and_media",
  GAMING: "entertainment_and_media/gaming",

  SOCIAL_NETWORKING: "social_networking",
  COMMUNITY_PLATFORMS: "social_networking/community_platforms",

  EDUCATION: "education_and_learning",
  RESEARCH: "research_and_development",
} as const;

/**
 * NPC Type to OASF Skills Mapping
 * Maps Polyagent NPC types to relevant OASF skill paths
 */
export const NPCTypeSkillMap: Record<string, string[]> = {
  // Trading & Finance NPCs
  trader: [
    OASFSkillCategories.TRADING,
    OASFSkillCategories.RISK_ANALYSIS,
    OASFSkillCategories.PREDICTION,
    OASFSkillCategories.DATA_ANALYSIS,
    OASFSkillCategories.DECISION_SUPPORT,
  ],

  analyst: [
    OASFSkillCategories.DATA_ANALYSIS,
    OASFSkillCategories.PREDICTION,
    OASFSkillCategories.FINANCE,
    OASFSkillCategories.INFORMATION_RETRIEVAL,
    OASFSkillCategories.DECISION_SUPPORT,
  ],

  investor: [
    OASFSkillCategories.INVESTMENT,
    OASFSkillCategories.RISK_ANALYSIS,
    OASFSkillCategories.DATA_ANALYSIS,
    OASFSkillCategories.DECISION_SUPPORT,
  ],

  // Social & Community NPCs
  influencer: [
    OASFSkillCategories.SOCIAL_MEDIA,
    OASFSkillCategories.CONTENT_CREATION,
    OASFSkillCategories.COMMUNITY,
    OASFSkillCategories.NLP,
  ],

  moderator: [
    OASFSkillCategories.CONTENT_MODERATION,
    OASFSkillCategories.COMMUNITY,
    OASFSkillCategories.DECISION_SUPPORT,
    OASFSkillCategories.NLP,
  ],

  // Dialogue & Interaction NPCs
  conversationalist: [
    OASFSkillCategories.DIALOGUE,
    OASFSkillCategories.NLP,
    OASFSkillCategories.REASONING,
  ],

  mentor: [
    OASFSkillCategories.DIALOGUE,
    OASFSkillCategories.NLP,
    OASFSkillCategories.KNOWLEDGE_MANAGEMENT,
    OASFSkillCategories.DECISION_SUPPORT,
  ],

  // Orchestration & Automation NPCs
  coordinator: [
    OASFSkillCategories.AGENT_ORCHESTRATION,
    OASFSkillCategories.MULTI_AGENT,
    OASFSkillCategories.WORKFLOW,
    OASFSkillCategories.TASK_PLANNING,
  ],

  // Default for unspecified types
  default: [
    OASFSkillCategories.DIALOGUE,
    OASFSkillCategories.NLP,
    OASFSkillCategories.REASONING,
  ],
};

/**
 * NPC Type to OASF Domains Mapping
 * Maps Polyagent NPC types to relevant OASF domain paths
 */
export const NPCTypeDomainMap: Record<string, string[]> = {
  // Trading & Finance NPCs
  trader: [
    OASFDomainCategories.TRADING_MARKETS,
    OASFDomainCategories.FINANCE,
    OASFDomainCategories.GAMING, // Prediction markets as gaming
  ],

  analyst: [
    OASFDomainCategories.FINANCE,
    OASFDomainCategories.RESEARCH,
    OASFDomainCategories.TRADING_MARKETS,
  ],

  investor: [
    OASFDomainCategories.INVESTMENT,
    OASFDomainCategories.FINANCE,
    OASFDomainCategories.TRADING_MARKETS,
  ],

  // Social & Community NPCs
  influencer: [
    OASFDomainCategories.SOCIAL_NETWORKING,
    OASFDomainCategories.COMMUNITY_PLATFORMS,
    OASFDomainCategories.ENTERTAINMENT,
  ],

  moderator: [
    OASFDomainCategories.COMMUNITY_PLATFORMS,
    OASFDomainCategories.SOCIAL_NETWORKING,
  ],

  // Dialogue & Interaction NPCs
  conversationalist: [
    OASFDomainCategories.SOCIAL_NETWORKING,
    OASFDomainCategories.ENTERTAINMENT,
  ],

  mentor: [
    OASFDomainCategories.EDUCATION,
    OASFDomainCategories.SOCIAL_NETWORKING,
  ],

  // Orchestration & Automation NPCs
  coordinator: [
    OASFDomainCategories.FINANCE,
    OASFDomainCategories.SOCIAL_NETWORKING,
  ],

  // Default for unspecified types
  default: [
    OASFDomainCategories.GAMING,
    OASFDomainCategories.SOCIAL_NETWORKING,
  ],
};

/**
 * Map ActorData to OASF skills based on NPC characteristics
 *
 * @description Analyzes an NPC's role and description to determine relevant OASF
 * skill categories. Uses role-based mapping and keyword analysis from description.
 * Returns deduplicated array of skill paths.
 *
 * @param {ActorData} actorData - The NPC's ActorData from JSON files
 * @returns {string[]} Array of OASF skill paths matching the NPC's capabilities
 *
 * @example
 * ```typescript
 * const skills = mapActorToOASFSkills({
 *   role: 'trader',
 *   description: 'Expert in prediction markets and risk analysis'
 * });
 * // Returns: ['finance_and_business/trading', 'finance_and_business/risk_analysis', ...]
 * ```
 */
export function mapActorToOASFSkills(actorData: ActorData): string[] {
  const skills: string[] = [];

  // Determine NPC type from role field
  const npcType = actorData.role?.toLowerCase() || "default";

  // Get skills for this NPC type
  const typeSkills = NPCTypeSkillMap[npcType] || NPCTypeSkillMap.default;
  if (typeSkills) {
    skills.push(...typeSkills);
  }

  // Add skills based on description keywords
  const description = (actorData.description || "").toLowerCase();

  if (description.includes("trade") || description.includes("trading")) {
    skills.push(OASFSkillCategories.TRADING);
  }

  if (description.includes("invest") || description.includes("portfolio")) {
    skills.push(OASFSkillCategories.INVESTMENT);
  }

  if (description.includes("analyz") || description.includes("predict")) {
    skills.push(
      OASFSkillCategories.DATA_ANALYSIS,
      OASFSkillCategories.PREDICTION,
    );
  }

  if (description.includes("social") || description.includes("community")) {
    skills.push(
      OASFSkillCategories.SOCIAL_MEDIA,
      OASFSkillCategories.COMMUNITY,
    );
  }

  if (description.includes("content") || description.includes("post")) {
    skills.push(OASFSkillCategories.CONTENT_CREATION);
  }

  if (description.includes("moderate") || description.includes("moderation")) {
    skills.push(OASFSkillCategories.CONTENT_MODERATION);
  }

  // Remove duplicates
  return Array.from(new Set(skills));
}

/**
 * Map ActorData to OASF domains based on NPC characteristics
 *
 * @description Analyzes an NPC's role and description to determine relevant OASF
 * domain categories. Uses role-based mapping and keyword analysis from description.
 * Returns deduplicated array of domain paths.
 *
 * @param {ActorData} actorData - The NPC's ActorData from JSON files
 * @returns {string[]} Array of OASF domain paths matching the NPC's application domain
 *
 * @example
 * ```typescript
 * const domains = mapActorToOASFDomains({
 *   role: 'trader',
 *   description: 'Active in prediction markets'
 * });
 * // Returns: ['finance_and_business/trading_and_markets', 'entertainment_and_media/gaming', ...]
 * ```
 */
export function mapActorToOASFDomains(actorData: ActorData): string[] {
  const domains: string[] = [];

  // Determine NPC type from role field
  const npcType = actorData.role?.toLowerCase() || "default";

  // Get domains for this NPC type
  const typeDomains = NPCTypeDomainMap[npcType] || NPCTypeDomainMap.default;
  if (typeDomains) {
    domains.push(...typeDomains);
  }

  // Add domains based on description keywords
  const description = (actorData.description || "").toLowerCase();

  if (description.includes("finance") || description.includes("financial")) {
    domains.push(OASFDomainCategories.FINANCE);
  }

  if (description.includes("invest")) {
    domains.push(OASFDomainCategories.INVESTMENT);
  }

  if (description.includes("market") || description.includes("trading")) {
    domains.push(OASFDomainCategories.TRADING_MARKETS);
  }

  if (description.includes("social")) {
    domains.push(OASFDomainCategories.SOCIAL_NETWORKING);
  }

  if (
    description.includes("game") ||
    description.includes("gaming") ||
    description.includes("prediction market")
  ) {
    domains.push(OASFDomainCategories.GAMING);
  }

  // Remove duplicates
  return Array.from(new Set(domains));
}

/**
 * Validate OASF skill path format
 *
 * @description Validates that a skill path follows the OASF hierarchical format:
 * category/subcategory/skill. Uses regex to ensure proper formatting.
 *
 * @param {string} skillPath - The skill path to validate
 * @returns {boolean} True if valid OASF skill path format
 *
 * @example
 * ```typescript
 * validateOASFSkillPath('finance_and_business/trading') // Returns true
 * validateOASFSkillPath('invalid path!') // Returns false
 * ```
 */
export function validateOASFSkillPath(skillPath: string): boolean {
  // Basic format validation: alphanumeric + underscores, separated by forward slashes
  const validPathRegex = /^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/;
  return validPathRegex.test(skillPath);
}

/**
 * Validate OASF domain path format
 *
 * @description Validates that a domain path follows the OASF hierarchical format:
 * category/subcategory. Uses regex to ensure proper formatting.
 *
 * @param {string} domainPath - The domain path to validate
 * @returns {boolean} True if valid OASF domain path format
 *
 * @example
 * ```typescript
 * validateOASFDomainPath('finance_and_business/trading_and_markets') // Returns true
 * validateOASFDomainPath('invalid!') // Returns false
 * ```
 */
export function validateOASFDomainPath(domainPath: string): boolean {
  // Same format as skill paths
  const validPathRegex = /^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/;
  return validPathRegex.test(domainPath);
}

/**
 * Get all available OASF skill categories
 *
 * @description Returns all available OASF skill category identifiers defined
 * in the skill mapping system.
 *
 * @returns {string[]} Array of skill category identifiers
 */
export function getAllSkillCategories(): string[] {
  return Object.values(OASFSkillCategories);
}

/**
 * Get all available OASF domain categories
 *
 * @description Returns all available OASF domain category identifiers defined
 * in the domain mapping system.
 *
 * @returns {string[]} Array of domain category identifiers
 */
export function getAllDomainCategories(): string[] {
  return Object.values(OASFDomainCategories);
}

/**
 * Suggest OASF skills based on keywords
 *
 * @description Analyzes keywords and suggests relevant OASF skill categories
 * based on keyword matching. Useful for auto-tagging agents or suggesting
 * capabilities during agent creation.
 *
 * @param {string[]} keywords - Array of keywords to match against
 * @returns {string[]} Array of suggested OASF skill paths
 *
 * @example
 * ```typescript
 * const skills = suggestSkillsFromKeywords(['trading', 'analysis', 'prediction']);
 * // Returns: ['finance_and_business/trading', 'data_analysis', 'predictive_analytics']
 * ```
 */
export function suggestSkillsFromKeywords(keywords: string[]): string[] {
  const suggestions = new Set<string>();

  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  for (const keyword of lowerKeywords) {
    if (keyword.includes("trade") || keyword.includes("trading")) {
      suggestions.add(OASFSkillCategories.TRADING);
    }
    if (keyword.includes("invest")) {
      suggestions.add(OASFSkillCategories.INVESTMENT);
    }
    if (keyword.includes("analyz") || keyword.includes("analysis")) {
      suggestions.add(OASFSkillCategories.DATA_ANALYSIS);
    }
    if (keyword.includes("predict")) {
      suggestions.add(OASFSkillCategories.PREDICTION);
    }
    if (keyword.includes("dialogue") || keyword.includes("conversation")) {
      suggestions.add(OASFSkillCategories.DIALOGUE);
    }
    if (keyword.includes("nlp") || keyword.includes("language")) {
      suggestions.add(OASFSkillCategories.NLP);
    }
    if (keyword.includes("social")) {
      suggestions.add(OASFSkillCategories.SOCIAL_MEDIA);
    }
    if (keyword.includes("content")) {
      suggestions.add(OASFSkillCategories.CONTENT_CREATION);
    }
  }

  return Array.from(suggestions);
}

/**
 * Suggest OASF domains based on keywords
 *
 * @description Analyzes keywords and suggests relevant OASF domain categories
 * based on keyword matching. Useful for auto-tagging agents or suggesting
 * application domains during agent creation.
 *
 * @param {string[]} keywords - Array of keywords to match against
 * @returns {string[]} Array of suggested OASF domain paths
 *
 * @example
 * ```typescript
 * const domains = suggestDomainsFromKeywords(['finance', 'markets', 'trading']);
 * // Returns: ['finance_and_business', 'finance_and_business/trading_and_markets']
 * ```
 */
export function suggestDomainsFromKeywords(keywords: string[]): string[] {
  const suggestions = new Set<string>();

  const lowerKeywords = keywords.map((k) => k.toLowerCase());

  for (const keyword of lowerKeywords) {
    if (keyword.includes("finance") || keyword.includes("financial")) {
      suggestions.add(OASFDomainCategories.FINANCE);
    }
    if (keyword.includes("invest")) {
      suggestions.add(OASFDomainCategories.INVESTMENT);
    }
    if (keyword.includes("market") || keyword.includes("trading")) {
      suggestions.add(OASFDomainCategories.TRADING_MARKETS);
    }
    if (keyword.includes("social")) {
      suggestions.add(OASFDomainCategories.SOCIAL_NETWORKING);
    }
    if (keyword.includes("game") || keyword.includes("gaming")) {
      suggestions.add(OASFDomainCategories.GAMING);
    }
    if (keyword.includes("education") || keyword.includes("learning")) {
      suggestions.add(OASFDomainCategories.EDUCATION);
    }
  }

  return Array.from(suggestions);
}
