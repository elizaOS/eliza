/** Tests persisted correction/cancellation groups through validated foreground history reads. */
import { describe, expect, it } from "vitest";
import {
	applyHistoryRetentionReview,
	prepareHistoryRetention,
	validateHistoryRetention,
} from "../../runtime/history-retention.ts";
import type { ContextObject } from "../../types/context-object.ts";
import {
	loadHistoryReferences,
	projectReviewedHistory,
} from "./history-discovery.ts";

function fixture() {
	const scope = {
		agentId: "agent",
		roomId: "room",
		entityId: "user",
		roles: ["OWNER"],
	};
	const text = [
		"For this conversation, ask my city and do not edit notes without a specific request.",
		"Cancel only the city question. The Notes rule still applies.",
		"Now revoke the remaining Notes rule.",
		...Array.from({ length: 13 }, (_, i) => `Unrelated exchange ${i}`),
	];
	const context: ContextObject = {
		id: "retention",
		metadata: { roomId: "room" },
		events: text.map((content, i) => ({
			id: `history:${i}`,
			type: "segment",
			source: "prior-dialogue",
			createdAt: i,
			segment: {
				id: `history:${i}`,
				label:
					i > 2 && i % 2 === 1 ? "prior_message:agent" : "prior_message:user",
				content,
				stable: false,
			},
		})),
	};
	const first = prepareHistoryRetention(context, scope, null, "first", 3);
	const indexed = applyHistoryRetentionReview(first, {
		sourceSetId: first.sourceSetId,
		complete: true,
		retainSourceIds: ["h1"],
		deferSourceIds: ["h2", "h3"],
		uncertainSourceIds: [],
		dependencyGroups: [
			["h1", "h2"],
			["h2", "h3"],
		],
	});
	const next = prepareHistoryRetention(
		context,
		scope,
		indexed,
		"next",
		text.length,
	);
	const deferred = applyHistoryRetentionReview(next, {
		sourceSetId: next.sourceSetId,
		complete: true,
		retainSourceIds: [],
		deferSourceIds: next.candidates.map((source) => source.id),
		uncertainSourceIds: [],
		dependencyGroups: [],
	});
	return { context, scope, indexed, deferred };
}

describe("persisted history source dependencies", () => {
	it.each([
		"history:h1",
		"history:h2",
		"history:h3",
		"history:search-user:city question",
	])(
		"restores the complete amendment chain for %s after all its sources were deferred",
		(reference) => {
			const { context, scope, deferred } = fixture();
			expect(deferred.retainedEventIds).toEqual([]);
			const before = structuredClone(context);
			const projection = projectReviewedHistory(context, scope, deferred);
			expect(projection).toBeDefined();
			expect(projection?.visibleEventIds.has("history:0")).toBe(false);
			const loaded = loadHistoryReferences(context, projection, [reference]);
			expect([...(loaded.projection?.loadedSourceIds ?? [])].sort()).toEqual([
				"h1",
				"h2",
				"h3",
			]);
			if (reference.includes("search"))
				expect(loaded.evidence?.searchResults?.[0].matchedSourceIds).toEqual([
					"h2",
				]);
			expect(context).toEqual(before);
		},
	);
	it("retains recorded dependencies when a later review keeps only one member", () => {
		const { context, scope, indexed } = fixture();
		const active = prepareHistoryRetention(
			context,
			scope,
			indexed,
			"again",
			context.events.length,
		);
		const cp = applyHistoryRetentionReview(active, {
			sourceSetId: active.sourceSetId,
			complete: true,
			retainSourceIds: ["h2"],
			deferSourceIds: active.candidates
				.filter((s) => s.id !== "h2")
				.map((s) => s.id),
			uncertainSourceIds: [],
			dependencyGroups: [],
		});
		expect(cp.retainedEventIds).toEqual([
			"history:0",
			"history:1",
			"history:2",
		]);
	});
	it.each([
		[["history:0", "unknown"]],
		[["history:0", "history:0"]],
		[["history:0"]],
	])(
		"rejects malformed or unbound dependency groups",
		(dependencyEventGroups) => {
			const { context, scope, deferred } = fixture();
			expect(
				validateHistoryRetention(context, scope, {
					...deferred,
					dependencyEventGroups,
				}),
			).toBeNull();
		},
	);
	it("rejects source edits, deletion, and scope changes before exposing a saved graph", () => {
		const { context, scope, deferred } = fixture();
		const edited = structuredClone(context);
		edited.events[1].segment.content = "The opposite instruction";
		expect(projectReviewedHistory(edited, scope, deferred)).toBeUndefined();
		const removed = structuredClone(context);
		removed.events.splice(1, 1);
		expect(projectReviewedHistory(removed, scope, deferred)).toBeUndefined();
		expect(
			projectReviewedHistory(
				context,
				{ ...scope, entityId: "other" },
				deferred,
			),
		).toBeUndefined();
	});
	it("expands a recent linked source without pulling unrelated deferred messages inline", () => {
		const { context, scope, deferred } = fixture();
		const checkpoint = {
			...deferred,
			dependencyEventGroups: [["history:0", "history:6"]],
		};
		const projection = projectReviewedHistory(context, scope, checkpoint);
		expect(projection).toBeDefined();
		expect([...projection!.visibleEventIds].sort()).toEqual(
			[
				"history:0",
				...Array.from({ length: 10 }, (_, i) => `history:${i + 6}`),
			].sort(),
		);
		expect(projection!.loadedSourceIds.size).toBe(0);
	});
	it("deduplicates the same dependency declared in reverse order on replay", () => {
		const { context, scope, indexed } = fixture();
		const prepared = prepareHistoryRetention(
			context,
			scope,
			indexed,
			"replay",
			context.events.length,
		);
		const checkpoint = applyHistoryRetentionReview(prepared, {
			sourceSetId: prepared.sourceSetId,
			complete: true,
			retainSourceIds: [],
			uncertainSourceIds: [],
			deferSourceIds: prepared.candidates.map((source) => source.id),
			dependencyGroups: [
				["h2", "h1"],
				["h3", "h2"],
			],
		});
		expect(checkpoint.dependencyEventGroups).toEqual(
			indexed.dependencyEventGroups,
		);
	});

	it("continues to accept checkpoints without the optional graph", () => {
		const { context, scope, deferred } = fixture();
		const { dependencyEventGroups: _groups, ...legacy } = deferred;
		expect(validateHistoryRetention(context, scope, legacy)).toEqual(legacy);
	});
});
