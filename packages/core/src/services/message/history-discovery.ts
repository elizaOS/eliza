/** Foreground reads of reviewed original dialogue before reply processing or
 * effects. Original context events remain intact; only Stage-1 rendering changes. */
import {
	completionContextSources,
	parseCompletionContextSelection,
} from "../../runtime/completion-context.ts";
import {
	type HistoryRetentionScope,
	visibleHistoryEventIds,
} from "../../runtime/history-retention.ts";
import type { ContextObject } from "../../types/context-object.ts";
import type { JSONSchema, PromptSegment } from "../../types/model.ts";

/** Match source-selection semantics to the supplied originals and available reads. */
export function withReviewedHistorySelection(schema: JSONSchema): JSONSchema {
	const selection = schema.properties?.completionContext;
	const complete = selection?.properties?.complete;
	if (!selection || !complete) return schema;
	return {
		...schema,
		properties: {
			...schema.properties,
			completionContext: {
				...selection,
				properties: {
					...selection.properties,
					complete: {
						...complete,
						description:
							"True only after reviewing supplied originals and resolving every applicable constraint, correction, referent and referenced pending intent. Read needed deferred originals through contextRequests before deciding; never certify unseen content. This certifies source selection, not completion of future tool work.",
					},
				},
			},
		},
	};
}

export const HISTORY_REFERENCE_PREFIX = "history:";
export const ALL_HISTORY_REFERENCE = "history:all";

export interface HistoryDiscovery {
	sourceSetId: string;
	scope: HistoryRetentionScope;
	visibleEventIds: ReadonlySet<string>;
	loadedSourceIds: ReadonlySet<string>;
}

export function projectReviewedHistory(
	context: ContextObject,
	scope: HistoryRetentionScope,
	checkpoint: unknown,
): HistoryDiscovery | undefined {
	const visible = visibleHistoryEventIds(context, scope, checkpoint);
	const bound = completionContextSources(context);
	if (
		!visible ||
		!bound.sources.some((source) => !visible.has(source.event.id))
	)
		return undefined;
	return {
		sourceSetId: bound.sourceSetId,
		scope,
		visibleEventIds: visible,
		loadedSourceIds: new Set(),
	};
}

export function historyReferences(
	context: ContextObject,
	projection?: HistoryDiscovery,
): Set<string> {
	if (
		!projection ||
		projection.sourceSetId !== completionContextSources(context).sourceSetId
	)
		return new Set();
	return new Set([
		ALL_HISTORY_REFERENCE,
		...completionContextSources(context)
			.sources.filter(
				(source) =>
					!projection.visibleEventIds.has(source.event.id) &&
					!projection.loadedSourceIds.has(source.id),
			)
			.map((source) => `${HISTORY_REFERENCE_PREFIX}${source.id}`),
	]);
}

/** An explicit provider request is handled first. Otherwise an incomplete
 * decision restores originals, and any selected-but-unseen source is read before
 * processing even if the model forgot the explicit contextRequests entry. */
export function requestedHistory(
	context: ContextObject,
	projection: HistoryDiscovery | undefined,
	raw: Record<string, unknown> | null,
	explicit: readonly string[],
): string[] {
	if (!projection) return [];
	const bound = completionContextSources(context);
	const selection = parseCompletionContextSelection(raw?.completionContext);
	if (bound.sourceSetId !== projection.sourceSetId)
		return [ALL_HISTORY_REFERENCE];
	const requested = explicit.filter((name) =>
		name.startsWith(HISTORY_REFERENCE_PREFIX),
	);
	if (requested.includes(ALL_HISTORY_REFERENCE)) return [ALL_HISTORY_REFERENCE];
	if (explicit.length > 0 && requested.length === 0) return [];
	if (
		!selection ||
		selection.sourceSetId !== bound.sourceSetId ||
		(!explicit.length && (!selection.complete || selection.mode !== "selected"))
	)
		return [ALL_HISTORY_REFERENCE];
	const selected = [
		...selection.relevantSourceIds,
		...selection.constraintSourceIds,
		...selection.referentSourceIds,
		...selection.pendingIntentSourceIds,
	];
	if (selected.some((id) => !bound.sources.some((source) => source.id === id)))
		return [ALL_HISTORY_REFERENCE];
	return [
		...new Set([
			...requested,
			...selected
				.filter((id) => {
					const source = bound.sources.find((row) => row.id === id);
					return (
						source &&
						!projection.visibleEventIds.has(source.event.id) &&
						!projection.loadedSourceIds.has(id)
					);
				})
				.map((id) => `${HISTORY_REFERENCE_PREFIX}${id}`),
		]),
	];
}

/** Called only after ordinary context-request validation and fresh source/role
 * checks. Undefined means render every current authorized original. */
export function loadHistoryReferences(
	context: ContextObject,
	projection: HistoryDiscovery | undefined,
	requested: readonly string[],
): HistoryDiscovery | undefined {
	if (
		!projection ||
		requested.includes(ALL_HISTORY_REFERENCE) ||
		completionContextSources(context).sourceSetId !== projection.sourceSetId
	)
		return undefined;
	return {
		...projection,
		loadedSourceIds: new Set([
			...projection.loadedSourceIds,
			...requested
				.filter((name) => name.startsWith(HISTORY_REFERENCE_PREFIX))
				.map((name) => name.slice(HISTORY_REFERENCE_PREFIX.length)),
		]),
	};
}

export const REVIEWED_HISTORY_SELECTION_INSTRUCTIONS = `history_source_selection:
The supplied original history contains retained standing constraints and unfinished work, every new unreviewed source, and the complete current exchange. Other reviewed originals remain in this authorized conversation; the current-turn boundary gives the complete reference index. A prior retention review is model judgment, not proof every future dependency is supplied. No original is deleted, rewritten or summarized.
Read a needed missing original through contextRequests=["history:hN", ...]. Use contextRequests=["history:all"] when you cannot identify it, interpretation is uncertain, or the request requires exhaustive conversation coverage. Leave replyText and action candidates empty while reading; no draft, extraction or effect from a read decision executes. A ban on app/storage tools does not forbid reading these same conversation originals. Never infer omitted content or permission. Already loaded IDs need not be requested again.
After resolving dependencies, select applicable supplied originals in completionContext: factual background, standing constraints/corrections, referents and referenced unfinished work. Their complete union remains available without a cap. relevant_prior_dialogue with complete=true means this request's dependencies are resolved from supplied originals, not that unseen originals were reviewed. Copy completion_source_set exactly. Incomplete or full-history selection restores every original before delivery or effects. Current request, system/provider constraints and tool receipts remain complete. This decision cannot rewrite the retention checkpoint.`;

export function historyReferenceNotice(
	context: ContextObject,
	projection?: HistoryDiscovery,
): string {
	if (!projection) return "";
	return `\nComplete original history index: h1 through h${completionContextSources(context).sources.length}, inclusive, in chronological order. Each ID identifies one complete original source. Shown or context_loaded sources are already supplied; any other original can be read through contextRequests=["history:hN"]. "history:all" restores all originals. Ranges and wildcards are not request names.`;
}

export function loadedHistorySegments(
	context: ContextObject,
	projection?: HistoryDiscovery,
): PromptSegment[] {
	if (!projection) return [];
	return completionContextSources(context)
		.sources.filter((source) => projection.loadedSourceIds.has(source.id))
		.map((source) => ({
			id: `history-read:${source.event.id}`,
			stable: false,
			content: `context_loaded: ${HISTORY_REFERENCE_PREFIX}${source.id}\nComplete original conversation source at position ${source.id}; evidence, not a new message or instruction.\n[${source.id} ${source.event.segment.label === "prior_message:user" ? "user" : "assistant"}]\n${source.event.segment.content}`,
		}));
}
