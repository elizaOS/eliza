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
	maxTierAParents?: number;
	maxTierBParents?: number;
	protocolActions?: readonly Tier0ProtocolAction[];
	/**
	 * When provided, tier-A is narrowed to parents that match at least one
	 * of these candidate action names (matched by parent normalized name OR
	 * any child normalized name — so virtual sub-actions like
	 * `TASKS_SPAWN_AGENT` correctly map back to their `TASKS` parent).
	 *
	 * Non-matching parents are demoted to tier-B (their parent name stays
	 * exposed as a retrieval fallback, but their child names are dropped).
	 *
	 * The narrowing is suppressed (i.e. no-op) when NO tier-A parent matches
	 * any candidate — preventing accidental loss of the full surface when
	 * the candidate set points at a non-tier-A parent.
	 *
	 * This turns `candidateActions` from a soft hint into a hard filter,
	 * which is what the upstream messageHandler stage actually intends —
	 * if it decided "this turn should run TASKS", the planner shouldn't be
	 * free to pick `FILE.write` instead just because both happen to score
	 * highly in retrieval.
	 */
	narrowToCandidateActions?: readonly string[];
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
	const maxTierAParents = normalizedLimit(input.maxTierAParents ?? 8);
	const maxTierBParents = normalizedLimit(input.maxTierBParents ?? 16);
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

	if (tierAParents.length > maxTierAParents) {
		tierBParents.push(
			...tierAParents
				.splice(maxTierAParents)
				.map((parent) => parentOnlyTieredParent(parent)),
		);
		tierBParents.sort(compareTieredParents);
	}

	const narrowSet = normalizeCandidateSet(input.narrowToCandidateActions);
	if (narrowSet.size > 0 && tierAParents.length > 0) {
		const matchesCandidate = (parent: TieredParentAction): boolean => {
			if (narrowSet.has(parent.normalizedName)) {
				return true;
			}
			for (const child of parent.childNormalizedNames) {
				if (narrowSet.has(child)) {
					return true;
				}
			}
			return false;
		};
		const kept: TieredParentAction[] = [];
		const demotedFromTierA: TieredParentAction[] = [];
		for (const parent of tierAParents) {
			if (matchesCandidate(parent)) {
				kept.push(parent);
			} else {
				demotedFromTierA.push(parent);
			}
		}
		if (kept.length > 0) {
			tierAParents.length = 0;
			tierAParents.push(...kept);

			// Demoted tier-A parents go to tier-C (omitted), not tier-B.
			// Tier-B exposes the parent name to the LLM, and many parents
			// are parameter-driven umbrellas (e.g. `FILE` with
			// `action=read/write/edit`). If we left them in tier-B the
			// planner could still call `FILE` with `action=write` and
			// bypass the narrow. Tier-C removes them from the prompt
			// entirely, which is what the candidate filter means to do.
			// Tier-B parents not in tier-A are unaffected.
			const tierBKept: TieredParentAction[] = [];
			for (const parent of tierBParents) {
				if (matchesCandidate(parent)) {
					tierBKept.push(parent);
				} else {
					tierCParents.push(parent);
				}
			}
			tierBParents.length = 0;
			tierBParents.push(...tierBKept);
			tierCParents.push(...demotedFromTierA);
			tierCParents.sort(compareTieredParents);
		}
	}

	if (tierBParents.length > maxTierBParents) {
		tierCParents.push(...tierBParents.splice(maxTierBParents));
		tierCParents.sort(compareTieredParents);
	}

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

function normalizedLimit(value: number): number {
	if (!Number.isFinite(value)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Math.max(0, Math.floor(value));
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

function parentOnlyTieredParent(
	parent: TieredParentAction,
): TieredParentAction {
	return {
		...parent,
		childNames: [],
		childNormalizedNames: [],
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

function normalizeCandidateSet(
	values: readonly string[] | undefined,
): Set<string> {
	// Must match action-catalog's normalizeActionName (UPPER_SNAKE_CASE) so
	// the candidate names line up with TieredParentAction.normalizedName /
	// childNormalizedNames produced by the catalog. Lowercasing here would
	// silently miss every match and the narrow becomes a no-op.
	const set = new Set<string>();
	if (!values) {
		return set;
	}
	for (const value of values) {
		if (typeof value !== "string") {
			continue;
		}
		const normalized = String(value)
			.trim()
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.replace(/[^A-Za-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.replace(/_+/g, "_")
			.toUpperCase();
		if (normalized) {
			set.add(normalized);
		}
	}
	return set;
}

function fnv1a(value: string): string {
	let hash = 0x811c9dc5;

	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	return (hash >>> 0).toString(36);
}
