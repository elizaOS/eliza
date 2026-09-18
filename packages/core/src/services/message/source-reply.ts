/** Native reply parts resolve only against the authorized snapshot sent in this
 * model attempt. Raw provider output and stored dialogue remain unchanged. */
import { ElizaError } from "../../errors";
import {
	completionContextSources,
	parseCompletionContextSelection,
} from "../../runtime/completion-context";
import { providerReviewSources } from "../../runtime/provider-context";
import type { ContextObject } from "../../types/context-object";
import type { Memory } from "../../types/memory";
import type { JSONSchema } from "../../types/model";
import { getUserMessageText } from "../../utils/message-text";
import { priorDialogueContent } from "./dialogue-context";
import type { HistoryDiscovery } from "./history-discovery";
import {
	type SourceReplyReferences,
	sourceReplyEventHash,
	sourceReplyTextHash,
} from "./source-reply-references";

export const SOURCE_REPLY_INSTRUCTIONS =
	'Reply parts: replyText is an ordered array. Use {kind:"source",value:"hN"} (or "recalledN" from provider context) for every verbatim original-message quotation; the renderer inserts that supplied original unchanged. Use {kind:"text",value:"..."} for your own explanations or summaries, not retyped original quotations. Source parts may refer only to supplied originals; keep recalledN quotes in providerReview.keep and preserve speaker attribution. Use [] when no reply is needed.';

export const SOURCE_REPLY_SCHEMA: JSONSchema = {
	type: "array",
	description:
		"Ordered reply parts: text is your prose; source is a supplied hN or recalledN original inserted unchanged as its own paragraph. Use source parts for verbatim whole-message quotes, never retype them. Keep explanations and speaker attribution in text parts. Use [] for no reply.",
	items: {
		type: "object",
		additionalProperties: false,
		properties: {
			kind: { type: "string", enum: ["text", "source"] },
			value: { type: "string" },
		},
		required: ["kind", "value"],
	},
};
export type SourceReplySnapshot = {
	sourceSetId: string;
	providerSourceSetId?: string;
	suppliedIds: ReadonlySet<string>;
	originals: ReadonlyMap<string, string>;
	references: ReadonlyMap<string, SourceReplyReferences["sources"][number]>;
};

/** Copy bodies from the same authorized provider result used for composition.
 * Exact presentation reconstruction prevents a record ID or speaker mismatch
 * from supplying unrelated text. Augmented envelopes are not quote sources. */
export function createSourceReplySnapshot(
	context: ContextObject,
	projection: HistoryDiscovery,
	memories: readonly Memory[],
): SourceReplySnapshot | undefined {
	const bound = completionContextSources(context);
	if (bound.sourceSetId !== projection.sourceSetId) return undefined;
	const byId = new Map<string, Memory>();
	const duplicates = new Set<string>();
	for (const memory of memories) {
		if (!memory || typeof memory !== "object" || !memory.id) continue;
		const id = `history:${memory.id}`;
		if (byId.has(id)) duplicates.add(id);
		byId.set(id, memory);
	}
	const suppliedIds = new Set<string>();
	const originals = new Map<string, string>();
	const references = new Map<
		string,
		SourceReplyReferences["sources"][number]
	>();
	for (const { id, event } of bound.sources) {
		if (
			!projection.visibleEventIds.has(event.id) &&
			!projection.loadedSourceIds.has(id)
		)
			continue;
		suppliedIds.add(id);
		const memory = byId.get(event.id);
		const meta = event.segment.metadata;
		if (
			!memory ||
			duplicates.has(event.id) ||
			memory.agentId !== projection.scope.agentId ||
			memory.roomId !== meta?.roomId ||
			memory.entityId !== meta?.entityId
		)
			continue;
		const raw =
			typeof memory.content?.currentMessageText === "string"
				? memory.content.currentMessageText
				: memory.content?.text;
		if (typeof raw !== "string" || getUserMessageText(memory) !== raw.trim())
			continue;
		const speaker =
			typeof meta?.speakerName === "string" ? meta.speakerName : undefined;
		if (priorDialogueContent(raw.trim(), speaker) !== event.segment.content)
			continue;
		originals.set(id, raw);
		references.set(id, {
			eventId: event.id,
			sourceSha256: sourceReplyEventHash(event),
		});
	}
	const historyOriginalCount = originals.size;
	const providers = providerReviewSources(context);
	for (const provider of providers?.providers ?? []) {
		for (const source of provider.reviewableSources?.sources ?? []) {
			// Only an explicitly supplied original body is a quotation source.
			// Presentation prefixes, summaries and discovery notices are not originals.
			if (
				typeof source.originalText !== "string" ||
				!source.originalText ||
				!source.text.endsWith(source.originalText) ||
				/^h[1-9]\d*$/.test(source.id) ||
				suppliedIds.has(source.id)
			)
				continue;
			suppliedIds.add(source.id);
			originals.set(source.id, source.originalText);
		}
	}
	return {
		sourceSetId: bound.sourceSetId,
		providerSourceSetId:
			originals.size > historyOriginalCount
				? providers?.sourceSetId
				: undefined,
		suppliedIds,
		originals,
		references,
	};
}

/** Undefined keeps an invalid source decision in ordinary history recovery.
 * Invalid parts after a valid review fail before field processors/effects. */
export function resolveSourceReply(
	context: ContextObject,
	snapshot: SourceReplySnapshot,
	raw: Record<string, unknown>,
	onReferences?: (references: SourceReplyReferences) => void,
): Record<string, unknown> | undefined {
	const selection = parseCompletionContextSelection(raw.completionContext);
	if (
		!selection?.complete ||
		selection.mode !== "selected" ||
		selection.sourceSetId !== snapshot.sourceSetId ||
		completionContextSources(context).sourceSetId !== snapshot.sourceSetId
	)
		return undefined;
	const providers = snapshot.providerSourceSetId
		? providerReviewSources(context)
		: undefined;
	if (
		snapshot.providerSourceSetId &&
		providers?.sourceSetId !== snapshot.providerSourceSetId
	)
		return undefined;
	const selected = new Set([
		...selection.relevantSourceIds,
		...selection.constraintSourceIds,
		...selection.referentSourceIds,
		...selection.pendingIntentSourceIds,
	]);
	const review = raw.providerReview;
	if (
		snapshot.providerSourceSetId &&
		review &&
		typeof review === "object" &&
		!Array.isArray(review)
	) {
		const fields = review as Record<string, unknown>;
		if (
			Object.keys(fields).every(
				(key) => key === "complete" || key === "keep",
			) &&
			fields.complete === true &&
			Array.isArray(fields.keep) &&
			fields.keep.every(
				(id) =>
					typeof id === "string" &&
					providers?.ids.has(id) &&
					!/^h[1-9]\d*$/.test(id),
			)
		)
			for (const id of fields.keep) {
				if (snapshot.originals.has(id as string)) selected.add(id as string);
			}
	}
	if ([...selected].some((id) => !snapshot.suppliedIds.has(id)))
		return undefined;
	const invalid = () =>
		new ElizaError(
			"Invalid source-backed reply; no response fields were processed",
			{ code: "STAGE1_INVALID_SOURCE_REPLY", severity: "ephemeral" },
		);
	if (!Array.isArray(raw.replyText)) throw invalid();
	const parts: string[] = [];
	const sources = new Map<string, SourceReplyReferences["sources"][number]>();
	for (const part of raw.replyText) {
		if (
			!part ||
			typeof part !== "object" ||
			Array.isArray(part) ||
			Object.keys(part).length !== 2 ||
			typeof part.value !== "string" ||
			!Object.hasOwn(part, "kind") ||
			!Object.hasOwn(part, "value")
		)
			throw invalid();
		if (part.kind === "text") parts.push(part.value);
		else if (
			part.kind === "source" &&
			selected.has(part.value) &&
			snapshot.originals.has(part.value)
		) {
			parts.push(`\n\n${snapshot.originals.get(part.value) ?? ""}\n\n`);
			const reference = snapshot.references.get(part.value);
			if (reference) sources.set(reference.eventId, reference);
		} else throw invalid();
	}
	const replyText = parts.join("");
	if (sources.size)
		onReferences?.({
			replySha256: sourceReplyTextHash(replyText),
			sources: [...sources.values()],
		});
	return { ...raw, replyText };
}
