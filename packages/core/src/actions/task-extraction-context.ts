/** Request-bound task extraction view of the planner's reviewed originals.
 * Complete state and source events stay intact. This capability is process-local;
 * serialized/cloned provider data never grants source-selection authority. */
import { getAmbientSingleton } from "../ambient-context";
import {
	completionContextSources,
	selectHistoricalNavigation,
} from "../runtime/completion-context";
import { hashStableJson } from "../runtime/context-hash";
import { renderContextObject, segmentBlock } from "../runtime/context-renderer";
import { compactHistoricalReceiptSegments } from "../runtime/historical-receipt-wire";
import { projectDeferredProviders } from "../runtime/provider-context";
import type { ContextObject } from "../types/context-object";
import type { Memory } from "../types/memory";
import type { State } from "../types/state";

type Binding = {
	original: ContextObject;
	projected: ContextObject;
	sourceHash: string;
	projectionHash: string;
	requestHash: string;
	stateHash: string;
};
const key = Symbol.for("eliza.task-extraction-context");
const bindings = () =>
	getAmbientSingleton(key, () => new WeakMap<object, Binding>());
const stateFingerprint = (state: State) =>
	hashStableJson({
		text: state.text,
		recentMessages: state.values.recentMessages,
		selectedActionConversation: state.values.selectedActionConversation,
		data: state.data,
	});

/** Called only by the planner action boundary after its existing validators. */
export function bindTaskExtractionContext(
	state: State,
	message: Memory,
	original: ContextObject,
	projected: ContextObject,
): void {
	if (state.data) bindings().delete(state.data);
	if (
		!state.data ||
		!message.id ||
		!message.roomId ||
		!message.entityId ||
		original.metadata?.messageId !== message.id ||
		original.metadata?.roomId !== message.roomId
	)
		return;
	try {
		const sources = completionContextSources(original).sources;
		const sourceIds = new Set(sources.map(({ event }) => event.id));
		const included = new Set(
			projected.events
				.filter((event) => sourceIds.has(event.id))
				.map((event) => event.id),
		);
		if (!sources.length || included.size === sources.length) return;
		// A producer may remove only reviewed dialogue and its unambiguously bound
		// historical evidence. Current providers, instructions and effects stay exact.
		const expected = {
			...original,
			events: selectHistoricalNavigation(original, included).events.filter(
				(event) => !sourceIds.has(event.id) || included.has(event.id),
			),
		};
		if (hashStableJson(expected) !== hashStableJson(projected)) return;
		bindings().set(state.data, {
			original,
			projected,
			sourceHash: hashStableJson(original),
			projectionHash: hashStableJson(projected),
			requestHash: hashStableJson(message),
			stateHash: stateFingerprint(state),
		});
	} catch {
		// Invalid optional projection cannot remove any extractor context.
	}
}

/** Routing clones State.values but preserves State.data; copied JSON cannot
 * inherit this capability. Changed source/actor/request/state falls back to full. */
export function readTaskExtractionContext(
	state: State | undefined,
	message: Memory | undefined,
	expectedSystem?: string,
): { text: string; originalText: string; system?: string } | undefined {
	if (!state?.data || !message) return undefined;
	const binding = bindings().get(state.data);
	if (!binding) return undefined;
	try {
		if (
			binding.requestHash !== hashStableJson(message) ||
			binding.stateHash !== stateFingerprint(state) ||
			binding.sourceHash !== hashStableJson(binding.original) ||
			binding.projectionHash !== hashStableJson(binding.projected)
		)
			return undefined;
		// Keep the trusted canonical prefix on the model's system surface once,
		// rather than flattening it into user context and adding it again at dispatch.
		// Originals, style directions, other instructions, providers and receipts
		// stay intact in the bound source. Only an authorized provider-owned notice
		// may defer its body below; this is not text-based dialogue deduplication.
		const system = binding.original.staticPrefix?.systemPrompt?.content;
		// A different live persona/role must retain the existing full context;
		// never replace the dispatcher's current authority with a stale prefix.
		const separateSystem =
			typeof system === "string" &&
			system.trim().length > 0 &&
			system === expectedSystem;
		const render = (context: ContextObject) =>
			renderContextObject(
				separateSystem
					? {
							...context,
							staticPrefix: {
								...context.staticPrefix,
								systemPrompt: undefined,
							},
						}
					: context,
			);
		// Reuse the planner's authorized, provider-owned deferred view. Standing
		// constraints stay in its notice; loaded/unknown providers stay complete.
		// The unchanged original remains the full pre-effect restoration source.
		const rendered = render(
			projectDeferredProviders(binding.projected).context,
		);
		return {
			text: compactHistoricalReceiptSegments(rendered.promptSegments)
				.map(segmentBlock)
				.join("\n\n"),
			originalText: render(binding.original)
				.promptSegments.map(segmentBlock)
				.join("\n\n"),
			...(separateSystem ? { system } : {}),
		};
	} catch {
		return undefined;
	}
}
