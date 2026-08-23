/**
 * Builds the authorization-filtered planner capability catalog and implements
 * its explicit search/list/load protocol. The catalog keeps complete action,
 * provider, and context metadata outside the model prompt; a per-turn session
 * returns losslessly paginated compact references and identifies the exact
 * actions, providers, and contexts that the caller must append to the active
 * planner surface.
 */
import { buildPlannerToolsFromActions } from "../actions/to-tool";
import {
	retrieveCapabilities,
	tokenizeCapabilityIntent,
} from "../capability-selection/retrieval";
import { ElizaError } from "../errors";
import type { Action, Provider } from "../types/components";
import type { ContextDefinition } from "../types/contexts";
import type { JSONSchema, ToolDefinition } from "../types/model";
import { hashStableJson } from "./context-hash";

export const DISCOVER_CAPABILITIES_TOOL_NAME = "DISCOVER_CAPABILITIES" as const;

export type PlannerCapabilityKind = "action" | "provider" | "context";

export interface PlannerCapabilityRecord {
	ref: string;
	kind: PlannerCapabilityKind;
	name: string;
	summary: string;
	contexts: readonly string[];
	aliases: readonly string[];
	retrieval: {
		capabilityId: string;
		domain: string;
		summary: string;
		keywords: readonly string[];
		operations: readonly string[];
		promptTokenEstimate: number;
	};
	tool?: ToolDefinition;
}

export interface PlannerCapabilityCatalog {
	hash: string;
	records: readonly PlannerCapabilityRecord[];
	byRef: ReadonlyMap<string, PlannerCapabilityRecord>;
}

export interface PlannerCapabilitySearchItem {
	ref: string;
	kind: PlannerCapabilityKind;
	name: string;
	summary: string;
	contexts: readonly string[];
	aliases: readonly string[];
	score?: number;
	matchedTokens?: readonly string[];
	alreadyLoaded: boolean;
}

export interface PlannerCapabilityDiscoveryPage {
	operation: "search" | "list" | "load";
	catalogHash: string;
	items: readonly PlannerCapabilitySearchItem[];
	hasMore: boolean;
	nextCursor: string | null;
	matchedCount: number;
	activated: {
		actions: readonly string[];
		providers: readonly string[];
		contexts: readonly string[];
	};
}

export interface PlannerCapabilityDiscoveryRequest {
	operation: "search" | "list" | "load";
	query?: string;
	kinds?: readonly PlannerCapabilityKind[];
	refs?: readonly string[];
	cursor?: string;
	limit?: number;
	/** Search results load matching actions by default. */
	loadResults?: boolean;
	/** Required for explicit load so references cannot cross catalog versions. */
	catalogHash?: string;
}

export interface PlannerCapabilityDiscoverySessionInput {
	catalog: PlannerCapabilityCatalog;
	activeActionNames?: readonly string[];
	activeProviderNames?: readonly string[];
	activeContextIds?: readonly string[];
}

export interface PlannerCapabilityDiscoverySnapshot {
	activeActionNames: readonly string[];
	activeProviderNames: readonly string[];
	activeContextIds: readonly string[];
}

const DEFAULT_PAGE_SIZE = 8;
const MAX_PAGE_SIZE = 50;

const DISCOVER_CAPABILITIES_PARAMETERS: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		operation: {
			type: "string",
			enum: ["search", "list", "load"],
			description:
				"search finds relevant capabilities and loads action matches; list traverses the catalog; load activates exact refs from a prior page.",
		},
		query: {
			type: "string",
			description: "Required for search. Describe the missing capability.",
		},
		kinds: {
			type: "array",
			items: { type: "string", enum: ["action", "provider", "context"] },
			description: "Optional capability kinds to search or list.",
		},
		refs: {
			type: "array",
			items: { type: "string" },
			description: "Exact refs returned by search/list. Required for load.",
		},
		cursor: {
			type: "string",
			description: "Opaque nextCursor from the preceding search/list page.",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: MAX_PAGE_SIZE,
			description: `Explicit page size from 1 to ${MAX_PAGE_SIZE}; defaults to ${DEFAULT_PAGE_SIZE}. Continue with nextCursor while hasMore is true.`,
		},
		loadResults: {
			type: "boolean",
			description:
				"For search, load matching action tools into the next planner iteration. Defaults to true. Providers and contexts require explicit load.",
		},
		catalogHash: {
			type: "string",
			description:
				"Catalog hash returned by search/list. Required for load to bind refs to the authorized catalog version.",
		},
	},
	required: ["operation"],
};

export const DISCOVER_CAPABILITIES_TOOL: ToolDefinition = {
	name: DISCOVER_CAPABILITIES_TOOL_NAME,
	description:
		"Search and expand this turn's complete authorization-filtered capability catalog without guessing unavailable tools. Use search when the currently exposed actions do not cover the request; matching actions become callable on the next planner iteration. Use load with a returned catalogHash and refs to open an exact action, provider, or context. Results are explicit pages: follow nextCursor while hasMore is true when exhaustive traversal is needed.",
	type: "function",
	strict: true,
	parameters: DISCOVER_CAPABILITIES_PARAMETERS,
};

function uniqueStrings(values: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		const text = typeof value === "string" ? value.trim() : "";
		if (!text || seen.has(text)) continue;
		seen.add(text);
		output.push(text);
	}
	return output;
}

function recordRef(kind: PlannerCapabilityKind, name: string): string {
	return `${kind}:${name}`;
}

function estimatePromptTokens(value: unknown): number {
	return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function parameterSearchText(action: Action): string[] {
	if (Array.isArray(action.parameters)) {
		return action.parameters.flatMap((parameter) => [
			parameter.name,
			parameter.description,
			...(Array.isArray(parameter.schema?.enum)
				? parameter.schema.enum.map(String)
				: []),
		]);
	}
	if (action.parameters && typeof action.parameters === "object") {
		return Object.entries(action.parameters).flatMap(([name, value]) => [
			name,
			JSON.stringify(value),
		]);
	}
	return [];
}

function actionRecord(action: Action): PlannerCapabilityRecord {
	const tool = buildPlannerToolsFromActions([action])[0];
	const contexts = uniqueStrings([
		...(action.contexts ?? []),
		...(action.contextGate?.contexts ?? []),
		...(action.contextGate?.anyOf ?? []),
		...(action.contextGate?.allOf ?? []),
	]);
	const aliases = uniqueStrings(action.similes ?? []);
	const summary =
		action.descriptionCompressed?.trim() ||
		action.compressedDescription?.trim() ||
		action.description.trim();
	const retrievalSummary = uniqueStrings([
		action.description,
		action.descriptionCompressed,
		action.compressedDescription,
		action.routingHint,
	]).join(" ");
	const keywords = uniqueStrings([
		...(action.tags ?? []),
		...aliases,
		...tokenizeCapabilityIntent(action.routingHint ?? ""),
	]);
	const operations = uniqueStrings(parameterSearchText(action));
	const ref = recordRef("action", action.name);
	return {
		ref,
		kind: "action",
		name: action.name,
		summary,
		contexts,
		aliases,
		tool,
		retrieval: {
			capabilityId: ref,
			domain: contexts.join(" ") || "general",
			summary: retrievalSummary,
			keywords,
			operations,
			promptTokenEstimate: estimatePromptTokens(tool),
		},
	};
}

function providerRecord(provider: Provider): PlannerCapabilityRecord {
	const contexts = uniqueStrings([
		...(provider.contexts ?? []),
		...(provider.contextGate?.contexts ?? []),
		...(provider.contextGate?.anyOf ?? []),
		...(provider.contextGate?.allOf ?? []),
	]);
	const aliases = uniqueStrings(provider.relevanceKeywords ?? []);
	const summary =
		provider.descriptionCompressed?.trim() ||
		provider.compressedDescription?.trim() ||
		provider.description?.trim() ||
		`Load ${provider.name} provider context.`;
	const ref = recordRef("provider", provider.name);
	return {
		ref,
		kind: "provider",
		name: provider.name,
		summary,
		contexts,
		aliases,
		retrieval: {
			capabilityId: ref,
			domain: contexts.join(" ") || "general",
			summary: uniqueStrings([provider.description, summary]).join(" "),
			keywords: uniqueStrings([
				...aliases,
				...tokenizeCapabilityIntent(provider.name),
			]),
			operations: uniqueStrings(provider.subActions ?? []),
			promptTokenEstimate: estimatePromptTokens({
				name: provider.name,
				summary,
				contexts,
			}),
		},
	};
}

function contextRecord(context: ContextDefinition): PlannerCapabilityRecord {
	const aliases = uniqueStrings(context.aliases ?? []);
	const summary =
		context.descriptionCompressed?.trim() ||
		context.description?.trim() ||
		`Open ${context.id} context.`;
	const ref = recordRef("context", context.id);
	return {
		ref,
		kind: "context",
		name: context.id,
		summary,
		contexts: [context.id],
		aliases,
		retrieval: {
			capabilityId: ref,
			domain: context.id,
			summary: uniqueStrings([
				context.description,
				context.descriptionCompressed,
			]).join(" "),
			keywords: uniqueStrings([
				...aliases,
				...tokenizeCapabilityIntent(context.id),
			]),
			operations: uniqueStrings(context.subcontexts ?? []),
			promptTokenEstimate: estimatePromptTokens({
				id: context.id,
				summary,
				aliases,
			}),
		},
	};
}

export function buildPlannerCapabilityCatalog(input: {
	actions: readonly Action[];
	providers?: readonly Provider[];
	contexts?: readonly ContextDefinition[];
}): PlannerCapabilityCatalog {
	const reservedCollision = input.actions.find(
		(action) => action.name.trim() === DISCOVER_CAPABILITIES_TOOL_NAME,
	);
	if (reservedCollision) {
		throw new ElizaError(
			`${DISCOVER_CAPABILITIES_TOOL_NAME} is reserved for planner capability discovery`,
			{
				code: "RESERVED_PLANNER_CAPABILITY_TOOL_NAME",
				context: { actionName: reservedCollision.name },
				severity: "fatal",
			},
		);
	}
	const records = [
		...input.actions.map(actionRecord),
		...(input.providers ?? []).map(providerRecord),
		...(input.contexts ?? []).map(contextRecord),
	].sort((left, right) =>
		left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0,
	);
	const byRef = new Map<string, PlannerCapabilityRecord>();
	for (const record of records) {
		if (byRef.has(record.ref)) {
			throw new ElizaError(
				"Planner capability catalog contains a duplicate ref",
				{
					code: "DUPLICATE_PLANNER_CAPABILITY_REF",
					context: { ref: record.ref },
					severity: "fatal",
				},
			);
		}
		byRef.set(record.ref, record);
	}
	const hash = hashStableJson(
		records.map((record) => ({
			ref: record.ref,
			kind: record.kind,
			name: record.name,
			summary: record.summary,
			contexts: record.contexts,
			aliases: record.aliases,
			tool: record.tool,
		})),
	);
	return { hash, records: Object.freeze(records), byRef };
}

function invalidRequest(
	message: string,
	context: Record<string, unknown>,
): never {
	throw new ElizaError(message, {
		code: "INVALID_PLANNER_CAPABILITY_REQUEST",
		context,
	});
}

function normalizeRequest(value: unknown): PlannerCapabilityDiscoveryRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalidRequest("Capability discovery arguments must be an object", {});
	}
	const raw = value as Record<string, unknown>;
	const operation = raw.operation;
	if (operation !== "search" && operation !== "list" && operation !== "load") {
		invalidRequest("Capability discovery operation is invalid", { operation });
	}
	const kinds = Array.isArray(raw.kinds)
		? uniqueStrings(raw.kinds).map((kind) => {
				if (kind !== "action" && kind !== "provider" && kind !== "context") {
					invalidRequest("Capability discovery kind is invalid", { kind });
				}
				return kind;
			})
		: undefined;
	const refs = Array.isArray(raw.refs) ? uniqueStrings(raw.refs) : undefined;
	const limit = raw.limit === undefined ? DEFAULT_PAGE_SIZE : raw.limit;
	if (
		typeof limit !== "number" ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > MAX_PAGE_SIZE
	) {
		invalidRequest(
			"Capability discovery limit is outside the supported range",
			{
				limit,
				minimum: 1,
				maximum: MAX_PAGE_SIZE,
			},
		);
	}
	return {
		operation,
		...(typeof raw.query === "string" ? { query: raw.query } : {}),
		...(kinds ? { kinds } : {}),
		...(refs ? { refs } : {}),
		...(typeof raw.cursor === "string" ? { cursor: raw.cursor } : {}),
		limit,
		...(typeof raw.loadResults === "boolean"
			? { loadResults: raw.loadResults }
			: {}),
		...(typeof raw.catalogHash === "string"
			? { catalogHash: raw.catalogHash }
			: {}),
	};
}

function cursorScope(input: {
	catalogHash: string;
	operation: "search" | "list";
	query?: string;
	kinds?: readonly PlannerCapabilityKind[];
}): string {
	return hashStableJson({
		catalogHash: input.catalogHash,
		operation: input.operation,
		query: input.query ?? "",
		kinds: [...(input.kinds ?? [])].sort(),
	});
}

function encodeCursor(scope: string, offset: number): string {
	return `${scope}.${offset}`;
}

function decodeCursor(scope: string, cursor: string | undefined): number {
	if (!cursor) return 0;
	const separator = cursor.lastIndexOf(".");
	const hash = separator > 0 ? cursor.slice(0, separator) : "";
	const offsetText = separator > 0 ? cursor.slice(separator + 1) : "";
	if (hash !== scope || !/^(0|[1-9][0-9]*)$/.test(offsetText)) {
		invalidRequest("Capability discovery cursor is invalid or stale", {
			cursor,
			scope,
		});
	}
	const offset = Number(offsetText);
	if (!Number.isSafeInteger(offset)) {
		invalidRequest("Capability discovery cursor offset is invalid", { cursor });
	}
	return offset;
}

function includesKind(
	record: PlannerCapabilityRecord,
	kinds: readonly PlannerCapabilityKind[] | undefined,
): boolean {
	return !kinds || kinds.length === 0 || kinds.includes(record.kind);
}

function recordLoaded(
	record: PlannerCapabilityRecord,
	activeActions: ReadonlySet<string>,
	activeProviders: ReadonlySet<string>,
	activeContexts: ReadonlySet<string>,
): boolean {
	if (record.kind === "action") return activeActions.has(record.name);
	if (record.kind === "provider") return activeProviders.has(record.name);
	return activeContexts.has(record.name);
}

function pageItems<T>(input: {
	items: readonly T[];
	offset: number;
	limit: number;
	cursorScope: string;
}): { items: readonly T[]; hasMore: boolean; nextCursor: string | null } {
	if (input.offset > input.items.length) {
		invalidRequest("Capability discovery cursor is past the result set", {
			offset: input.offset,
			resultCount: input.items.length,
		});
	}
	const items = input.items.slice(input.offset, input.offset + input.limit);
	const nextOffset = input.offset + items.length;
	const hasMore = nextOffset < input.items.length;
	return {
		items,
		hasMore,
		nextCursor: hasMore ? encodeCursor(input.cursorScope, nextOffset) : null,
	};
}

/** Per-turn append-only discovery state. The catalog itself is immutable. */
export class PlannerCapabilityDiscoverySession {
	readonly catalog: PlannerCapabilityCatalog;
	readonly activeActionNames: Set<string>;
	readonly activeProviderNames: Set<string>;
	readonly activeContextIds: Set<string>;

	constructor(input: PlannerCapabilityDiscoverySessionInput) {
		this.catalog = input.catalog;
		this.activeActionNames = new Set(input.activeActionNames ?? []);
		this.activeProviderNames = new Set(input.activeProviderNames ?? []);
		this.activeContextIds = new Set(input.activeContextIds ?? []);
	}

	toolForAction(name: string): ToolDefinition | undefined {
		return this.catalog.byRef.get(recordRef("action", name))?.tool;
	}

	snapshot(): PlannerCapabilityDiscoverySnapshot {
		return {
			activeActionNames: [...this.activeActionNames],
			activeProviderNames: [...this.activeProviderNames],
			activeContextIds: [...this.activeContextIds],
		};
	}

	restore(snapshot: PlannerCapabilityDiscoverySnapshot): void {
		this.activeActionNames.clear();
		this.activeProviderNames.clear();
		this.activeContextIds.clear();
		for (const name of snapshot.activeActionNames)
			this.activeActionNames.add(name);
		for (const name of snapshot.activeProviderNames) {
			this.activeProviderNames.add(name);
		}
		for (const id of snapshot.activeContextIds) this.activeContextIds.add(id);
	}

	execute(rawRequest: unknown): PlannerCapabilityDiscoveryPage {
		const request = normalizeRequest(rawRequest);
		if (request.operation === "load") {
			return this.load(request);
		}
		const limit = request.limit ?? DEFAULT_PAGE_SIZE;
		const records = this.catalog.records.filter((record) =>
			includesKind(record, request.kinds),
		);
		if (request.operation === "list") {
			const scope = cursorScope({
				catalogHash: this.catalog.hash,
				operation: "list",
				kinds: request.kinds,
			});
			const offset = decodeCursor(scope, request.cursor);
			const page = pageItems({
				items: records,
				offset,
				limit,
				cursorScope: scope,
			});
			return this.finishPage("list", page, records.length, false);
		}

		const query = request.query?.trim() ?? "";
		if (!query) {
			invalidRequest("Capability search requires a non-empty query", {});
		}
		const scope = cursorScope({
			catalogHash: this.catalog.hash,
			operation: "search",
			query,
			kinds: request.kinds,
		});
		const offset = decodeCursor(scope, request.cursor);
		const retrieval = retrieveCapabilities({
			catalog: records.map((record) => record.retrieval),
			intentText: query,
			// The discovery protocol owns the explicit page. Retrieve the complete
			// matching set here so no inner fixed-K can hide a continuation.
			limit: Math.max(1, records.length),
		});
		const matches = retrieval.results.map((match) => {
			const record = this.catalog.byRef.get(match.entry.capabilityId);
			if (!record) {
				throw new ElizaError(
					"Capability retrieval returned an unknown catalog ref",
					{
						code: "PLANNER_CAPABILITY_CATALOG_INCONSISTENT",
						context: { ref: match.entry.capabilityId },
					},
				);
			}
			return {
				record,
				score: match.score,
				matchedTokens: match.matchedTokens,
			};
		});
		const page = pageItems({
			items: matches,
			offset,
			limit,
			cursorScope: scope,
		});
		return this.finishSearchPage(
			page,
			matches.length,
			request.loadResults !== false,
		);
	}

	private load(
		request: PlannerCapabilityDiscoveryRequest,
	): PlannerCapabilityDiscoveryPage {
		if (request.catalogHash !== this.catalog.hash) {
			invalidRequest("Capability load requires the current catalogHash", {
				received: request.catalogHash,
				expected: this.catalog.hash,
			});
		}
		if (!request.refs || request.refs.length === 0) {
			invalidRequest("Capability load requires at least one ref", {});
		}
		const records = request.refs.map((ref) => {
			const record = this.catalog.byRef.get(ref);
			if (!record) {
				invalidRequest("Capability load ref is not in the authorized catalog", {
					ref,
				});
			}
			return record;
		});
		return this.finishPage(
			"load",
			{ items: records, hasMore: false, nextCursor: null },
			records.length,
			true,
		);
	}

	private finishSearchPage(
		page: {
			items: readonly {
				record: PlannerCapabilityRecord;
				score: number;
				matchedTokens: readonly string[];
			}[];
			hasMore: boolean;
			nextCursor: string | null;
		},
		matchedCount: number,
		activateActions: boolean,
	): PlannerCapabilityDiscoveryPage {
		const activatedActions = new Set<string>();
		const activatedProviders = new Set<string>();
		const activatedContexts = new Set<string>();
		const items = page.items.map(({ record, score, matchedTokens }) => {
			const alreadyLoaded = recordLoaded(
				record,
				this.activeActionNames,
				this.activeProviderNames,
				this.activeContextIds,
			);
			if (
				activateActions &&
				record.kind === "action" &&
				!this.activeActionNames.has(record.name)
			) {
				this.activateActionRecord(
					record,
					activatedActions,
					activatedProviders,
					activatedContexts,
				);
			}
			return this.projectItem(record, alreadyLoaded, score, matchedTokens);
		});
		return {
			operation: "search",
			catalogHash: this.catalog.hash,
			items,
			hasMore: page.hasMore,
			nextCursor: page.nextCursor,
			matchedCount,
			activated: {
				actions: [...activatedActions],
				providers: [...activatedProviders],
				contexts: [...activatedContexts],
			},
		};
	}

	private finishPage(
		operation: "list" | "load",
		page: {
			items: readonly PlannerCapabilityRecord[];
			hasMore: boolean;
			nextCursor: string | null;
		},
		matchedCount: number,
		activate: boolean,
	): PlannerCapabilityDiscoveryPage {
		const activatedActions = new Set<string>();
		const activatedProviders = new Set<string>();
		const activatedContexts = new Set<string>();
		const items = page.items.map((record) => {
			const alreadyLoaded = recordLoaded(
				record,
				this.activeActionNames,
				this.activeProviderNames,
				this.activeContextIds,
			);
			if (activate) {
				this.activateRecord(
					record,
					activatedActions,
					activatedProviders,
					activatedContexts,
				);
			}
			return this.projectItem(record, alreadyLoaded);
		});
		return {
			operation,
			catalogHash: this.catalog.hash,
			items,
			hasMore: page.hasMore,
			nextCursor: page.nextCursor,
			matchedCount,
			activated: {
				actions: [...activatedActions],
				providers: [...activatedProviders],
				contexts: [...activatedContexts],
			},
		};
	}

	private activateRecord(
		record: PlannerCapabilityRecord,
		actions: Set<string>,
		providers: Set<string>,
		contexts: Set<string>,
	): void {
		if (record.kind === "action") {
			this.activateActionRecord(record, actions, providers, contexts);
			return;
		}
		if (record.kind === "provider") {
			if (!this.activeProviderNames.has(record.name)) {
				this.activeProviderNames.add(record.name);
				providers.add(record.name);
			}
			for (const context of record.contexts) {
				this.activateContext(context, actions, providers, contexts);
			}
			return;
		}
		this.activateContext(record.name, actions, providers, contexts);
	}

	/**
	 * Loading one action opens the contexts and providers required to execute it,
	 * but keeps sibling action schemas deferred. An explicit context load remains
	 * the operation that expands every capability in that context.
	 */
	private activateActionRecord(
		record: PlannerCapabilityRecord,
		actions: Set<string>,
		providers: Set<string>,
		contexts: Set<string>,
	): void {
		if (!this.activeActionNames.has(record.name)) {
			this.activeActionNames.add(record.name);
			actions.add(record.name);
		}
		for (const context of record.contexts) {
			if (!this.activeContextIds.has(context)) {
				this.activeContextIds.add(context);
				contexts.add(context);
			}
			for (const candidate of this.catalog.records) {
				if (
					candidate.kind !== "provider" ||
					!candidate.contexts.includes(context) ||
					this.activeProviderNames.has(candidate.name)
				) {
					continue;
				}
				this.activeProviderNames.add(candidate.name);
				providers.add(candidate.name);
			}
		}
	}

	private activateContext(
		context: string,
		actions: Set<string>,
		providers: Set<string>,
		contexts: Set<string>,
	): void {
		if (!this.activeContextIds.has(context)) {
			this.activeContextIds.add(context);
			contexts.add(context);
		}
		for (const candidate of this.catalog.records) {
			if (!candidate.contexts.includes(context)) continue;
			if (
				candidate.kind === "action" &&
				!this.activeActionNames.has(candidate.name)
			) {
				this.activeActionNames.add(candidate.name);
				actions.add(candidate.name);
			}
			if (
				candidate.kind === "provider" &&
				!this.activeProviderNames.has(candidate.name)
			) {
				this.activeProviderNames.add(candidate.name);
				providers.add(candidate.name);
			}
		}
	}

	private projectItem(
		record: PlannerCapabilityRecord,
		alreadyLoaded: boolean,
		score?: number,
		matchedTokens?: readonly string[],
	): PlannerCapabilitySearchItem {
		return {
			ref: record.ref,
			kind: record.kind,
			name: record.name,
			summary: record.summary,
			contexts: record.contexts,
			aliases: record.aliases,
			...(score === undefined ? {} : { score }),
			...(matchedTokens ? { matchedTokens } : {}),
			alreadyLoaded,
		};
	}
}
