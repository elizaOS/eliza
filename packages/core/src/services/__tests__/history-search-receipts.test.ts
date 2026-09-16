/** Exercises literal-read coverage and source ownership through the real history loader and renderer. */
import { describe, expect, it } from "vitest";
import { completionContextSources } from "../../runtime/completion-context";
import { createContextObject } from "../../runtime/context-object";
import {
	type HistoryDiscovery,
	loadedHistorySegments,
	loadHistoryReferences,
	requestedHistory,
	withHistoryReadEvidence,
} from "../message/history-discovery";

import { renderMessageHandlerModelInput } from "../message/stage1-input";

function fixture() {
	const context = createContextObject({
		id: "turn",
		metadata: { roomId: "room" },
		events: [
			[
				"prior_message:user",
				"Show the preview, then wait for separate confirmation.",
			],
			["prior_message:agent", "You required APPROVE VIOLET."],
			["prior_message:user", "APPROVE VIOLET"],
			["prior_message:user", "An unrelated exchange."],
		].map(([label, content], index) => ({
			id: `history:${index}`,
			type: "segment" as const,
			source: "prior-dialogue",
			segment: { id: `history:${index}`, label, content, stable: false },
		})),
	});
	const projection: HistoryDiscovery = {
		sourceSetId: completionContextSources(context).sourceSetId,
		scope: { agentId: "agent", roomId: "room", entityId: "owner", roles: [] },
		visibleEventIds: new Set(["history:0"]),
		loadedSourceIds: new Set(),
	};
	return { context, projection };
}
function receipt(segments: ReturnType<typeof loadedHistorySegments>) {
	const text = segments.find(
		(s) => s.id === "history-literal-search-results",
	)?.content;
	if (!text) throw new Error("Missing literal search receipt");
	return JSON.parse(
		text.split("\n")[0].replace("history_literal_search_results: ", ""),
	);
}
describe("history literal search receipts", () => {
	it("reports all matches without merging assistant claims and user occurrences", () => {
		const { context, projection } = fixture();
		const before = structuredClone(context);
		const { projection: loaded } = loadHistoryReferences(context, projection, [
			"history:search:approve violet",
		]);
		const segments = loadedHistorySegments(context, loaded);
		expect(receipt(segments).results).toEqual([
			{
				query: "approve violet",
				scannedSources: 4,
				matchedSourceIds: ["h2", "h3"],
			},
		]);
		if (!loaded) throw new Error("Unexpected full-history fallback");
		expect([...loaded.loadedSourceIds]).toEqual(["h2", "h3"]);
		expect(
			segments.find((s) => s.content.includes("[h2 assistant]"))?.content,
		).toContain("You required APPROVE VIOLET.");
		expect(
			segments.find((s) => s.content.includes("[h3 user]"))?.content,
		).toContain("APPROVE VIOLET");
		expect(context).toEqual(before);
		expect(projection.loadedSourceIds.size).toBe(0);
	});
	it("distinguishes a literal miss from successful searches in the same read", () => {
		const { context, projection } = fixture();
		const { projection: loaded } = loadHistoryReferences(context, projection, [
			"history:search:approve violet",
			"history:search:purple",
		]);
		expect(receipt(loadedHistorySegments(context, loaded)).results).toEqual([
			{
				query: "approve violet",
				scannedSources: 4,
				matchedSourceIds: ["h2", "h3"],
			},
			{ query: "purple", scannedSources: 4, matchedSourceIds: [] },
		]);
	});
	it("carries completed reads into fresh planner context without rewriting sources", () => {
		const { context, projection } = fixture();
		const before = structuredClone(context);
		const { projection: loaded } = loadHistoryReferences(context, projection, [
			"history:search:approve violet",
			"history:search:purple",
		]);
		const planned = withHistoryReadEvidence(context, loaded);
		expect(planned.events).toHaveLength(context.events.length + 1);
		const evidence = planned.events.at(-1);
		if (evidence?.type !== "segment")
			throw new Error("Missing search evidence");
		const receipt = JSON.parse(
			evidence.segment.content
				.split("\n")[0]
				.replace("Completed current-turn conversation reads: ", ""),
		);
		expect(receipt.results).toEqual(loaded?.searchResults);
		expect(receipt.results[0].matchedSourceIds).toEqual(["h2", "h3"]);
		expect(receipt.results[1].matchedSourceIds).toEqual([]);
		expect(completionContextSources(planned)).toEqual(
			completionContextSources(context),
		);
		expect(context).toEqual(before);
		for (const changed of [
			createContextObject({ ...context, id: "another-turn" }),
			createContextObject({ ...context, metadata: { roomId: "another-room" } }),
			createContextObject({ ...context, events: context.events.slice(0, 1) }),
		])
			expect(withHistoryReadEvidence(changed, loaded)).toBe(changed);
	});

	it("preserves completed searches when full history is requested in the same or later read", () => {
		const { context, projection } = fixture();
		const requests = requestedHistory(
			context,
			projection,
			null,
			["history:search:approve violet", "history:all"],
			true,
		);
		expect(requests).toEqual(["history:search:approve violet", "history:all"]);
		const searched = loadHistoryReferences(context, projection, [
			"history:search:approve violet",
		]);
		for (const restored of [
			loadHistoryReferences(context, projection, requests),
			loadHistoryReferences(context, searched.projection, ["history:all"]),
			loadHistoryReferences(context, searched.projection, [
				"history:search:required APPROVE VIOLET",
			]),
		]) {
			expect(restored.projection).toBeUndefined();
			const input = renderMessageHandlerModelInput(
				{ character: { name: "Eliza" } },
				context,
				[],
				{
					directMessage: true,
					history: restored.projection,
					historyReadEvidence: restored.evidence,
				},
			);
			expect(
				input.promptSegments.find(
					(segment) => segment.id === "history-literal-search-results",
				)?.content,
			).toContain('"matchedSourceIds":["h2","h3"]');
			expect(
				input.promptSegments.some((segment) =>
					segment.id?.startsWith("history-read:"),
				),
			).toBe(false);

			expect(restored.evidence?.searchResults?.[0].matchedSourceIds).toEqual([
				"h2",
				"h3",
			]);
			const full = withHistoryReadEvidence(context, restored.evidence);
			expect(completionContextSources(full)).toEqual(
				completionContextSources(context),
			);
			expect(full.events).toHaveLength(context.events.length + 1);
		}
		const changed = createContextObject({ ...context, id: "other-turn" });
		expect(
			loadHistoryReferences(changed, searched.projection, ["history:all"]),
		).toEqual({});
	});

	it("rejects stale receipts and preserves full fallback for no-progress reads", () => {
		const { context, projection } = fixture();
		const { projection: loaded } = loadHistoryReferences(context, projection, [
			"history:search:approve violet",
		]);
		expect(
			loadHistoryReferences(context, loaded, [
				"history:search:required APPROVE VIOLET",
			]).projection,
		).toBeUndefined();
		expect(
			loadHistoryReferences(context, loaded, ["history:all"]).projection,
		).toBeUndefined();
		const changed = createContextObject({
			...context,
			events: context.events.slice(0, 2),
		});
		expect(loadedHistorySegments(changed, loaded)).toEqual([]);
	});
});
