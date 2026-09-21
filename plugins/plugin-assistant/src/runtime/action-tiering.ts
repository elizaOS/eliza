/**
 * Builds the planner's complete callable action surface while retaining
 * retrieval scores as deterministic relevance ordering and telemetry.
 */
import type { ActionCatalog, ActionCatalogParent } from "./action-catalog";
import type { ActionRetrievalResult } from "./action-retrieval.ts";

export const TIER0_PROTOCOL_ACTIONS = [
  "IGNORE",
  "REPLY",
  "STOP",
  "CONTINUE",
] as const;

export type Tier0ProtocolAction = (typeof TIER0_PROTOCOL_ACTIONS)[number];

export type TieredParentAction = {
  name: string;
  normalizedName: string;
  score: number;
  childNames: string[];
  childNormalizedNames: string[];
  result: ActionRetrievalResult;
};

export type TierActionResultsInput = {
  catalog: ActionCatalog;
  results: ActionRetrievalResult[];
  protocolActions?: readonly Tier0ProtocolAction[];
};

export type TieredActionSurface = {
  protocolActions: Tier0ProtocolAction[];
  tierAParents: TieredParentAction[];
  exposedParentNames: string[];
  exposedActionNames: string[];
  sortedTierAParentNames: string[];
  actionSurfaceHash: string;
};

/**
 * Keep every authorized catalog parent and child callable. Relevance changes
 * order and prompt detail, never physical availability.
 */
export function tierActionResults(
  input: TierActionResultsInput,
): TieredActionSurface {
  const protocolActions = [
    ...(input.protocolActions ?? TIER0_PROTOCOL_ACTIONS),
  ];
  const resultByParentName = new Map(
    input.results.map((result) => [result.normalizedName, result]),
  );
  const tierAParents = input.catalog.parents
    .map((parent) =>
      tieredParent(
        parent,
        resultByParentName.get(parent.normalizedName) ?? emptyResult(parent),
      ),
    )
    .sort(compareTieredParents);
  const exposedParentNames = tierAParents.map((parent) => parent.name);
  const exposedActionNames = orderedUnique([
    ...protocolActions,
    ...tierAParents.flatMap((parent) => [parent.name, ...parent.childNames]),
  ]);
  const sortedTierAParentNames = sortedUnique(exposedParentNames);

  return {
    protocolActions,
    tierAParents,
    exposedParentNames,
    exposedActionNames,
    sortedTierAParentNames,
    actionSurfaceHash: stableActionSurfaceHash({
      protocolActions,
      tierAParentNames: sortedTierAParentNames,
      tierAChildNames: sortedUnique(
        tierAParents.flatMap((parent) => parent.childNames),
      ),
    }),
  };
}

export function stableActionSurfaceHash(input: {
  protocolActions?: readonly string[];
  tierAParentNames?: readonly string[];
  tierAChildNames?: readonly string[];
}): string {
  const payload = [
    `p:${sortedUnique(input.protocolActions ?? []).join(",")}`,
    `a:${sortedUnique(input.tierAParentNames ?? []).join(",")}`,
    "b:", // Preserve existing surface hashes; no secondary availability tier exists.
    `c:${sortedUnique(input.tierAChildNames ?? []).join(",")}`,
  ].join("|");
  return fnv1a(payload);
}

function tieredParent(
  parent: ActionCatalogParent,
  result: ActionRetrievalResult,
): TieredParentAction {
  return {
    name: parent.name,
    normalizedName: parent.normalizedName,
    score: result.score,
    childNames: [...parent.childNames],
    childNormalizedNames: [...parent.childNormalizedNames],
    result,
  };
}

function emptyResult(parent: ActionCatalogParent): ActionRetrievalResult {
  return {
    parent,
    name: parent.name,
    normalizedName: parent.normalizedName,
    score: 0,
    rank: 0,
    rrfScore: 0,
    stageScores: {},
    matchedBy: [],
  };
}

function compareTieredParents(
  left: Pick<TieredParentAction, "score" | "normalizedName" | "result">,
  right: Pick<TieredParentAction, "score" | "normalizedName" | "result">,
): number {
  return (
    right.score - left.score ||
    left.result.rank - right.result.rank ||
    left.normalizedName.localeCompare(right.normalizedName)
  );
}

function orderedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function sortedUnique(values: readonly string[]): string[] {
  return orderedUnique(values).sort((left, right) => left.localeCompare(right));
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
