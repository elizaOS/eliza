/**
 * Binds Stage-1 relevance selections to exact prior dialogue sources for
 * the planner and completion evaluator. Current requests, standing provider constraints,
 * instructions, runtime feedback and tool evidence are never selectable away.
 * Absent, malformed or stale selections preserve the complete original context.
 */

import { ElizaError } from "../errors";
import type {
	ActionParameterSchema,
	CompletionContextSelection,
} from "../types/components";
import { normalizeEffectReceipt } from "../types/effects";
import type { JSONSchema } from "../types/model";
import { hashStableJson } from "./context-hash";
import type {
	ContextEvent,
	ContextObject,
	ContextSegmentEvent,
} from "./context-object";

/** Runtime-only proof from the owner-scoped approval reader. Serialized/model
 * metadata cannot mint this symbol; complete original receipt bytes stay intact. */
export const HISTORICAL_EFFECT_TERMINALS: unique symbol = Symbol(
	"historicalEffectTerminals",
);
export interface HistoricalEffectTerminal {
	requestSourceEventId: string;
	originalReceiptHash: string;
	terminalReceipt: unknown;
	state: "done" | "rejected" | "expired";
}

function hasHistoricalTerminal(
	event: ContextSegmentEvent,
	requestSourceEventId: string,
	receipt: unknown,
): boolean {
	const proofs = (
		event as ContextSegmentEvent & {
			[HISTORICAL_EFFECT_TERMINALS]?: readonly HistoricalEffectTerminal[];
		}
	)[HISTORICAL_EFFECT_TERMINALS];
	return (
		proofs?.some(
			(proof) =>
				proof.requestSourceEventId === requestSourceEventId &&
				["done", "rejected", "expired"].includes(proof.state) &&
				(proof.originalReceiptHash === hashStableJson(receipt) ||
					hashStableJson(proof.terminalReceipt) === hashStableJson(receipt)),
		) === true
	);
}

const SOURCE_ID_PATTERN = /^h[1-9]\d*$/;

/** Shared source-selection policy; each stage supplies its request-local binding. */
export const COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS = `History selection: use the source map to select original facts, applicable standing constraints/corrections, referents and explicitly continued unfinished work in completionContext. Assign each source once; its exact text remains intact. Completed tasks are not pending, and task-scoped restrictions do not automatically become standing rules. Preserve corrections and original speaker attribution; navigation receipts follow their request.
Use relevant_prior_dialogue with complete=true when dependencies are resolved (an empty selection is valid), otherwise all_prior_dialogue with complete=false. Exhaustive dialogue coverage needs all originals; live-record questions need tools. Use the sourceSetId required by the response schema. Current request, system/provider constraints and receipts remain complete; selection proves relevance, never execution.`;

/** Shared static and registered Stage-1 wire schema. */
export const COMPLETION_CONTEXT_SCHEMA = {
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
} satisfies JSONSchema & ActionParameterSchema;

/** Initial and repair requests both offer the exact current identity. The
 * third argument remains accepted for existing callers; host validation and
 * request-local token binding still decide whether a selection can apply. */
export function withRequiredCompletionSourceIdentity(
	schema: JSONSchema,
	context: ContextObject,
	_exactRepair = false,
): JSONSchema {
	const completion = schema.properties?.completionContext;
	const identity = completion?.properties?.sourceSetId;
	if (!completion || identity?.type !== "string") return schema;
	const snapshot = completionContextSources(context);
	if (snapshot.sources.length === 0) return schema;
	if (
		identity.enum !== undefined &&
		(!Array.isArray(identity.enum) ||
			!identity.enum.some((id) => id === snapshot.sourceSetId))
	) {
		throw new ElizaError(
			"Source identity schema does not authorize this request.",
			{
				code: "COMPLETION_CONTEXT_IDENTITY_CONFLICT",
			},
		);
	}
	// Offer only this request's authorized identities. Keep canonical host
	// parsers unchanged; strict providers need literal choices instead of regexes.
	const sourceIds = snapshot.sources.map(({ id }) => id);
	const properties = { ...completion.properties };
	for (const name of SOURCE_LIST_FIELDS) {
		const field = properties[name];
		const items = field?.items;
		if (
			!field ||
			!items ||
			Array.isArray(items) ||
			items.type !== "string" ||
			(items.pattern !== undefined &&
				items.pattern !== SOURCE_ID_PATTERN.source)
		)
			continue;
		const { pattern: _pattern, ...literalItems } = items;
		properties[name] = {
			...field,
			items: {
				...literalItems,
				enum: Array.isArray(items.enum)
					? items.enum.filter(
							(id): id is string =>
								typeof id === "string" && sourceIds.includes(id),
						)
					: sourceIds,
			},
		};
	}
	const { pattern: _pattern, ...literalIdentity } = identity;
	properties.sourceSetId = { ...literalIdentity, enum: [snapshot.sourceSetId] };
	return {
		...schema,
		properties: {
			...schema.properties,
			completionContext: { ...completion, properties },
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

function isHistoricalRequestEvidenceEvent(
	event: ContextEvent,
): event is ContextSegmentEvent {
	if (
		event.type !== "segment" ||
		event.source !== "message-service" ||
		!("segment" in event)
	)
		return false;
	const segment = event.segment;
	return (
		!!segment &&
		typeof segment === "object" &&
		!Array.isArray(segment) &&
		"label" in segment &&
		(segment.label === "runtime:historical_navigation" ||
			segment.label === "runtime:historical_observations" ||
			segment.label === "runtime:historical_effects") &&
		"content" in segment &&
		typeof segment.content === "string" &&
		"id" in segment &&
		segment.id === event.id
	);
}

/** Historical navigation and owner-declared read observations follow their
 * original requests, never current state or mutation authority. Completion may
 * also defer validated historical outcomes for reviewed omitted requests;
 * canonical history and planning evidence remain complete by default.
 * Only known, unambiguous request bindings may follow a history projection.
 * Unknown or malformed records stay inline; originals are never modified. */
export function selectHistoricalNavigation(
	context: ContextObject,
	includedEventIds: ReadonlySet<string>,
	options: { historicalEffects?: boolean | "settled" } = {},
): ContextObject {
	const sources = collectCompletionContextSources(context);
	if (sources.length === 0) return context;
	const known = new Set(sources.map(({ event }) => event.id));
	const requests = new Set(
		sources
			.filter((source) => source.event.segment.label === "prior_message:user")
			.map((source) => source.event.id),
	);
	const eventIdCounts = new Map<string, number>();
	for (const event of context.events)
		eventIdCounts.set(event.id, (eventIdCounts.get(event.id) ?? 0) + 1);
	return {
		...context,
		events: context.events.filter((event) => {
			if (!isHistoricalRequestEvidenceEvent(event)) return true;
			const effects = event.segment.label === "runtime:historical_effects";
			// Historical mutation evidence stays inline unless a reviewed model
			// or source-bound background projection explicitly permits deferral.
			if (effects && !options.historicalEffects) return true;
			try {
				const receipt: unknown = JSON.parse(event.segment.content);
				if (
					!receipt ||
					typeof receipt !== "object" ||
					Array.isArray(receipt) ||
					!("requestSourceEventId" in receipt) ||
					typeof receipt.requestSourceEventId !== "string" ||
					!known.has(receipt.requestSourceEventId)
				)
					return true;
				const requestSourceEventId = receipt.requestSourceEventId;
				if (
					effects ||
					event.segment.label === "runtime:historical_observations"
				) {
					const field = effects ? "outcomes" : "observations";
					const entries = (receipt as Record<string, unknown>)[field];
					// The message-service collector owns exact operation admission. This
					// boundary independently rejects unsafe or unfamiliar receipt shapes.
					if (
						eventIdCounts.get(event.id) !== 1 ||
						!requests.has(receipt.requestSourceEventId) ||
						Object.keys(receipt).sort().join(",") !==
							`${field},requestSourceEventId,scope` ||
						!("scope" in receipt) ||
						typeof receipt.scope !== "string" ||
						!receipt.scope.trim() ||
						!(field in receipt) ||
						!Array.isArray(entries) ||
						!entries.length ||
						!entries.every((observation) => {
							if (
								!observation ||
								typeof observation !== "object" ||
								Array.isArray(observation) ||
								Object.keys(observation).sort().join(",") !==
									"actionName,receipt,success" ||
								typeof observation.actionName !== "string" ||
								!observation.actionName.trim() ||
								typeof observation.success !== "boolean" ||
								(!effects && observation.success !== true)
							)
								return false;
							const normalized = normalizeEffectReceipt(observation.receipt);
							return (
								(effects ||
									(normalized.outcome === "noop" &&
										!normalized.idempotency.replayed)) &&
								// Background review may defer settled outcomes only. Preview,
								// failures and uncertain acceptance remain visible regardless
								// of whether their historical request was deferred.
								(!effects ||
									options.historicalEffects !== "settled" ||
									(observation.success === true &&
										(normalized.outcome === "applied" ||
											(normalized.outcome === "noop" &&
												normalized.idempotency.replayed))) ||
									hasHistoricalTerminal(
										event,
										requestSourceEventId,
										normalized,
									)) &&
								hashStableJson(normalized) ===
									hashStableJson(observation.receipt)
							);
						})
					)
						return true;
				}
				return includedEventIds.has(receipt.requestSourceEventId);
			} catch {
				// error-policy:J3 A malformed binding cannot authorize context omission.
				return true;
			}
		}),
	};
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
			// Include exact historical outcomes in the source-set identity as well:
			// changed historical evidence cannot reuse an earlier relevance review.
			navigationEvidence: context.events.filter(
				isHistoricalRequestEvidenceEvent,
			),
		}),
		sources,
	};
}

/** Relevance is applied only after source binding and complete category checks. */
export function selectCompletionContext(
	context: ContextObject,
	options: { historicalEffects?: boolean | "settled" } = {},
): {
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
			events: selectHistoricalNavigation(
				context,
				new Set(
					sources
						.filter(({ id }) => selectedIds.has(id))
						.map(({ event }) => event.id),
				),
				options,
			).events.filter((event) => !omittedEvents.has(event)),
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
