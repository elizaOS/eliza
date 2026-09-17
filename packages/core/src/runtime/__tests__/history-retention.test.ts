/** Tests source-bound retention and preservation of linked request/outcome originals. */
import { describe, expect, it } from "vitest";
import {
	applyHistoryRetentionReview,
	prepareHistoryRetention,
	validateHistoryRetention,
	visibleHistoryEventIds,
} from "../../../../../plugins/plugin-assistant/src/runtime/history-retention.ts";
import type { ContextObject } from "../../types/context-object";

function fixture() {
	const scope = {
		agentId: "agent",
		roomId: "room",
		entityId: "user",
		roles: ["OWNER"],
	};
	const context: ContextObject = {
		id: "retention",
		metadata: { roomId: scope.roomId },
		events: [
			"Require a full preview before saving.",
			"Yes, retain that rule.",
			"hi",
			"Current question",
		].map((content, index) => ({
			id: `history:${index}`,
			type: "segment",
			source: "prior-dialogue",
			segment: {
				id: `history:${index}`,
				label: "prior_message:user",
				content,
				stable: false,
			},
		})),
	};
	const prepared = prepareHistoryRetention(context, scope, null, "evidence", 3);
	const review = {
		sourceSetId: prepared.sourceSetId,
		complete: true,
		retainSourceIds: ["h1"],
		deferSourceIds: ["h2", "h3"],
		uncertainSourceIds: [],
		dependencyGroups: [["h1", "h2"]],
	};
	return { context, scope, prepared, review };
}

describe("history retention dependency closure", () => {
	it("keeps a declared dependency despite a conflicting deferral without changing originals", () => {
		const { context, scope, prepared, review } = fixture();
		const before = structuredClone({ context, review });
		const checkpoint = applyHistoryRetentionReview(prepared, review);
		expect(checkpoint.retainedEventIds).toEqual(["history:0", "history:1"]);
		expect(visibleHistoryEventIds(context, scope, checkpoint)).toContain(
			"history:1",
		);
		expect(validateHistoryRetention(context, scope, checkpoint)).toEqual(
			checkpoint,
		);
		expect({ context, review }).toEqual(before);
		const changed = structuredClone(context);
		changed.events[0] = { ...changed.events[0], createdAt: 99 };
		expect(validateHistoryRetention(changed, scope, checkpoint)).toBeNull();
	});

	it.each([
		{ dependencyGroups: [["h1", "h99"]] },
		{ dependencyGroups: [[]] },
		{ dependencyGroups: [["h1", "h1"]] },
	])(
		"rejects invalid dependency groups $dependencyGroups",
		({ dependencyGroups }) => {
			const { prepared, review } = fixture();
			expect(() =>
				applyHistoryRetentionReview(prepared, { ...review, dependencyGroups }),
			).toThrow();
		},
	);

	it("still rejects stale and incomplete classifications", () => {
		const { prepared, review } = fixture();
		expect(() =>
			applyHistoryRetentionReview(prepared, {
				...review,
				sourceSetId: "stale",
			}),
		).toThrow();
		expect(() =>
			applyHistoryRetentionReview(prepared, {
				...review,
				deferSourceIds: ["h2"],
			}),
		).toThrow();
	});
});

describe("recorded reply dependencies", () => {
	it("restores a previously deferred outcome before reviewing its retained request", () => {
		const { context, scope, prepared, review } = fixture();
		const old = applyHistoryRetentionReview(prepared, {
			...review,
			dependencyGroups: [],
		});
		expect(old.retainedEventIds).toEqual(["history:0"]);
		const linked = prepareHistoryRetention(context, scope, old, "next", 3, [
			["history:0", "history:1"],
		]);
		expect(linked.candidates.map((source) => source.id)).toEqual(["h1", "h2"]);
		const next = applyHistoryRetentionReview(linked, {
			sourceSetId: linked.sourceSetId,
			complete: true,
			retainSourceIds: ["h1"],
			deferSourceIds: ["h2"],
			uncertainSourceIds: [],
			dependencyGroups: [],
		});
		expect(next.retainedEventIds).toEqual(["history:0", "history:1"]);
		expect(validateHistoryRetention(context, scope, old)).toEqual(old);
		expect(validateHistoryRetention(context, scope, next)).toEqual(next);
	});
	it("keeps transitive linked outcomes, but permits the whole completed exchange to be deferred", () => {
		const { context, scope, review } = fixture();
		const before = structuredClone(context);
		const linked = prepareHistoryRetention(context, scope, null, "linked", 3, [
			["history:0", "history:1"],
			["history:1", "history:2"],
			["history:2", "history:0"],
		]);
		const retained = applyHistoryRetentionReview(linked, {
			...review,
			sourceSetId: linked.sourceSetId,
			dependencyGroups: [],
		});
		expect(retained.retainedEventIds).toEqual([
			"history:0",
			"history:1",
			"history:2",
		]);
		const deferred = applyHistoryRetentionReview(linked, {
			...review,
			sourceSetId: linked.sourceSetId,
			retainSourceIds: [],
			deferSourceIds: ["h1", "h2", "h3"],
			dependencyGroups: [],
		});
		expect(deferred.retainedEventIds).toEqual([]);
		expect(context).toEqual(before);
	});
	it("binds the review to the recorded links and never pulls a later source into an earlier evidence page", () => {
		const { context, scope, prepared, review } = fixture();
		const linked = prepareHistoryRetention(
			context,
			scope,
			null,
			"evidence",
			3,
			[["history:0", "history:1"]],
		);
		expect(linked.sourceSetId).not.toBe(prepared.sourceSetId);
		expect(() => applyHistoryRetentionReview(linked, review)).toThrow();
		const future = prepareHistoryRetention(
			context,
			scope,
			null,
			"evidence",
			3,
			[["history:0", "history:3"]],
		);
		expect(future.candidates).toEqual(prepared.candidates);
		expect(future.linkedSourceGroups).toEqual([]);
	});
});

it("does not send unrelated deferred reply groups to the reviewer", () => {
	const { context, scope, prepared, review } = fixture();
	const old = applyHistoryRetentionReview(prepared, {
		...review,
		dependencyGroups: [],
	});
	const next = prepareHistoryRetention(context, scope, old, "next", 3, [
		["history:1", "history:2"],
	]);
	expect(next.candidates.map((source) => source.id)).toEqual(["h1"]);
	expect(next.linkedSourceGroups).toEqual([]);
});
