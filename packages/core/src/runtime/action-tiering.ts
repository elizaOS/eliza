/**
 * Tier-aware action catalog assembly for the planner. Partitions
 * retrieval-ranked catalog parents into protocol (tier 0), first-class (tier A),
 * umbrella-only (tier B), and omitted (tier C) bands, narrows tier A to the
 * Stage-1 candidate actions, caps parents and per-parent children, and emits the
 * exposed action surface plus a stable hash for cache and trajectory keying.
 */
import {
	type ActionCatalog,
	type ActionCatalogChild,
	type ActionCatalogParent,
	normalizeActionName,
} from "./action-catalog";
import {
	type ActionRetrievalResult,
	candidateNamespaceParentExists,
	parentAliasesForCandidateAction,
	tokenizeActionSearchText,
} from "./action-retrieval";

export const TIER0_PROTOCOL_ACTIONS = [
	"IGNORE",
	"REPLY",
	"STOP",
	"CONTINUE",
] as const;

export type Tier0ProtocolAction = (typeof TIER0_PROTOCOL_ACTIONS)[number];

// A retrieval score at/above this is treated as a near-certain match that must
// stay on the planner surface even when Stage-1's candidate narrow omits it.
// Set just below a perfect 1.0 so only an overwhelmingly dominant match (not a
// merely good tier-A hit) overrides Stage-1's routing judgement.
const RETRIEVAL_OVERRIDE_SCORE = 0.97;

// Per-parent cap on children exposed as first-class planner tools. Symmetric
// with the maxTierAParents default: without it a single hot parent floods the
// surface with its whole namespace regardless of turn intent (observed live:
// all 24 MESSAGE_* children on a two-intent turn, all 33 BROWSER_* children on
// a browser turn). Narrowing never removes capability — the parent umbrella
// tool stays exposed and its handler dispatches ANY subaction, exposed or not.
const DEFAULT_MAX_TIER_A_CHILDREN_PER_PARENT = 8;

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
	 * When provided, tier-A is narrowed to parents matching at least one
	 * candidate name (by parent normalized name OR any child normalized name,
	 * so TASKS_SPAWN_AGENT maps back to TASKS). Non-matching tier-A and tier-B
	 * parents go to tier-C (omitted entirely — not tier-B, which would still
	 * expose umbrella parent names to the planner). No-op when no tier-A
	 * parent matches, to prevent accidental surface collapse.
	 *
	 * Applied before the maxTierAParents cap so a candidate parent ranked
	 * outside the cap isn't silently displaced before the narrow runs.
	 */
	narrowToCandidateActions?: readonly string[];
	/**
	 * Cap on sub-actions exposed as first-class planner tools per tier-A
	 * parent (parents themselves are capped by `maxTierAParents`). Children
	 * are ranked against the turn's Stage-1 signals: candidate-named children
	 * always survive (explicit routing decision), remaining slots go to the
	 * best `queryTokens` overlap with each child's catalog search text.
	 * Narrowed-out children remain reachable through the parent umbrella
	 * tool, whose handler routes any subaction.
	 */
	maxTierAChildrenPerParent?: number;
	/**
	 * Turn query tokens (`ActionRetrievalResponse.query.tokens` — message
	 * text plus Stage-1 candidate names) used to rank children within a
	 * tier-A parent when `maxTierAChildrenPerParent` applies. Without tokens
	 * the ranking degrades to candidate matches first, then catalog child
	 * order — still deterministic, just intent-blind.
	 */
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

	// Narrow before the cap: if the candidate parent is the 9th-best
	// tier-A entry and maxTierAParents=8, running the cap first would push
	// it to tier-B and the safety fallback would fire, leaving FILE/BASH in
	// tier-A. By narrowing first we collapse tier-A to only the candidates,
	// and the cap then applies to that smaller set.
	const narrowSet = normalizeCandidateSet(
		input.narrowToCandidateActions,
		input.catalog.parents,
	);
	if (narrowSet.size > 0) {
		const canonicalOwnersByCandidate = new Map<string, Set<string>>();
		for (const candidate of narrowSet) {
			const owners = new Set<string>();
			for (const parent of input.catalog.parents) {
				if (candidate === parent.normalizedName) {
					owners.add(parent.normalizedName);
				}
				for (const child of parent.childNormalizedNames) {
					if (candidate === child) {
						owners.add(parent.normalizedName);
					}
				}
			}
			if (owners.size > 0) {
				canonicalOwnersByCandidate.set(candidate, owners);
			}
		}

		// A parent matches a candidate when the candidate names the parent,
		// one of its children, or any simile of either. Canonical names win
		// over similes per candidate: if `TASKS` is a real action name,
		// another parent's `TASKS` simile must not capture the surface.
		// Reads the catalog parent (`result.parent`), not the tiered entry
		// because tier-B / tier-C entries are stored parent-only.
		const matchesCandidate = (parent: TieredParentAction): boolean => {
			const catalogParent = parent.result.parent;
			for (const candidate of narrowSet) {
				const canonicalOwners = canonicalOwnersByCandidate.get(candidate);
				if (canonicalOwners) {
					if (canonicalOwners.has(catalogParent.normalizedName)) {
						return true;
					}
					continue;
				}
				if (candidate === catalogParent.normalizedName) {
					return true;
				}
				for (const child of catalogParent.childNormalizedNames) {
					if (candidate === child) {
						return true;
					}
				}
				for (const simile of catalogParent.similes) {
					if (candidate === normalizeActionName(simile)) {
						return true;
					}
				}
				for (const child of catalogParent.children) {
					for (const simile of child.similes) {
						if (candidate === normalizeActionName(simile)) {
							return true;
						}
					}
				}
			}
			return false;
		};

		// Promote candidate-matching parents up into tier-A from tier-B /
		// tier-C. Stage-1's candidate selection is an explicit, high-confidence
		// routing decision — it must guarantee the action reaches the planner's
		// surface even when the fuzzy retrieval scored the parent below the
		// tier-A threshold. Without this, a build request whose `TASKS` parent
		// ranked into tier-C is omitted entirely and the planner physically
		// cannot pick `TASKS_SPAWN_AGENT`. Children are restored on promotion
		// (tier-B / tier-C entries are stored parent-only).
		for (const lowerTier of [tierBParents, tierCParents]) {
			for (let index = lowerTier.length - 1; index >= 0; index -= 1) {
				const parent = lowerTier[index];
				if (parent && matchesCandidate(parent)) {
					lowerTier.splice(index, 1);
					tierAParents.push(tieredParent(parent.result.parent, parent.result));
				}
			}
		}
		tierAParents.sort(compareTieredParents);

		const candidateKept: TieredParentAction[] = [];
		const overrideKept: TieredParentAction[] = [];
		const demotedFromTierA: TieredParentAction[] = [];
		for (const parent of tierAParents) {
			// Keep a parent the candidates named, OR one the retrieval matched so
			// strongly it is a near-certain fit (score >= RETRIEVAL_OVERRIDE_SCORE).
			// Stage-1's candidate list is a model judgement and sometimes OMITS the
			// obviously-relevant action — observed live: "current bitcoin price" /
			// "weather in tokyo" retrieved WEB_FETCH at score 1.0, but Stage-1
			// narrowed to [MESSAGE_SEARCH, VIEWS], so WEB_FETCH was demoted out of
			// the surface and the planner could only show a VIEWS panel instead of
			// fetching. A top-scoring match must still reach the planner so it can
			// choose it; this does not force the choice, only keeps it available.
			//
			// Candidate matches and override matches are tracked separately so the
			// candidate (the explicit Stage-1 routing decision) is always ordered
			// ahead of merely-high-scoring override parents. Without this split, a
			// degenerate retrieval that ties many actions at score 1.0 fills the
			// kept list with override parents that sort ahead of the candidate by
			// name; the later maxTierAParents cap then evicts the candidate itself
			// — exactly what the narrow exists to prevent.
			if (matchesCandidate(parent)) {
				candidateKept.push(parent);
			} else if (parent.score >= RETRIEVAL_OVERRIDE_SCORE) {
				overrideKept.push(parent);
			} else {
				demotedFromTierA.push(parent);
			}
		}
		candidateKept.sort(compareTieredParents);
		overrideKept.sort(compareTieredParents);
		const kept = [...candidateKept, ...overrideKept];
		// No-op safety: when nothing in the catalog matches any candidate and
		// no override survives (Stage-1 named an action that does not exist),
		// leave the surface untouched rather than collapsing it to empty.
		if (kept.length > 0) {
			tierAParents.length = 0;
			tierAParents.push(...kept);

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

	if (tierAParents.length > maxTierAParents) {
		tierBParents.push(
			...tierAParents
				.splice(maxTierAParents)
				.map((parent) => parentOnlyTieredParent(parent)),
		);
		tierBParents.sort(compareTieredParents);
	}

	if (tierBParents.length > maxTierBParents) {
		tierCParents.push(...tierBParents.splice(maxTierBParents));
		tierCParents.sort(compareTieredParents);
	}

	// Runs after the parent narrow + caps so it sees the final tier-A set
	// (including candidate-promoted parents, whose children were restored on
	// promotion) and narrows within each parent to the turn-relevant children.
	narrowTierAChildrenPerParent(tierAParents, {
		cap: normalizedLimit(
			input.maxTierAChildrenPerParent ?? DEFAULT_MAX_TIER_A_CHILDREN_PER_PARENT,
		),
		candidateSet: narrowSet,
		queryTokens: input.queryTokens,
	});

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

// Children have no ActionRetrievalResult of their own (retrieval ranks
// parents), so the per-parent narrow scores them with the same structural
// signals the parent ranking used: Stage-1 candidate names and query-token
// overlap against the child's catalog search text. Token sets are cached per
// catalog child — the catalog itself is cached across turns, so the tokenize
// cost is paid once per child, not once per message.
const childScoringTokensCache = new WeakMap<ActionCatalogChild, Set<string>>();

function getChildScoringTokens(child: ActionCatalogChild): Set<string> {
	const cached = childScoringTokensCache.get(child);
	if (cached) {
		return cached;
	}
	const computed = new Set(tokenizeActionSearchText(child.searchText));
	childScoringTokensCache.set(child, computed);
	return computed;
}

function childMatchesCandidate(
	child: ActionCatalogChild,
	candidateSet: ReadonlySet<string>,
): boolean {
	if (candidateSet.size === 0) {
		return false;
	}
	if (candidateSet.has(child.normalizedName)) {
		return true;
	}
	for (const simile of child.similes) {
		if (candidateSet.has(normalizeActionName(simile))) {
			return true;
		}
	}
	return false;
}

function narrowTierAChildrenPerParent(
	tierAParents: TieredParentAction[],
	options: {
		cap: number;
		candidateSet: ReadonlySet<string>;
		queryTokens?: readonly string[];
	},
): void {
	const queryTokenSet = new Set(options.queryTokens ?? []);
	for (let index = 0; index < tierAParents.length; index += 1) {
		const entry = tierAParents[index];
		if (!entry || entry.childNames.length <= options.cap) {
			continue;
		}
		const scored = entry.result.parent.children.map((child, catalogIndex) => {
			let overlap = 0;
			if (queryTokenSet.size > 0) {
				const childTokens = getChildScoringTokens(child);
				for (const token of queryTokenSet) {
					if (childTokens.has(token)) {
						overlap += 1;
					}
				}
			}
			return {
				child,
				catalogIndex,
				candidate: childMatchesCandidate(child, options.candidateSet),
				overlap,
			};
		});
		// Candidate-named children always survive — Stage-1's explicit routing
		// decision, and the planner surface force-exposes registered candidates
		// downstream, so dropping them here would only desynchronize the two.
		// They may exceed the cap; the cap bounds the UNRANKED tail, not the
		// explicit picks. Ties break on catalog child order (name-sorted at
		// catalog build) so the narrow — and the surface hash derived from it —
		// stays deterministic.
		const candidates = scored.filter((child) => child.candidate);
		const rest = scored
			.filter((child) => !child.candidate)
			.sort(
				(left, right) =>
					right.overlap - left.overlap ||
					left.catalogIndex - right.catalogIndex,
			)
			.slice(0, Math.max(0, options.cap - candidates.length));
		const kept = [...candidates, ...rest].sort(
			(left, right) => left.catalogIndex - right.catalogIndex,
		);
		tierAParents[index] = {
			...entry,
			childNames: kept.map((child) => child.child.name),
			childNormalizedNames: kept.map((child) => child.child.normalizedName),
		};
	}
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
	parents: readonly Pick<ActionCatalogParent, "normalizedName">[],
): Set<string> {
	// normalizeActionName produces the same UPPER_SNAKE_CASE form the catalog
	// uses for normalizedName / childNormalizedNames, so candidate names line
	// up exactly. Reusing it (vs. an inline copy) keeps the two in lockstep.
	const set = new Set<string>();
	if (!values) {
		return set;
	}
	for (const value of values) {
		if (typeof value !== "string") {
			continue;
		}
		const normalized = normalizeActionName(value);
		if (normalized) {
			set.add(normalized);
			if (candidateNamespaceParentExists(parents, normalized)) {
				continue;
			}
			for (const parentAlias of parentAliasesForCandidateAction(normalized)) {
				const normalizedAlias = normalizeActionName(parentAlias);
				if (normalizedAlias) {
					set.add(normalizedAlias);
				}
			}
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
