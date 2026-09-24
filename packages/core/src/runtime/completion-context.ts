/**
 * Binds Stage-1 relevance selections to exact prior dialogue sources for
 * the planner and completion evaluator. Current requests, standing provider constraints,
 * instructions, runtime feedback and tool evidence are never selectable away.
 * Absent, malformed or stale selections preserve the complete original context.
 */
import type { CompletionContextSelection } from "../types/components";
import type {
	ContextEvent,
	ContextObject,
	ContextSegmentEvent,
} from "../types/context-object";
import type { JSONSchema } from "../types/model";
import { hashStableJson } from "./context-hash";

const SOURCE_ID_PATTERN = /^h[1-9]\d*$/;

/** One stable policy for source selection; the dynamic tail supplies only its binding. */
export const COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS = `history_source_selection:
Review every [hN] original for the current request. Select needed facts, applicable standing constraints and corrections, referents, and explicitly continued unfinished work in completionContext. Assign each ID once to its most specific category; the runtime retains their complete union without a cap.
Keep old applicable constraints, but scope completed-task restrictions to that task unless made standing or continued now. Unrelated completed tasks, greetings and repeated navigation are not pending work. Include original corrections and their referents, and referenced assistant proposals, IDs and receipts. Quote or attribute only the speaker's original; identify recaps as recaps.
Use relevant_prior_dialogue with complete=true only after resolving dependencies; a reviewed empty selection is valid. Use all_prior_dialogue with complete=false for unresolved dependencies, exhaustive conversation coverage/counts, or no source set. Live-record reads/counts are tool work, not exhaustive dialogue recall; long history alone does not require full selection.
Use the sourceSetId prescribed by the native schema, otherwise copy completion_source_set exactly. This review certifies relevance, never tool completion. Current request, system/provider constraints and tool evidence stay complete; future receipts append automatically and do not make this review incomplete.`;

/** Shared static and registered Stage-1 wire schema. */
export const COMPLETION_CONTEXT_SCHEMA: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		mode: {
			type: "string",
			enum: [
				"relevant_prior_dialogue",
				"all_prior_dialogue",
				"selected",
				"full",
			],
			description:
				"relevant_prior_dialogue is the completed relevance review, including a reviewed empty selection. all_prior_dialogue is for unresolved dialogue dependencies, exhaustive conversation coverage/counting, or no source set. This selects prior messages, never live app records or tool results. selected/full are legacy aliases.",
		},
		sourceSetId: {
			type: "string",
			pattern: "^(?:[0-9a-f]{64})?$",
			description:
				"Copy the entire 64-character completion_source_set value exactly. Never abbreviate or generate it. Use an empty string only when no source set is supplied.",
		},
		complete: {
			type: "boolean",
			description:
				"True only after reviewing all labeled prior user and assistant sources and including every applicable constraint, correction, referent and referenced pending intent. It certifies this source selection, not completion of future tool work.",
		},
		relevantSourceIds: {
			type: "array",
			items: { type: "string", pattern: SOURCE_ID_PATTERN.source },
		},
		constraintSourceIds: {
			type: "array",
			items: { type: "string", pattern: SOURCE_ID_PATTERN.source },
		},
		referentSourceIds: {
			type: "array",
			items: { type: "string", pattern: SOURCE_ID_PATTERN.source },
		},
		pendingIntentSourceIds: {
			type: "array",
			items: { type: "string", pattern: SOURCE_ID_PATTERN.source },
		},
	},
	required: [
		"mode",
		"sourceSetId",
		"complete",
		"relevantSourceIds",
		"constraintSourceIds",
		"referentSourceIds",
		"pendingIntentSourceIds",
	],
};

/** A labeled history always supplies its source-set identity. Keep the schema
 * static across such turns, but do not offer an empty-ID escape hatch that
 * silently forces both later stages back to full history. Empty-history and
 * custom callers retain the general schema. An explicit identity-repair call
 * alone binds the schema to the required value; ordinary turns keep cacheable
 * schemas. This never substitutes a model ID or relaxes source validation. */
export function withRequiredCompletionSourceIdentity(
	schema: JSONSchema,
	context: ContextObject,
	exactRepair = false,
): JSONSchema {
	const completion = schema.properties?.completionContext;
	const identity = completion?.properties?.sourceSetId;
	if (
		!completion ||
		identity?.type !== "string" ||
		collectCompletionContextSources(context).length === 0
	)
		return schema;
	return {
		...schema,
		properties: {
			...schema.properties,
			completionContext: {
				...completion,
				properties: {
					...completion.properties,
					sourceSetId: {
						...identity,
						pattern: "^[0-9a-f]{64}$",
						...(exactRepair
							? { enum: [completionContextSources(context).sourceSetId] }
							: {}),
					},
				},
			},
		},
	};
}

const SOURCE_LIST_FIELDS = [
	"relevantSourceIds",
	"constraintSourceIds",
	"referentSourceIds",
	"pendingIntentSourceIds",
] as const;
const SELECTION_FIELDS = new Set<string>([
	"mode",
	"sourceSetId",
	"complete",
	...SOURCE_LIST_FIELDS,
]);

/** Strict selector parsing; invalid optional hints mean full context. */
export function parseCompletionContextSelection(
	value: unknown,
): CompletionContextSelection | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	// Keep the stored/runtime contract and legacy model responses unchanged.
	const mode =
		record.mode === "relevant_prior_dialogue"
			? "selected"
			: record.mode === "all_prior_dialogue"
				? "full"
				: record.mode;
	if (
		Object.keys(record).some((key) => !SELECTION_FIELDS.has(key)) ||
		(mode !== "full" && mode !== "selected") ||
		typeof record.sourceSetId !== "string" ||
		typeof record.complete !== "boolean"
	)
		return undefined;
	for (const key of SOURCE_LIST_FIELDS) {
		const ids = record[key];
		if (
			!Array.isArray(ids) ||
			ids.some((id) => typeof id !== "string" || !SOURCE_ID_PATTERN.test(id)) ||
			new Set(ids).size !== ids.length
		)
			return undefined;
	}
	return {
		mode,
		sourceSetId: record.sourceSetId,
		complete: record.complete,
		relevantSourceIds: [...(record.relevantSourceIds as string[])],
		constraintSourceIds: [...(record.constraintSourceIds as string[])],
		referentSourceIds: [...(record.referentSourceIds as string[])],
		pendingIntentSourceIds: [...(record.pendingIntentSourceIds as string[])],
	};
}

/** Collect complete, unambiguous sources in order. Callers needing only entries
 * need not compute a turn-bound hash; selection still uses completionContextSources. */
export function collectCompletionContextSources(
	context: ContextObject,
): Array<{ id: string; event: ContextSegmentEvent }> {
	const sources: Array<{ id: string; event: ContextSegmentEvent }> = [];
	for (const event of context.events ?? []) {
		if (
			event.type !== "segment" ||
			event.source !== "prior-dialogue" ||
			!("segment" in event)
		)
			continue;
		const segment = event.segment;
		if (
			!segment ||
			typeof segment !== "object" ||
			Array.isArray(segment) ||
			!("label" in segment) ||
			(segment.label !== "prior_message:user" &&
				segment.label !== "prior_message:agent") ||
			!("id" in segment) ||
			segment.id !== event.id ||
			!("content" in segment) ||
			typeof segment.content !== "string"
		)
			continue;
		sources.push({
			id: `h${sources.length + 1}`,
			event: event as ContextSegmentEvent,
		});
	}
	// Ambiguous identifiers cannot be labeled or selected safely. The caller
	// receives no selectable surface and therefore keeps the full context.
	if (new Set(sources.map(({ event }) => event.id)).size !== sources.length)
		sources.length = 0;
	return sources;
}

/** Compact IDs are bound to the exact turn, room, identities and source bytes. */
export function completionContextSources(context: ContextObject): {
	sourceSetId: string;
	sources: Array<{ id: string; event: ContextSegmentEvent }>;
} {
	const sources = collectCompletionContextSources(context);
	return {
		sourceSetId: hashStableJson({
			contextId: context.id,
			roomId: context.metadata?.roomId,
			messageId: context.metadata?.messageId,
			sources: sources.map(({ id, event }) => ({ id, event })),
		}),
		sources,
	};
}

/** Relevance is applied only after source binding and complete category checks. */
export function selectCompletionContext(context: ContextObject): {
	context: ContextObject;
	applied: boolean;
	omittedSourceCount: number;
	selection?: CompletionContextSelection;
} {
	const complete = { context, applied: false, omittedSourceCount: 0 };
	const selection = parseCompletionContextSelection(
		context.metadata?.completionContext,
	);
	if (selection?.mode !== "selected" || !selection.complete) return complete;
	const { sourceSetId, sources } = completionContextSources(context);
	if (selection.sourceSetId !== sourceSetId || sources.length === 0)
		return complete;
	const sourceIds = new Set(sources.map(({ id }) => id));
	const selectedIds = new Set(
		SOURCE_LIST_FIELDS.flatMap((key) => selection[key]),
	);
	if ([...selectedIds].some((id) => !sourceIds.has(id))) return complete;
	const omittedEvents = new Set<ContextEvent>(
		sources.filter(({ id }) => !selectedIds.has(id)).map(({ event }) => event),
	);
	if (omittedEvents.size === 0) return complete;
	return {
		context: {
			...context,
			events: context.events.filter((event) => !omittedEvents.has(event)),
		},
		applied: true,
		omittedSourceCount: omittedEvents.size,
		selection,
	};
}

/** Tokenized retrieval queries are diagnostics, not authored dialogue. Keep the
 * complete array in the source event and restore it through RESTORE_CONTEXT;
 * preserve all other routing, permission, patch, and execution fields inline. */
export function referencePlannerQueryTokens(context: ContextObject): {
	context: ContextObject;
	applied: boolean;
} {
	if (context.metadata?.plannerQueryTokensRestored === true)
		return { context, applied: false };
	let applied = false;
	const events = context.events.map((event) => {
		if (event.type !== "message_handler" || event.source !== "message-service")
			return event;
		const plan = event.metadata?.plan;
		if (!plan || typeof plan !== "object" || Array.isArray(plan)) return event;
		const surface = plan.actionSurface;
		if (
			!surface ||
			typeof surface !== "object" ||
			Array.isArray(surface) ||
			!["full", "tiered", "relay-delivery"].includes(String(surface.mode)) ||
			!Array.isArray(surface.queryTokens) ||
			!surface.queryTokens.every((token) => typeof token === "string")
		)
			return event;
		const { queryTokens, ...routing } = surface;
		// Referencing a tiny list would increase cost. This is a lossless carrier
		// choice, not a cap: the entire list remains available as one exact source.
		const reference = {
			sourceEventId: event.id,
			field: "metadata.plan.actionSurface.queryTokens",
			count: queryTokens.length,
			sha256: hashStableJson(queryTokens),
			restoreTool: "RESTORE_CONTEXT",
		};
		if (JSON.stringify(queryTokens).length <= JSON.stringify(reference).length)
			return event;
		applied = true;
		return {
			...event,
			metadata: {
				...event.metadata,
				plan: { ...plan, actionSurface: routing },
				plannerQueryTokensReference: reference,
			},
		};
	});
	return { context: applied ? { ...context, events } : context, applied };
}
