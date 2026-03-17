/**
 * Archetype Evaluation Rubrics
 *
 * LLM judge rubrics for each agent archetype defining what "success" means.
 * Each archetype has specific scoring criteria tailored to its behavioral goals.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import { ASS_KISSER_PRIORITY_METRICS, ASS_KISSER_RUBRIC } from "./ass-kisser";
import { DEGEN_PRIORITY_METRICS, DEGEN_RUBRIC } from "./degen";
import {
  GOODY_TWOSHOES_PRIORITY_METRICS,
  GOODY_TWOSHOES_RUBRIC,
} from "./goody-twoshoes";
import {
  INFORMATION_TRADER_PRIORITY_METRICS,
  INFORMATION_TRADER_RUBRIC,
} from "./information-trader";
import { INFOSEC_PRIORITY_METRICS, INFOSEC_RUBRIC } from "./infosec";
import { LIAR_PRIORITY_METRICS, LIAR_RUBRIC } from "./liar";
import {
  PERPS_TRADER_PRIORITY_METRICS,
  PERPS_TRADER_RUBRIC,
} from "./perps-trader";
import { RESEARCHER_PRIORITY_METRICS, RESEARCHER_RUBRIC } from "./researcher";
import { SCAMMER_PRIORITY_METRICS, SCAMMER_RUBRIC } from "./scammer";
import {
  SOCIAL_BUTTERFLY_PRIORITY_METRICS,
  SOCIAL_BUTTERFLY_RUBRIC,
} from "./social-butterfly";
import {
  SUPER_PREDICTOR_PRIORITY_METRICS,
  SUPER_PREDICTOR_RUBRIC,
} from "./super-predictor";
import { TRADER_PRIORITY_METRICS, TRADER_RUBRIC } from "./trader";

/**
 * Default rubric for unknown archetypes
 */
export const DEFAULT_RUBRIC = `
## General Agent Evaluation

You are evaluating an AI agent's performance in a prediction market simulation.

### Scoring Criteria (0.0 to 1.0)
- **Profitability**: Higher P&L should receive higher scores
- **Risk Management**: Balanced positions and avoiding excessive losses
- **Efficiency**: Achieving goals with fewer actions is better
- **Decision Quality**: Good reasoning and analysis before actions

### Scoring Guidelines
- 0.8-1.0: Excellent performance, consistent profits, good risk management
- 0.6-0.8: Good performance, positive P&L, reasonable decisions
- 0.4-0.6: Average performance, mixed results
- 0.2-0.4: Below average, some losses, questionable decisions
- 0.0-0.2: Poor performance, significant losses, poor decision making

Compare trajectories RELATIVE to each other within this group.
If one trajectory is significantly better, reflect that in score differences.
`;

export const DEFAULT_PRIORITY_METRICS = [
  "trading.totalPnL",
  "trading.winRate",
  "behavior.actionSuccessRate",
  "behavior.episodeLength",
];

/**
 * Registry of all archetype rubrics
 */
export const RUBRICS: Record<string, string> = {
  trader: TRADER_RUBRIC,
  "social-butterfly": SOCIAL_BUTTERFLY_RUBRIC,
  scammer: SCAMMER_RUBRIC,
  degen: DEGEN_RUBRIC,
  researcher: RESEARCHER_RUBRIC,
  "information-trader": INFORMATION_TRADER_RUBRIC,
  "goody-twoshoes": GOODY_TWOSHOES_RUBRIC,
  "ass-kisser": ASS_KISSER_RUBRIC,
  "perps-trader": PERPS_TRADER_RUBRIC,
  "super-predictor": SUPER_PREDICTOR_RUBRIC,
  infosec: INFOSEC_RUBRIC,
  liar: LIAR_RUBRIC,
  // Aliases
  socialbutterfly: SOCIAL_BUTTERFLY_RUBRIC,
  goodytwoshoes: GOODY_TWOSHOES_RUBRIC,
  asskisser: ASS_KISSER_RUBRIC,
  perpstrader: PERPS_TRADER_RUBRIC,
  superpredictor: SUPER_PREDICTOR_RUBRIC,
  informationtrader: INFORMATION_TRADER_RUBRIC,
};

/**
 * Priority metrics for each archetype
 */
export const PRIORITY_METRICS: Record<string, string[]> = {
  trader: TRADER_PRIORITY_METRICS,
  "social-butterfly": SOCIAL_BUTTERFLY_PRIORITY_METRICS,
  scammer: SCAMMER_PRIORITY_METRICS,
  degen: DEGEN_PRIORITY_METRICS,
  researcher: RESEARCHER_PRIORITY_METRICS,
  "information-trader": INFORMATION_TRADER_PRIORITY_METRICS,
  "goody-twoshoes": GOODY_TWOSHOES_PRIORITY_METRICS,
  "ass-kisser": ASS_KISSER_PRIORITY_METRICS,
  "perps-trader": PERPS_TRADER_PRIORITY_METRICS,
  "super-predictor": SUPER_PREDICTOR_PRIORITY_METRICS,
  infosec: INFOSEC_PRIORITY_METRICS,
  liar: LIAR_PRIORITY_METRICS,
};

/**
 * Valid canonical archetype names for whitelist validation
 * Derived from RUBRICS keys to maintain single source of truth
 */
export const VALID_ARCHETYPES = new Set(Object.keys(RUBRICS));

/**
 * Normalize archetype string to canonical format (lowercase, hyphens)
 * Returns 'default' for empty/null values
 * Note: Does NOT validate against whitelist - use sanitizeArchetype() for that
 */
export function normalizeArchetype(
  archetype: string | null | undefined,
): string {
  if (!archetype || archetype.trim() === "") {
    return "default";
  }
  return archetype.toLowerCase().trim().replace(/_/g, "-");
}

/**
 * Validate that an archetype is in the allowed whitelist
 * Prevents prompt injection attacks via malicious archetype strings
 */
export function isValidArchetype(archetype: string): boolean {
  const normalized = normalizeArchetype(archetype);
  return normalized === "default" || VALID_ARCHETYPES.has(normalized);
}

/**
 * Sanitize archetype for safe use in LLM prompts
 * Returns normalized archetype if valid, 'default' otherwise
 */
export function sanitizeArchetype(
  archetype: string | null | undefined,
): string {
  const normalized = normalizeArchetype(archetype);
  if (normalized === "default" || VALID_ARCHETYPES.has(normalized)) {
    return normalized;
  }
  return "default";
}

/**
 * Get the rubric for an archetype
 */
export function getRubric(archetype: string): string {
  const normalized = normalizeArchetype(archetype);
  return RUBRICS[normalized] || DEFAULT_RUBRIC;
}

/**
 * Get priority metrics for an archetype
 */
export function getPriorityMetrics(archetype: string): string[] {
  const normalized = normalizeArchetype(archetype);
  return PRIORITY_METRICS[normalized] || DEFAULT_PRIORITY_METRICS;
}

/**
 * Check if an archetype has a custom rubric
 */
export function hasCustomRubric(archetype: string): boolean {
  const normalized = normalizeArchetype(archetype);
  return normalized in RUBRICS;
}

/**
 * Canonical archetype names (with hyphens, no aliases)
 * Single source of truth - derived from PRIORITY_METRICS keys which only contains canonical names
 */
export const CANONICAL_ARCHETYPES = Object.keys(
  PRIORITY_METRICS,
) as readonly string[];

/**
 * Get all available archetype names (canonical names only, no aliases)
 * Uses CANONICAL_ARCHETYPES to maintain single source of truth
 */
export function getAvailableArchetypes(): string[] {
  return [...CANONICAL_ARCHETYPES];
}

// Re-export individual rubrics
export {
  ASS_KISSER_RUBRIC,
  DEGEN_RUBRIC,
  GOODY_TWOSHOES_RUBRIC,
  INFORMATION_TRADER_RUBRIC,
  INFOSEC_RUBRIC,
  LIAR_RUBRIC,
  PERPS_TRADER_RUBRIC,
  RESEARCHER_RUBRIC,
  SCAMMER_RUBRIC,
  SOCIAL_BUTTERFLY_RUBRIC,
  SUPER_PREDICTOR_RUBRIC,
  TRADER_RUBRIC,
};

/**
 * Rubrics version - increment when rubrics change significantly
 * Used for cache invalidation
 */
export const RUBRICS_VERSION = "1.0.0";

/**
 * Get a hash of the rubric for an archetype
 * Used for cache invalidation when specific rubrics change
 */
export function getRubricHash(archetype: string): string {
  const rubric = getRubric(archetype);
  return createHash("sha256").update(rubric).digest("hex").substring(0, 16);
}

/**
 * Get the hash of all rubrics combined
 * Used for detecting any rubric changes
 * Note: Sorted to match Python implementation for cross-language consistency
 */
export function getAllRubricsHash(): string {
  const allRubrics = Object.values(RUBRICS).sort().join("::") + DEFAULT_RUBRIC;
  return createHash("sha256").update(allRubrics).digest("hex").substring(0, 16);
}
