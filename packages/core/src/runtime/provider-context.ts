/** Keep authorized provider references deferred across planning and completion.
 * The original events remain intact for the existing tool-free restoration
 * protocol. Only providers that explicitly publish an index participate. */
import type {
	ContextObject,
	ContextProviderEvent,
} from "../types/context-object";
import type { JSONSchema } from "../types/model";
import { hashStableJson } from "./context-hash";

/** Bind source selection to exact authorized bodies, authors, rooms and turn.
 * Discovery-only bodies have not been reviewed and cannot participate. */
export function providerReviewSources(context: ContextObject) {
	const loaded = context.metadata?.loadedContextProviders;
	const providers = context.events.filter(
		(event): event is ContextProviderEvent =>
			event.type === "provider" &&
			"reviewableSources" in event &&
			Boolean(event.reviewableSources) &&
			!("discoveryText" in event && event.discoveryText) &&
			!(Array.isArray(loaded) && loaded.includes(String(event.name))),
	);
	if (
		!context.metadata?.roomId ||
		!context.metadata?.messageId ||
		!providers.length
	)
		return undefined;
	const ids = new Set<string>();
	for (const provider of providers) {
		const review = provider.reviewableSources;
		if (
			!review ||
			typeof review.notice !== "string" ||
			!review.notice.trim() ||
			!Array.isArray(review.sources) ||
			!review.sources.length ||
			typeof provider.text !== "string"
		)
			return undefined;
		for (const source of review.sources) {
			if (
				!source ||
				typeof source.id !== "string" ||
				!/^[a-zA-Z][a-zA-Z0-9]*$/.test(source.id) ||
				ids.has(source.id) ||
				typeof source.text !== "string" ||
				!source.text ||
				!source.metadata ||
				!(
					provider.text.includes(`[${source.id}]`) ||
					provider.text.includes(`[${source.id}; same_text_as=`)
				)
			)
				return undefined;
			ids.add(source.id);
		}
	}
	return {
		providers,
		ids,
		sourceSetId: hashStableJson({
			contextId: context.id,
			roomId: context.metadata.roomId,
			messageId: context.metadata.messageId,
			providers,
		}),
	};
}

export function withProviderReviewSchema(
	schema: JSONSchema,
	context: ContextObject,
): JSONSchema {
	const review = providerReviewSources(context);
	if (!review) return schema;
	return {
		...schema,
		properties: {
			...schema.properties,
			providerReview: {
				type: "object",
				additionalProperties: false,
				properties: {
					sourceSetId: { type: "string", enum: [review.sourceSetId] },
					complete: { type: "boolean" },
					keep: { type: "array", items: { type: "string" } },
				},
				required: ["sourceSetId", "complete", "keep"],
				description:
					"Review every recalledN source in provider context. Keep IDs needed for later planning/completion: applicable constraints, permissions, corrections, referents, pending work and original-source evidence. Keep uncertain sources. complete=true certifies review of all supplied sources, not unseen originals. Empty keep means all are irrelevant. Repeated sources retain their full original bodies when selected. These IDs are not history hN IDs. Missing evidence remains retrievable.",
			},
		},
		required: [...(schema.required ?? []), "providerReview"],
	};
}

export function projectDeferredProviders(context: ContextObject): {
	context: ContextObject;
	available: string[];
} {
	const available: string[] = [];
	if (context.metadata?.providerDiscoveryEnabled !== true)
		return { context, available };
	const loaded = context.metadata.loadedContextProviders;
	const review = providerReviewSources(context);
	const raw = context.metadata.providerReview;
	const selection =
		raw && typeof raw === "object"
			? (raw as { sourceSetId?: unknown; complete?: unknown; keep?: unknown })
			: undefined;
	const keep =
		review &&
		selection?.complete === true &&
		selection.sourceSetId === review.sourceSetId &&
		Array.isArray(selection.keep) &&
		selection.keep.every((id) => typeof id === "string" && review.ids.has(id))
			? new Set(selection.keep as string[])
			: undefined;
	const events = context.events.map((event) => {
		if (keep && review?.providers.includes(event as ContextProviderEvent)) {
			const provider = event as ContextProviderEvent;
			const sources = provider.reviewableSources;
			if (!sources) return event;
			const selected = sources.sources.filter((source) => keep.has(source.id));
			if (selected.length === sources.sources.length) return event;
			const text = [
				sources.notice,
				...selected.map((source) => `[${source.id}]\n${source.text}`),
				"Other recalled sources omitted after handler review; restore provider context if needed.",
			].join("\n");
			if (text.length >= (provider.text?.length ?? 0)) return event;
			available.push(provider.name);
			return { ...provider, text };
		}
		if (
			event.type !== "provider" ||
			!("discoveryText" in event) ||
			typeof event.discoveryText !== "string" ||
			!event.discoveryText.trim() ||
			!("text" in event) ||
			typeof event.text !== "string" ||
			event.discoveryText.length >= event.text.length ||
			!("name" in event) ||
			typeof event.name !== "string" ||
			(Array.isArray(loaded) && loaded.includes(event.name))
		)
			return event;
		available.push(event.name);
		return { ...event, text: event.discoveryText };
	});
	return { context: { ...context, events }, available };
}
