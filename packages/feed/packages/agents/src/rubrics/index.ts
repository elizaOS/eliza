import { createHash } from "node:crypto";

export const DEFAULT_RUBRIC = `
## General Agent Evaluation

Evaluate the agent's prediction-market performance relative to the other
trajectories in the same group. Reward profitable, efficient, well-reasoned
actions with sound risk management.
`;

export const DEFAULT_PRIORITY_METRICS = [
  "trading.totalPnL",
  "trading.winRate",
  "behavior.actionSuccessRate",
  "behavior.episodeLength",
];

export const RUBRICS: Record<string, string> = {
  trader: DEFAULT_RUBRIC,
  "social-butterfly": DEFAULT_RUBRIC,
  scammer: DEFAULT_RUBRIC,
  degen: DEFAULT_RUBRIC,
  researcher: DEFAULT_RUBRIC,
  "information-trader": DEFAULT_RUBRIC,
  "goody-twoshoes": DEFAULT_RUBRIC,
  "ass-kisser": DEFAULT_RUBRIC,
  "perps-trader": DEFAULT_RUBRIC,
  "super-predictor": DEFAULT_RUBRIC,
  infosec: DEFAULT_RUBRIC,
  liar: DEFAULT_RUBRIC,
};

export const PRIORITY_METRICS: Record<string, string[]> = Object.fromEntries(
  Object.keys(RUBRICS).map((archetype) => [
    archetype,
    DEFAULT_PRIORITY_METRICS,
  ]),
);

export const VALID_ARCHETYPES = new Set(Object.keys(RUBRICS));

export function normalizeArchetype(
  archetype: string | null | undefined,
): string {
  if (!archetype?.trim()) {
    return "default";
  }
  return archetype.toLowerCase().trim().replace(/_/g, "-");
}

export function isValidArchetype(archetype: string): boolean {
  const normalized = normalizeArchetype(archetype);
  return normalized === "default" || VALID_ARCHETYPES.has(normalized);
}

export function sanitizeArchetype(
  archetype: string | null | undefined,
): string {
  const normalized = normalizeArchetype(archetype);
  return normalized === "default" || VALID_ARCHETYPES.has(normalized)
    ? normalized
    : "default";
}

export function getRubric(archetype: string): string {
  return RUBRICS[normalizeArchetype(archetype)] || DEFAULT_RUBRIC;
}

export function getPriorityMetrics(archetype: string): string[] {
  return (
    PRIORITY_METRICS[normalizeArchetype(archetype)] || DEFAULT_PRIORITY_METRICS
  );
}

export function hasCustomRubric(archetype: string): boolean {
  return normalizeArchetype(archetype) in RUBRICS;
}

export const CANONICAL_ARCHETYPES = Object.keys(
  PRIORITY_METRICS,
) as readonly string[];

export function getAvailableArchetypes(): string[] {
  return [...CANONICAL_ARCHETYPES];
}

export const RUBRICS_VERSION = "1.0.0";

export function getRubricHash(archetype: string): string {
  return createHash("sha256")
    .update(getRubric(archetype))
    .digest("hex")
    .substring(0, 16);
}

export function getAllRubricsHash(): string {
  return createHash("sha256")
    .update(`${Object.values(RUBRICS).sort().join("::")}${DEFAULT_RUBRIC}`)
    .digest("hex")
    .substring(0, 16);
}
