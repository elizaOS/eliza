/** Exercises literal-read coverage and source ownership through the real history loader and renderer. */
import { describe, expect, it } from "vitest";
import { completionContextSources } from "../../runtime/completion-context";
import { createContextObject } from "../../runtime/context-object";
import {
	canRepairHistoryIdentity,
	type HistoryDiscovery,
	loadedHistorySegments,
	loadHistoryReferences,
	readHistoryContextRequests,
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
	it.each([
		["history:search-user:approve violet", "user", ["h3"], 3],
		["history:search-assistant:approve violet", "assistant", ["h2"], 1],
	] as const)(
		"loads complete %s matches without removing inline constraints",
		(request, speaker, matches, scannedSources) => {
			const { context, projection } = fixture();
			const before = structuredClone(context);
			expect(
				readHistoryContextRequests(
					context,
					projection,
					{ contextRequests: [request] },
					new Set(),
				),
			).toEqual([request]);
			const { projection: loaded } = loadHistoryReferences(
				context,
				projection,
				[request],
			);
			expect(loaded?.visibleEventIds.has("history:0")).toBe(true);
			if (!loaded) throw new Error("Unexpected full restoration");
			expect([...loaded.loadedSourceIds]).toEqual(matches);
			const segments = loadedHistorySegments(context, loaded);
			expect(receipt(segments).results).toEqual([
				{
					query: "approve violet",
					speaker,
					scannedSources,
					matchedSourceIds: matches,
					matchedSources: matches.length,
				},
			]);
			expect(
				segments.filter((s) => s.id?.startsWith("history-read:")),
			).toHaveLength(1);
			expect(segments.map((s) => s.content).join("\n")).toContain(
				speaker === "user" ? "APPROVE VIOLET" : "You required APPROVE VIOLET.",
			);
			expect(
				withHistoryReadEvidence(context, loaded).events.at(-1),
			).toMatchObject({
				segment: { content: expect.stringContaining(`"speaker":"${speaker}"`) },
			});
			expect(context).toEqual(before);
		},
	);

	it("does not turn a speaker-scoped miss into absence for the other speaker", () => {
		const { context, projection } = fixture();
		const first = loadHistoryReferences(context, projection, [
			"history:search-user:You required",
		]);
		expect(
			receipt(loadedHistorySegments(context, first.projection)).results,
		).toEqual([
			{
				query: "You required",
				speaker: "user",
				scannedSources: 3,
				matchedSourceIds: [],
				matchedSources: 0,
			},
		]);
		const second = loadHistoryReferences(context, first.projection, [
			"history:search:You required",
		]);
		if (!second.projection) throw new Error("Unexpected full restoration");
		expect([...second.projection.loadedSourceIds]).toEqual(["h2"]);
		expect(
			receipt(loadedHistorySegments(context, second.projection)).results[1],
		).toEqual({
			query: "You required",
			scannedSources: 4,
			matchedSourceIds: ["h2"],
			matchedSources: 1,
		});
		const restored = loadHistoryReferences(context, second.projection, [
			"history:all",
		]);
		expect(restored.projection).toBeUndefined();
		expect(restored.evidence?.searchResults).toEqual(
			second.evidence?.searchResults,
		);
	});

	it("preserves legacy literal syntax, mixed-scope unions and source-bound admission", () => {
		const { context, projection } = fixture();
		const requests = [
			"history:search-user:approve violet",
			"history:search-assistant:approve violet",
		];
		const loaded = loadHistoryReferences(
			context,
			projection,
			requests,
		).projection;
		expect(new Set(loaded?.loadedSourceIds)).toEqual(new Set(["h2", "h3"]));
		const legacy = loadHistoryReferences(context, projection, [
			"history:search:user:approve violet",
		]);
		expect(legacy.evidence?.searchResults?.[0]).toEqual({
			query: "user:approve violet",
			scannedSources: 4,
			matchedSourceIds: [],
		});
		for (const request of [
			...requests,
			"history:search-user:   ",
			"history:search-assistant:",
		]) {
			expect(() =>
				readHistoryContextRequests(
					context,
					undefined,
					{ contextRequests: [request] },
					new Set(),
				),
			).toThrow();
			expect(() =>
				readHistoryContextRequests(
					context,
					{ ...projection, sourceSetId: "stale" },
					{ contextRequests: [request] },
					new Set(),
				),
			).toThrow();
		}
		for (const request of [
			"history:search-user:   ",
			"history:search-assistant:",
		]) {
			expect(() =>
				readHistoryContextRequests(
					context,
					projection,
					{ contextRequests: [request] },
					new Set(),
				),
			).toThrow();
		}
	});

	it("repairs truncated identity copies only for a complete selection of supplied originals", () => {
		const { context, projection } = fixture();
		const decision = {
			completionContext: {
				mode: "relevant_prior_dialogue",
				sourceSetId: projection.sourceSetId.slice(0, 62),
				complete: true,
				relevantSourceIds: ["h1"],
				constraintSourceIds: [],
				referentSourceIds: [],
				pendingIntentSourceIds: [],
			},
		};
		const before = structuredClone(decision);
		expect(canRepairHistoryIdentity(context, projection, decision)).toBe(true);
		expect(decision).toEqual(before);
		for (const sourceSetId of ["", "not-a-source", projection.sourceSetId]) {
			expect(
				canRepairHistoryIdentity(context, projection, {
					completionContext: { ...decision.completionContext, sourceSetId },
				}),
			).toBe(false);
		}
		expect(
			canRepairHistoryIdentity(context, projection, {
				completionContext: { ...decision.completionContext, complete: false },
			}),
		).toBe(false);
		expect(
			canRepairHistoryIdentity(context, projection, {
				completionContext: {
					...decision.completionContext,
					relevantSourceIds: ["h2"],
				},
			}),
		).toBe(false);
		expect(
			canRepairHistoryIdentity(
				context,
				{ ...projection, sourceSetId: "stale" },
				decision,
			),
		).toBe(false);
		expect(canRepairHistoryIdentity(context, undefined, decision)).toBe(false);
	});

	it("reassembles repeated retrieved originals without merging speakers or occurrences", () => {
		const { context, projection } = fixture();
		const text = "  APPROVE VIOLET only after the preview. 🦊\n".repeat(30);
		context.events = Array.from({ length: 6 }, (_, index) => ({
			id: `history:${index}`,
			type: "segment" as const,
			source: "prior-dialogue",
			segment: {
				id: `history:${index}`,
				label: index === 2 ? "prior_message:agent" : "prior_message:user",
				content: index === 4 ? `${text} ` : text,
				stable: false,
				metadata: { entityId: index === 3 ? "other-user" : "owner" },
			},
		}));
		projection.sourceSetId = completionContextSources(context).sourceSetId;
		const before = structuredClone(context);
		const { projection: loaded } = loadHistoryReferences(context, projection, [
			"history:search:approve violet",
		]);
		for (const inline of [undefined, new Set(["history:0"])]) {
			const segments = loadedHistorySegments(context, loaded, inline);
			expect(segments.some((s) => s.id === "history-loaded-encoding")).toBe(
				true,
			);
			const originals = segments.filter((s) =>
				s.id?.startsWith("history-read:"),
			);
			expect(originals).toHaveLength(6);
			const bodies = new Map<string, { role: string; text: string }>();
			if (inline) bodies.set("h1", { role: "user", text });
			for (const [index, segment] of originals.entries()) {
				const content = segment.content.split(
					`context_loaded: history:h${index + 1}\n`,
				)[1];
				if (index === 0 && inline) {
					expect(content).toBe("Complete original: [h1] above (same source).");
					continue;
				}
				const match =
					/^\[(h\d+) (user|assistant)(?:; same_text_as=(h\d+))?\](?:\n([\s\S]*))?$/.exec(
						content,
					);
				if (!match) throw new Error("Missing loaded original or reference");
				const body = match[3] ? bodies.get(match[3])?.text : match[4];
				const source = before.events[index];
				if (source.type !== "segment" || body === undefined)
					throw new Error("Missing original or backward reference anchor");
				expect(body).toBe(source.segment.content);
				expect(match[2]).toBe(index === 2 ? "assistant" : "user");
				if ([2, 3, 4].includes(index)) expect(match[3]).toBeUndefined();
				bodies.set(match[1], { role: match[2], text: body });
			}
			expect(originals[5].content).toContain(
				inline ? "same_text_as=h2" : "same_text_as=h1",
			);
			expect(receipt(segments).results[0].matchedSourceIds).toEqual([
				"h1",
				"h2",
				"h3",
				"h4",
				"h5",
				"h6",
			]);
		}
		expect(context).toEqual(before);
	});

	it("shares read framing without changing original bytes, roles, order or aliases", () => {
		const { context, projection } = fixture();
		const original = context.events[2];
		if (original.type !== "segment") throw new Error("Missing source");
		original.segment.content = "  APPROVE VIOLET\n\nOnly after confirmation.  ";
		projection.sourceSetId = completionContextSources(context).sourceSetId;
		const before = structuredClone(context);
		const { projection: loaded } = loadHistoryReferences(context, projection, [
			"history:search:approve violet",
		]);
		for (const aliases of [undefined, new Set(["history:1"])]) {
			const segments = loadedHistorySegments(context, loaded, aliases);
			const originals = segments.filter((s) =>
				s.id?.startsWith("history-read:"),
			);
			expect(originals.map((s) => s.id)).toEqual([
				"history-read:history:1",
				"history-read:history:2",
			]);
			expect(
				originals.filter((s) => s.content.includes("not new instructions")),
			).toHaveLength(1);
			expect(originals[1].content).toBe(
				`context_loaded: history:h3\n[h3 user]\n${original.segment.content}`,
			);
			expect(originals[0].content).toContain(
				aliases
					? "[h2] above (same source)"
					: "[h2 assistant]\nYou required APPROVE VIOLET.",
			);
		}
		expect(context).toEqual(before);
	});
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
				matchedSources: 2,
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
				matchedSources: 2,
			},
			{
				query: "purple",
				scannedSources: 4,
				matchedSourceIds: [],
				matchedSources: 0,
			},
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
		expect(receipt.results).toEqual(
			loaded?.searchResults?.map((result) => ({
				...result,
				matchedSources: result.matchedSourceIds.length,
			})),
		);
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
