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
	[key: string]: unknown;
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

		const parent = materializeParent(action, explicitChildren);
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
		extractSearchableText(action.contexts),
		...children.flatMap((child) => [
			child.name,
			child.description,
			child.descriptionCompressed,
			child.compressedDescription,
			...child.similes,
			...child.tags,
			extractSearchableText(child.examples),
			extractSearchableText(child.parameters),
			extractSearchableText(child.contexts),
		]),
	]);
}

function resolveSubAction(params: {
	parent: RuntimeActionLike;
	parentNormalizedName: string;
	subAction: string | RuntimeActionLike;
	actionByName: Map<string, RuntimeActionLike>;
	warnings: ActionCatalogWarning[];
}): ActionCatalogChild | undefined {
	const { parent, parentNormalizedName, subAction, actionByName, warnings } =
		params;

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

		return materializeChild(source, parent);
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
		...materializeEntry(subAction),
		kind: "child",
		parentName: parent.name,
		parentNormalizedName,
	};
}

function materializeParent(
	action: RuntimeActionLike,
	children: ActionCatalogChild[],
): ActionCatalogParent {
	const entry = materializeEntry(action, children);

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
): ActionCatalogChild {
	return {
		...materializeEntry(action),
		kind: "child",
		parentName: parent.name,
		parentNormalizedName: normalizeActionName(parent.name),
	};
}

function materializeEntry(
	action: RuntimeActionLike,
	children: ActionCatalogEntry[] = [],
): ActionCatalogEntry {
	const normalizedName = normalizeActionName(action.name);
	const description = String(action.description ?? "").trim();

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
		examples: action.examples,
		parameters: action.parameters,
		contexts: action.contexts,
		cacheStable: action.cacheStable,
		cacheScope: normalizeOptionalString(action.cacheScope),
		searchText: actionEntrySearchText(action, children),
		source: action,
	};
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
