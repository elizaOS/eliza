/** Request-bound task extraction view of the planner's reviewed originals.
 * Complete state and source events stay intact. This capability is process-local;
 * serialized/cloned provider data never grants source-selection authority. */

import { getAmbientSingleton } from "../ambient-context";
import {
	completionContextSources,
	selectHistoricalNavigation,
} from "../runtime/completion-context";
import { hashStableJson } from "../runtime/context-hash";
import type { ContextObject } from "../runtime/context-object";
import { renderContextObject, segmentBlock } from "../runtime/context-renderer";
import { compactHistoricalReceiptSegments } from "../runtime/historical-receipt-wire";
import { projectDeferredProviders } from "../runtime/provider-context";
import type { Memory } from "../types/memory";
import type { State } from "../types/state";

type Binding = {
	original: ContextObject;
	projected: ContextObject;
	sourceHash: string;
	projectionHash: string;
	requestHash: string;
	stateHash: string;
	extractionProjectionAuthorized: boolean;
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
		// Exact full views bind current decision metadata without granting an
		// extraction projection; only the existing partial-history rule can do so.
		const extractionProjectionAuthorized =
			sources.length > 0 && included.size !== sources.length;
		// A producer may remove only reviewed dialogue and its unambiguously bound
		// historical evidence. Current providers, instructions and effects stay exact.
		const expected = extractionProjectionAuthorized
			? {
					...original,
					events: selectHistoricalNavigation(original, included).events.filter(
						(event) => !sourceIds.has(event.id) || included.has(event.id),
					),
				}
			: original;
		if (hashStableJson(expected) !== hashStableJson(projected)) return;
		bindings().set(state.data, {
			original,
			projected,
			sourceHash: hashStableJson(original),
			projectionHash: hashStableJson(projected),
			requestHash: hashStableJson(message),
			stateHash: stateFingerprint(state),
			extractionProjectionAuthorized,
		});
	} catch {
		// Invalid optional projection cannot remove any extractor context.
	}
}

function readBinding(
	state: State | undefined,
	message: Memory | undefined,
): Binding | undefined {
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
		return binding;
	} catch {
		return undefined;
	}
}

/** Current Stage-1 intent evidence from the same unmodified request capability.
 * Missing, cloned or changed bindings grant no foreground ownership authority. */
export function readTaskExtractionRequestIntents(
	state: State | undefined,
	message: Memory | undefined,
): readonly string[] | undefined {
	const binding = readBinding(state, message);
	if (!binding) return undefined;
	const events = binding.original.events.filter(
		(event) =>
			event.type === "message_handler" && event.source === "message-service",
	);
	if (events.length !== 1 || events[0].metadata?.processMessage !== "RESPOND")
		return undefined;
	const plan = events[0].metadata?.plan;
	if (!plan || typeof plan !== "object" || Array.isArray(plan))
		return undefined;
	const intents = plan.intents;
	if (
		!Array.isArray(intents) ||
		!intents.length ||
		!intents.every(
			(intent) => typeof intent === "string" && intent.trim().length > 0,
		)
	)
		return undefined;
	return [...intents] as string[];
}

/** Routing clones State.values but preserves State.data; copied JSON cannot
 * inherit this capability. Changed source/actor/request/state falls back to full. */
export function readTaskExtractionContext(
	state: State | undefined,
	message: Memory | undefined,
	expectedSystem?: string,
): { text: string; originalText: string; system?: string } | undefined {
	const binding = readBinding(state, message);
	if (!binding?.extractionProjectionAuthorized) return undefined;
	try {
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
