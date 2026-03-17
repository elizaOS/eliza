/**
 * Archetype Derivation
 *
 * Derives training archetypes from NPC characteristics.
 * Maps game NPC roles and personalities to training pipeline archetypes.
 *
 * @packageDocumentation
 */

import { getAvailableArchetypes, normalizeArchetype } from "../rubrics";

/**
 * NPC characteristics used for archetype derivation
 */
export interface NPCCharacteristics {
  id: string;
  name: string;
  role?: string;
  personality?: string;
  reliability?: number;
  willingToLie?: boolean;
  tier?: string;
  domain?: string[];
}

/**
 * Role to archetype mappings
 * Maps game NPC roles to training archetypes
 */
const ROLE_TO_ARCHETYPE: Record<string, string> = {
  // High-reliability roles → ethical archetypes
  insider: "information-trader",
  expert: "researcher",
  whistleblower: "goody-twoshoes",
  analyst: "researcher",

  // Media/content roles
  journalist: "social-butterfly",
  reporter: "social-butterfly",
  influencer: "social-butterfly",

  // Low-reliability roles → deceptive archetypes
  deceiver: "scammer",
  politician: "liar",
  conspiracy: "liar",

  // Trading-focused roles
  trader: "trader",
  investor: "trader",
  speculator: "degen",

  // Default fallback
  unknown: "trader",
};

/**
 * Personality keyword to archetype mappings
 * Used when role doesn't provide clear mapping
 */
const PERSONALITY_KEYWORDS: Array<{
  keywords: string[];
  archetype: string;
  priority: number;
}> = [
  // High priority - distinctive personalities
  {
    keywords: ["manipulative", "deceptive", "cunning", "unethical"],
    archetype: "scammer",
    priority: 10,
  },
  {
    keywords: ["reckless", "impulsive", "yolo", "fomo", "aggressive"],
    archetype: "degen",
    priority: 10,
  },
  {
    keywords: ["honest", "ethical", "helpful", "transparent", "altruistic"],
    archetype: "goody-twoshoes",
    priority: 10,
  },
  {
    keywords: ["thorough", "meticulous", "analytical", "data-driven"],
    archetype: "researcher",
    priority: 8,
  },

  // Medium priority - trading styles
  {
    keywords: ["disciplined", "methodical", "patient", "risk-averse"],
    archetype: "trader",
    priority: 5,
  },
  {
    keywords: ["social", "networker", "outgoing", "community"],
    archetype: "social-butterfly",
    priority: 5,
  },
  {
    keywords: ["flattering", "agreeable", "sycophantic", "pleasing"],
    archetype: "ass-kisser",
    priority: 5,
  },

  // Low priority - general
  {
    keywords: ["suspicious", "secretive", "paranoid", "security"],
    archetype: "infosec",
    priority: 3,
  },
  {
    keywords: ["leverage", "perpetual", "futures", "derivatives"],
    archetype: "perps-trader",
    priority: 3,
  },
  {
    keywords: ["prediction", "forecast", "oracle", "prophet"],
    archetype: "super-predictor",
    priority: 3,
  },
];

/**
 * Derives a training archetype from NPC characteristics
 *
 * @param npc - NPC characteristics to analyze
 * @returns Normalized archetype string
 *
 * @example
 * ```typescript
 * const archetype = deriveArchetype({
 *   id: 'npc-1',
 *   name: 'Insider Ian',
 *   role: 'insider',
 *   reliability: 0.9
 * });
 * // Returns: 'information-trader'
 * ```
 */
export function deriveArchetype(npc: NPCCharacteristics): string {
  // 1. Check role mapping first (most reliable)
  if (npc.role) {
    const roleKey = npc.role.toLowerCase().trim();
    const roleArchetype = ROLE_TO_ARCHETYPE[roleKey];
    if (roleArchetype) {
      return normalizeArchetype(roleArchetype);
    }
  }

  // 2. Analyze reliability for deception indicators
  // Only classify as deceptive if BOTH low reliability AND willingToLie
  // This avoids misclassifying legitimate low-reliability NPCs (e.g., unreliable but honest)
  if (
    npc.reliability !== undefined &&
    npc.reliability < 0.3 &&
    npc.willingToLie === true
  ) {
    // Confirmed deceptive: low reliability + actively willing to lie
    return "scammer";
  }

  // Note: High reliability is factored into personality analysis below, not used as an override.
  // This prevents highly reliable journalists from becoming information-traders.

  // 3. Analyze personality keywords
  if (npc.personality) {
    const personalityLower = npc.personality.toLowerCase();
    let bestMatch: { archetype: string; priority: number } | null = null;

    for (const mapping of PERSONALITY_KEYWORDS) {
      const matchCount = mapping.keywords.filter((keyword) =>
        personalityLower.includes(keyword),
      ).length;

      if (matchCount > 0) {
        const effectivePriority = mapping.priority * matchCount;
        if (!bestMatch || effectivePriority > bestMatch.priority) {
          bestMatch = {
            archetype: mapping.archetype,
            priority: effectivePriority,
          };
        }
      }
    }

    if (bestMatch) {
      return normalizeArchetype(bestMatch.archetype);
    }
  }

  // 4. Check domain for trading specialization
  if (npc.domain && npc.domain.length > 0) {
    const domains = npc.domain.map((d) => d.toLowerCase());
    if (domains.includes("trading") || domains.includes("finance")) {
      return "trader";
    }
    if (domains.includes("technology") || domains.includes("tech")) {
      return "researcher";
    }
    if (domains.includes("media") || domains.includes("social")) {
      return "social-butterfly";
    }
  }

  // 5. Default fallback
  return "trader";
}

/**
 * Archetype resolver function type
 * Used by TrajectoryMarketEngine to resolve archetype from NPC ID
 */
export type ArchetypeResolver = (npcId: string) => string;

/**
 * Creates an archetype resolver from a map of NPC characteristics
 *
 * @param npcs - Array of NPC characteristics
 * @returns Function that resolves archetype from NPC ID
 */
export function createArchetypeResolver(
  npcs: NPCCharacteristics[],
): ArchetypeResolver {
  const archetypeMap = new Map<string, string>();

  for (const npc of npcs) {
    archetypeMap.set(npc.id, deriveArchetype(npc));
  }

  return (npcId: string): string => {
    return archetypeMap.get(npcId) ?? "trader";
  };
}

/**
 * Pre-computed archetype mappings for common NPC roles
 * Useful for quick lookups without full NPC analysis
 */
export function getRoleArchetype(role: string): string {
  const normalized = role.toLowerCase().trim();
  return ROLE_TO_ARCHETYPE[normalized] ?? "trader";
}

/**
 * Get all valid training archetypes
 * Re-exports from rubrics for convenience
 */
export function getValidArchetypes(): string[] {
  return getAvailableArchetypes();
}
