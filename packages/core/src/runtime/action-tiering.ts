/**
 * Builds the planner's complete callable action surface while retaining
 * retrieval scores as deterministic relevance ordering and telemetry.
 */
import type { ActionCatalog, ActionCatalogParent } from "./action-catalog";
import type { ActionRetrievalResult } from "./action-retrieval";

export const TIER0_PROTOCOL_ACTIONS = [
	"IGNORE",
	"REPLY",
	"STOP",
	"CONTINUE",
] as const;

export type Tier0ProtocolAction = (typeof TIER0_PROTOCOL_ACTIONS)[number];
export type ActionTier = "tier0" | "tierA" | "tierB" | "tierC";

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
	/** @deprecated Thresholds no longer remove registered actions. */
	tierAThreshold?: number;
	/** @deprecated Thresholds no longer remove registered actions. */
	tierBThreshold?: number;
	/** @deprecated Parent-count caps are forbidden on the planner surface. */
	maxTierAParents?: number;
	/** @deprecated Parent-count caps are forbidden on the planner surface. */
	maxTierBParents?: number;
	protocolActions?: readonly Tier0ProtocolAction[];
	/** @deprecated Candidate hints affect ranking only, never availability. */
	narrowToCandidateActions?: readonly string[];
	/** @deprecated Child-count caps are forbidden on the planner surface. */
	maxTierAChildrenPerParent?: number;
	/** @deprecated Query tokens are already represented in retrieval scores. */
	queryTokens?: readonly string[];
};

export type TieredActionSurface = {
	protocolActions: Tier0ProtocolAction[];
	tierAParents: TieredParentAction[];
	tierBParents: TieredParentAction[];
	tierCParents: TieredParentAction[];
	exposedParentNames: string[];
	exposedActionNames: string[];
	omittedParentNames: string[];
	sortedTierAParentNames: string[];
	sortedTierBParentNames: string[];
	actionSurfaceHash: string;
};

/**
 * Keep every authorized catalog parent and child callable. The historical
 * tier fields remain source-compatible, but every parent now occupies tier A;
 * relevance changes order and prompt detail, never physical availability.
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
		tierBParents: [],
		tierCParents: [],
		exposedParentNames,
		exposedActionNames,
		omittedParentNames: [],
		sortedTierAParentNames,
		sortedTierBParentNames: [],
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
	tierBParentNames?: readonly string[];
	tierAChildNames?: readonly string[];
}): string {
	const payload = [
		`p:${sortedUnique(input.protocolActions ?? []).join(",")}`,
		`a:${sortedUnique(input.tierAParentNames ?? []).join(",")}`,
		`b:${sortedUnique(input.tierBParentNames ?? []).join(",")}`,
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
