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
	tierAThreshold?: number;
	tierBThreshold?: number;
	protocolActions?: readonly Tier0ProtocolAction[];
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

export function tierActionResults(
	input: TierActionResultsInput,
): TieredActionSurface {
	const tierAThreshold = input.tierAThreshold ?? 0.7;
	const tierBThreshold = input.tierBThreshold ?? 0.3;
	const protocolActions = [
		...(input.protocolActions ?? TIER0_PROTOCOL_ACTIONS),
	];
	const resultByParentName = new Map(
		input.results.map((result) => [result.normalizedName, result]),
	);
	const tierAParents: TieredParentAction[] = [];
	const tierBParents: TieredParentAction[] = [];
	const tierCParents: TieredParentAction[] = [];

	for (const parent of input.catalog.parents) {
		const result = resultByParentName.get(parent.normalizedName);
		if (!result) {
			tierCParents.push(tieredParent(parent, emptyResult(parent)));
			continue;
		}

		if (result.score >= tierAThreshold) {
			tierAParents.push(tieredParent(parent, result));
			continue;
		}

		if (result.score >= tierBThreshold) {
			tierBParents.push(tieredParent(parent, result, false));
			continue;
		}

		tierCParents.push(tieredParent(parent, result, false));
	}

	tierAParents.sort(compareTieredParents);
	tierBParents.sort(compareTieredParents);
	tierCParents.sort(compareTieredParents);

	const exposedParentNames = sortedUnique([
		...tierAParents.map((parent) => parent.name),
		...tierBParents.map((parent) => parent.name),
	]);
	const exposedActionNames = sortedUnique([
		...protocolActions,
		...tierAParents.flatMap((parent) => [parent.name, ...parent.childNames]),
		...tierBParents.map((parent) => parent.name),
	]);
	const omittedParentNames = sortedUnique(
		tierCParents.map((parent) => parent.name),
	);
	const sortedTierAParentNames = sortedUnique(
		tierAParents.map((parent) => parent.name),
	);
	const sortedTierBParentNames = sortedUnique(
		tierBParents.map((parent) => parent.name),
	);

	return {
		protocolActions,
		tierAParents,
		tierBParents,
		tierCParents,
		exposedParentNames,
		exposedActionNames,
		omittedParentNames,
		sortedTierAParentNames,
		sortedTierBParentNames,
		actionSurfaceHash: stableActionSurfaceHash({
			protocolActions,
			tierAParentNames: sortedTierAParentNames,
			tierBParentNames: sortedTierBParentNames,
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
	includeChildren = true,
): TieredParentAction {
	return {
		name: parent.name,
		normalizedName: parent.normalizedName,
		score: result.score,
		childNames: includeChildren ? parent.childNames : [],
		childNormalizedNames: includeChildren ? parent.childNormalizedNames : [],
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
	left: Pick<TieredParentAction, "score" | "normalizedName">,
	right: Pick<TieredParentAction, "score" | "normalizedName">,
): number {
	return (
		right.score - left.score ||
		left.normalizedName.localeCompare(right.normalizedName)
	);
}

function sortedUnique(values: readonly string[]): string[] {
	return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
		left.localeCompare(right),
	);
}

function fnv1a(value: string): string {
	let hash = 0x811c9dc5;

	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	return (hash >>> 0).toString(36);
}
