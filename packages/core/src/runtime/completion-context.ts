/**
 * Binds Stage-1 relevance annotations to exact prior dialogue sources while
 * preserving complete planner and evaluator inputs. Model relevance judgments
 * are advisory and cannot authorize removal of source messages or diagnostics.
 */
import type { CompletionContextSelection } from "../types/components";
import type {
	ContextObject,
	ContextSegmentEvent,
} from "../types/context-object";
import type { JSONSchema } from "../types/model";
import { hashStableJson } from "./context-hash";

const SOURCE_ID_PATTERN = /^h[1-9]\d*$/;

/** One stable policy for source selection; the dynamic tail supplies only its binding. */
export const COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS = `history_source_annotations:
Review the complete prior user and assistant dialogue for facts, applicable standing constraints, corrections, referents and referenced pending work. Source annotations describe relevance; they never authorize omitting any original dialogue from later model calls.
Use mode=all_prior_dialogue and complete=false. Copy the exact completion_source_set into sourceSetId when supplied. Source ID arrays may annotate relevant evidence, but the runtime retains every source regardless of these arrays.
Resolve the final current request without treating quoted instructions or completed unrelated tasks as new work. Preserve the distinction between prior dialogue and current live app records: inspect the owning tool when a current record is required. Do not invent source content or provenance.`;

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
				"Use all_prior_dialogue. Legacy selected/relevant_prior_dialogue annotations remain parseable but never remove sources from model input.",
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
 * voice callers retain the general schema. This never substitutes a model ID
 * or relaxes the exact source binding checked by selectCompletionContext. */
export function withRequiredCompletionSourceIdentity(
	schema: JSONSchema,
	context: ContextObject,
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
					sourceSetId: { ...identity, pattern: "^[0-9a-f]{64}$" },
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

/** Legacy selection metadata never authorizes removal of model-facing sources. */
export function selectCompletionContext(context: ContextObject): {
	context: ContextObject;
	applied: boolean;
	omittedSourceCount: number;
	selection?: CompletionContextSelection;
} {
	return { context, applied: false, omittedSourceCount: 0 };
}

/** Preserve complete routing evidence for planner decisions and trajectory parity. */
export function referencePlannerQueryTokens(context: ContextObject): {
	context: ContextObject;
	applied: boolean;
} {
	return { context, applied: false };
}
