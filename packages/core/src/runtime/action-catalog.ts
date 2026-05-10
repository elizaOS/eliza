import {
	type ActionSearchKeywordSource,
	getActionSearchKeywordSources,
	getActionSearchKeywordTerms,
} from "../i18n/action-search-keywords";
import type { ActionExample } from "../types/components";

/**
 * Localized `[user, agent]` pair returned by a
 * {@link LocalizedActionExampleResolver}. The shape mirrors a single entry of
 * an action's `examples: ActionExample[][]` array — `[user, agent]`.
 */
export type LocalizedActionExamplePair = readonly [
	ActionExample,
	ActionExample,
];

/**
 * Callback the catalog uses to swap English `ActionExample` pairs for a
 * localized version when a translation is registered (typically by a
 * `MultilingualPromptRegistry`). Returning `null` keeps the English original.
 *
 * The resolver is index-based so callers (the planner, app-lifeops) can map
 * the pair back to its source row in `action.examples` without re-parsing the
 * registry's composite key shape (`<actionName>.example.<index>`).
 */
export type LocalizedActionExampleResolver = (params: {
	actionName: string;
	exampleIndex: number;
}) => LocalizedActionExamplePair | null;

export type RuntimeActionLike = {
	name: string;
	description?: string;
	descriptionCompressed?: string;
	compressedDescription?: string;
	similes?: string[];
	tags?: string[];
	examples?: unknown;
	parameters?: unknown;
	contexts?: unknown;
	subActions?: Array<string | RuntimeActionLike>;
	cacheStable?: boolean;
	cacheScope?: string;
	routingHint?: string;
};

export type ActionCatalogWarningCode =
	| "INVALID_ACTION"
	| "DUPLICATE_ACTION"
	| "DUPLICATE_SUB_ACTION"
	| "MISSING_SUB_ACTION";

export type ActionCatalogWarning = {
	code: ActionCatalogWarningCode;
	actionName?: string;
	parentName?: string;
	subActionName?: string;
	message: string;
};

export type ActionCatalogEntry = {
	name: string;
	normalizedName: string;
	description: string;
	descriptionCompressed?: string;
	compressedDescription?: string;
	similes: string[];
	tags: string[];
	examples?: unknown;
	parameters?: unknown;
	contexts?: unknown;
	cacheStable?: boolean;
	cacheScope?: string;
	/** One-line routing hint for the planner. See Action.routingHint. */
	routingHint?: string;
	keywordKeys: string[];
	keywordText: string;
	keywordSources: ActionSearchKeywordSource[];
	searchText: string;
	source: RuntimeActionLike;
};

export type ActionCatalogChild = ActionCatalogEntry & {
	kind: "child";
	parentName: string;
	parentNormalizedName: string;
};

export type ActionCatalogParent = ActionCatalogEntry & {
	kind: "parent";
	children: ActionCatalogChild[];
	childNames: string[];
	childNormalizedNames: string[];
};

export type ActionCatalog = {
	parents: ActionCatalogParent[];
	parentByName: Map<string, ActionCatalogParent>;
	children: ActionCatalogChild[];
	childByName: Map<string, ActionCatalogChild>;
	warnings: ActionCatalogWarning[];
};

export type BuildActionCatalogOptions = {
	includeReferencedChildrenAsParents?: boolean;
	/**
	 * Optional locale-aware example swapper. When provided, every
	 * `ActionExample[][]` row on a source action is run through this resolver
	 * by `(actionName, exampleIndex)` and replaced with the returned localized
	 * pair if one exists. Rows the resolver does not recognize fall through
	 * to the English original. The resolver is invoked once per pair at
	 * catalog-build time, never at planner-render time.
	 */
	localizedExamples?: LocalizedActionExampleResolver;
};

const EMPTY_TEXT_FIELDS = new Set(["undefined", "null", "[object Object]"]);

export function normalizeActionName(name: string): string {
	return String(name ?? "")
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_+/g, "_")
		.toUpperCase();
}

export function buildActionCatalog(
	actions: RuntimeActionLike[],
	options: BuildActionCatalogOptions = {},
): ActionCatalog {
	const warnings: ActionCatalogWarning[] = [];
	const actionByName = new Map<string, RuntimeActionLike>();
	const referencedChildNames = new Set<string>();

	for (const action of actions ?? []) {
		if (!isRuntimeActionLike(action)) {
			warnings.push({
				code: "INVALID_ACTION",
				message: "Action catalogue entry is missing a valid name.",
			});
			continue;
		}

		const normalizedName = normalizeActionName(action.name);
		if (!normalizedName) {
			warnings.push({
				code: "INVALID_ACTION",
				message: "Action catalogue entry has an empty normalized name.",
			});
			continue;
		}

		if (actionByName.has(normalizedName)) {
			warnings.push({
				code: "DUPLICATE_ACTION",
				actionName: action.name,
				message: `Duplicate action "${action.name}" ignored while building catalogue.`,
			});
			continue;
		}

		actionByName.set(normalizedName, action);
	}

	const childEntriesByParent = new Map<string, ActionCatalogChild[]>();
	const localizedExamples = options.localizedExamples;

	for (const action of actionByName.values()) {
		const parentNormalizedName = normalizeActionName(action.name);
		const children: ActionCatalogChild[] = [];
		const seenChildNames = new Set<string>();

		for (const subAction of action.subActions ?? []) {
			const resolved = resolveSubAction({
				parent: action,
				parentNormalizedName,
				subAction,
				actionByName,
				warnings,
				localizedExamples,
			});

			if (!resolved) {
				continue;
			}

			referencedChildNames.add(resolved.normalizedName);

			if (seenChildNames.has(resolved.normalizedName)) {
				warnings.push({
					code: "DUPLICATE_SUB_ACTION",
					parentName: action.name,
					subActionName: resolved.name,
					message: `Duplicate sub-action "${resolved.name}" ignored under "${action.name}".`,
				});
				continue;
			}

			seenChildNames.add(resolved.normalizedName);
			children.push(resolved);
		}

		childEntriesByParent.set(
			parentNormalizedName,
			children.sort(compareCatalogEntries),
		);
	}

	const parents: ActionCatalogParent[] = [];
	const children: ActionCatalogChild[] = [];

	for (const action of actionByName.values()) {
		const normalizedName = normalizeActionName(action.name);
		const explicitChildren = childEntriesByParent.get(normalizedName) ?? [];
		const isReferencedChild = referencedChildNames.has(normalizedName);
		const shouldIncludeAsParent =
			options.includeReferencedChildrenAsParents ||
			explicitChildren.length > 0 ||
			!isReferencedChild;

		if (!shouldIncludeAsParent) {
			continue;
		}

		const parent = materializeParent(
			action,
			explicitChildren,
			localizedExamples,
		);
		parents.push(parent);
		children.push(...explicitChildren);
	}

	parents.sort(compareCatalogEntries);
	children.sort(compareCatalogEntries);

	const parentByName = new Map<string, ActionCatalogParent>();
	for (const parent of parents) {
		parentByName.set(parent.normalizedName, parent);
	}

	const childByName = new Map<string, ActionCatalogChild>();
	for (const child of children) {
		if (!childByName.has(child.normalizedName)) {
			childByName.set(child.normalizedName, child);
		}
	}

	return {
		parents,
		parentByName,
		children,
		childByName,
		warnings,
	};
}

export function actionEntrySearchText(
	action: RuntimeActionLike,
	children: ActionCatalogEntry[] = [],
): string {
	return compactText([
		action.name,
		action.description,
		action.descriptionCompressed,
		action.compressedDescription,
		...(action.similes ?? []),
		...(action.tags ?? []),
		extractSearchableText(action.examples),
		extractSearchableText(action.parameters),
		...children.flatMap((child) => [
			child.name,
			child.description,
			child.descriptionCompressed,
			child.compressedDescription,
			...child.similes,
			...child.tags,
			extractSearchableText(child.examples),
			extractSearchableText(child.parameters),
		]),
	]);
}

export function actionEntryKeywordText(
	action: RuntimeActionLike,
	children: ActionCatalogEntry[] = [],
): string {
	return compactText([
		...getActionSearchKeywordTerms({
			name: action.name,
			contexts: action.contexts,
		}),
		...children.flatMap((child) => child.keywordText),
	]);
}

function resolveSubAction(params: {
	parent: RuntimeActionLike;
	parentNormalizedName: string;
	subAction: string | RuntimeActionLike;
	actionByName: Map<string, RuntimeActionLike>;
	warnings: ActionCatalogWarning[];
	localizedExamples?: LocalizedActionExampleResolver;
}): ActionCatalogChild | undefined {
	const {
		parent,
		parentNormalizedName,
		subAction,
		actionByName,
		warnings,
		localizedExamples,
	} = params;

	if (typeof subAction === "string") {
		const normalizedSubActionName = normalizeActionName(subAction);
		const source = actionByName.get(normalizedSubActionName);
		if (!source) {
			warnings.push({
				code: "MISSING_SUB_ACTION",
				parentName: parent.name,
				subActionName: subAction,
				message: `Sub-action "${subAction}" referenced by "${parent.name}" was not found.`,
			});
			return undefined;
		}

		return materializeChild(source, parent, localizedExamples);
	}

	if (!isRuntimeActionLike(subAction)) {
		warnings.push({
			code: "INVALID_ACTION",
			parentName: parent.name,
			message: `Sub-action under "${parent.name}" is missing a valid name.`,
		});
		return undefined;
	}

	if (!normalizeActionName(subAction.name)) {
		warnings.push({
			code: "INVALID_ACTION",
			parentName: parent.name,
			message: `Sub-action under "${parent.name}" has an empty normalized name.`,
		});
		return undefined;
	}

	return {
		...materializeEntry(subAction, [], localizedExamples),
		kind: "child",
		parentName: parent.name,
		parentNormalizedName,
	};
}

function materializeParent(
	action: RuntimeActionLike,
	children: ActionCatalogChild[],
	localizedExamples?: LocalizedActionExampleResolver,
): ActionCatalogParent {
	const entry = materializeEntry(action, children, localizedExamples);

	return {
		...entry,
		kind: "parent",
		children,
		childNames: children.map((child) => child.name),
		childNormalizedNames: children.map((child) => child.normalizedName),
	};
}

function materializeChild(
	action: RuntimeActionLike,
	parent: RuntimeActionLike,
	localizedExamples?: LocalizedActionExampleResolver,
): ActionCatalogChild {
	return {
		...materializeEntry(action, [], localizedExamples),
		kind: "child",
		parentName: parent.name,
		parentNormalizedName: normalizeActionName(parent.name),
	};
}

function materializeEntry(
	action: RuntimeActionLike,
	children: ActionCatalogEntry[] = [],
	localizedExamples?: LocalizedActionExampleResolver,
): ActionCatalogEntry {
	const normalizedName = normalizeActionName(action.name);
	const description = String(action.description ?? "").trim();
	const ownKeywordSources = getActionSearchKeywordSources({
		name: action.name,
		contexts: action.contexts,
	});
	const childKeywordSources = children.flatMap((child) => child.keywordSources);
	const keywordSources = dedupeKeywordSources([
		...ownKeywordSources,
		...childKeywordSources,
	]);
	const keywordKeys = keywordSources.map((source) => source.key);
	const localizedExamplesValue = applyLocalizedExamples(
		action,
		localizedExamples,
	);

	return {
		name: action.name,
		normalizedName,
		description,
		descriptionCompressed: normalizeOptionalString(
			action.descriptionCompressed,
		),
		compressedDescription: normalizeOptionalString(
			action.compressedDescription,
		),
		similes: normalizeStringArray(action.similes),
		tags: normalizeStringArray(action.tags),
		examples: localizedExamplesValue,
		parameters: action.parameters,
		contexts: action.contexts,
		cacheStable: action.cacheStable,
		cacheScope: normalizeOptionalString(action.cacheScope),
		routingHint: normalizeOptionalString(action.routingHint),
		keywordKeys,
		keywordText: actionEntryKeywordText(action, children),
		keywordSources,
		searchText: actionEntrySearchText(action, children),
		source: action,
	};
}

/**
 * Apply a {@link LocalizedActionExampleResolver} to an action's `examples`
 * field if (a) a resolver is provided, and (b) the field is the standard
 * `ActionExample[][]` shape (every row is a 2-tuple of objects with
 * `name` + `content`). Any other shape is passed through verbatim — actions
 * that store their examples as JSON literals or non-pair structures keep
 * their original payload.
 *
 * The resolver receives `(actionName, exampleIndex)`. Returning `null` keeps
 * the English original for that index; partial coverage is supported.
 */
function applyLocalizedExamples(
	action: RuntimeActionLike,
	resolver: LocalizedActionExampleResolver | undefined,
): unknown {
	if (!resolver) {
		return action.examples;
	}
	if (!isActionExamplePairArray(action.examples)) {
		return action.examples;
	}

	let mutated = false;
	const next: ActionExample[][] = action.examples.map((pair, exampleIndex) => {
		const localized = resolver({
			actionName: action.name,
			exampleIndex,
		});
		if (!localized) {
			return pair;
		}
		mutated = true;
		return [localized[0], localized[1]];
	});

	return mutated ? next : action.examples;
}

function isActionExamplePairArray(value: unknown): value is ActionExample[][] {
	if (!Array.isArray(value)) {
		return false;
	}
	for (const pair of value) {
		if (!Array.isArray(pair) || pair.length !== 2) {
			return false;
		}
		if (!isActionExample(pair[0]) || !isActionExample(pair[1])) {
			return false;
		}
	}
	return true;
}

function isActionExample(value: unknown): value is ActionExample {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as { name?: unknown; content?: unknown };
	return (
		typeof candidate.name === "string" &&
		typeof candidate.content === "object" &&
		candidate.content !== null
	);
}

function isRuntimeActionLike(action: unknown): action is RuntimeActionLike {
	return (
		typeof action === "object" &&
		action !== null &&
		"name" in action &&
		typeof (action as { name?: unknown }).name === "string"
	);
}

function compareCatalogEntries(
	left: Pick<ActionCatalogEntry, "normalizedName" | "name">,
	right: Pick<ActionCatalogEntry, "normalizedName" | "name">,
): number {
	return (
		left.normalizedName.localeCompare(right.normalizedName) ||
		left.name.localeCompare(right.name)
	);
}

function compactText(values: unknown[]): string {
	return values
		.flatMap((value) => normalizeTextFragments(value))
		.map((value) => value.trim())
		.filter((value) => value && !EMPTY_TEXT_FIELDS.has(value))
		.join("\n");
}

function normalizeStringArray(values: unknown): string[] {
	if (!Array.isArray(values)) {
		return [];
	}

	return values
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter(Boolean);
}

function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const normalized = value.trim();
	return normalized ? normalized : undefined;
}

function normalizeTextFragments(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}

	if (Array.isArray(value)) {
		return value.flatMap((item) => normalizeTextFragments(item));
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return [String(value)];
	}

	if (typeof value === "object" && value !== null) {
		return Object.values(value).flatMap((item) => normalizeTextFragments(item));
	}

	return [];
}

function extractSearchableText(value: unknown): string {
	return compactText(normalizeTextFragments(value));
}

function dedupeKeywordSources(
	sources: readonly ActionSearchKeywordSource[],
): ActionSearchKeywordSource[] {
	const byKey = new Map<string, ActionSearchKeywordSource>();
	for (const source of sources) {
		const existing = byKey.get(source.key);
		byKey.set(source.key, {
			key: source.key,
			terms: [...new Set([...(existing?.terms ?? []), ...source.terms])],
		});
	}
	return [...byKey.values()];
}
