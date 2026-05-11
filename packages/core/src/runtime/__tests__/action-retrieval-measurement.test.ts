import { describe, expect, it } from "vitest";
import { buildActionCatalog } from "../action-catalog";
import { retrieveActions } from "../action-retrieval";

const actions = [
	{
		name: "MUSIC",
		description:
			"Control music playback, songs, albums, playlists, and speakers.",
		similes: ["play music", "song controls"],
		tags: ["audio"],
		subActions: ["PLAY_TRACK"],
		contexts: ["media"],
	},
	{
		name: "PLAY_TRACK",
		description: "Play a requested song, album, artist, or playlist.",
		similes: ["start a song"],
		tags: ["music"],
	},
	{
		name: "CALENDAR",
		description: "Manage calendar events, meetings, schedules, and reminders.",
		similes: ["book a meeting", "schedule time"],
		tags: ["productivity"],
		subActions: ["CREATE_EVENT"],
		contexts: ["calendar"],
	},
	{
		name: "CREATE_EVENT",
		description: "Create a calendar event for a date, time, or attendee.",
		tags: ["calendar"],
	},
	{
		name: "EMAIL",
		description: "Read, draft, and send email messages to contacts.",
		similes: ["send mail"],
		tags: ["communication"],
		contexts: ["email"],
	},
];

describe("action-retrieval measurement mode", () => {
	it("does not emit measurement output when measurementMode is off (default)", () => {
		const catalog = buildActionCatalog(actions);
		const response = retrieveActions({
			catalog,
			messageText: "play some music",
		});

		expect(response.measurement).toBeUndefined();
	});

	it("produces identical results when measurementMode is off vs on", () => {
		const catalog = buildActionCatalog(actions);
		const off = retrieveActions({
			catalog,
			messageText: "schedule a meeting tomorrow",
		});
		const on = retrieveActions({
			catalog,
			messageText: "schedule a meeting tomorrow",
			measurementMode: true,
		});

		expect(on.results.map((r) => r.name)).toEqual(
			off.results.map((r) => r.name),
		);
		expect(on.results.map((r) => r.score)).toEqual(
			off.results.map((r) => r.score),
		);
	});

	it("captures per-stage scores under measurement mode", () => {
		const catalog = buildActionCatalog(actions);
		const response = retrieveActions({
			catalog,
			messageText: "schedule a meeting tomorrow",
			parentActionHints: ["calendar"],
			candidateActions: ["create_event"],
			measurementMode: true,
		});

		expect(response.measurement).toBeDefined();
		const measurement = response.measurement!;

		for (const stage of [
			"exact",
			"regex",
			"keyword",
			"bm25",
			"embedding",
			"contextMatch",
		] as const) {
			expect(Array.isArray(measurement.perStageScores[stage])).toBe(true);
		}

		// Exact-stage should contain CALENDAR because of the explicit hint.
		const exactEntry = measurement.perStageScores.exact.find(
			(e) => e.actionName === "CALENDAR",
		);
		expect(exactEntry).toBeDefined();
		expect(exactEntry?.rank).toBe(1);
		expect(exactEntry?.score).toBeGreaterThan(0);

		// BM25 picks up "schedule"/"meeting" tokens — CALENDAR should appear.
		const bm25Names = measurement.perStageScores.bm25.map((e) => e.actionName);
		expect(bm25Names).toContain("CALENDAR");

		// Ranks within a stage must be 1-based, dense, and monotonic.
		for (const stage of Object.values(measurement.perStageScores)) {
			for (let i = 0; i < stage.length; i += 1) {
				expect(stage[i].rank).toBe(i + 1);
			}
		}
	});

	it("emits a fused topK list sorted by RRF score descending", () => {
		const catalog = buildActionCatalog(actions);
		const response = retrieveActions({
			catalog,
			messageText: "send an email to alice",
			measurementMode: true,
		});

		expect(response.measurement?.fusedTopK).toBeDefined();
		const fused = response.measurement!.fusedTopK;
		expect(fused.length).toBeGreaterThan(0);
		// rrfScore must be non-increasing
		for (let i = 1; i < fused.length; i += 1) {
			expect(fused[i].rrfScore).toBeLessThanOrEqual(fused[i - 1].rrfScore);
		}
		// Ranks dense and 1-based
		for (let i = 0; i < fused.length; i += 1) {
			expect(fused[i].rank).toBe(i + 1);
		}
	});

	it("captures contextMatch stage entries when selectedContexts intersect", () => {
		const catalog = buildActionCatalog(actions);
		const response = retrieveActions({
			catalog,
			messageText: "remind me about my meeting",
			selectedContexts: ["calendar"],
			measurementMode: true,
		});

		const ctx = response.measurement!.perStageScores.contextMatch;
		const calendarEntry = ctx.find((e) => e.actionName === "CALENDAR");
		expect(calendarEntry).toBeDefined();
	});

	it("applies tierOverrides.topK to limit results", () => {
		const catalog = buildActionCatalog(actions);
		const wide = retrieveActions({
			catalog,
			messageText: "play music",
		});
		const capped = retrieveActions({
			catalog,
			messageText: "play music",
			tierOverrides: { topK: 2 },
		});
		expect(capped.results.length).toBe(2);
		// Top-2 by score from the unlimited call must match the capped top-2.
		expect(capped.results.map((r) => r.name)).toEqual(
			wide.results.slice(0, 2).map((r) => r.name),
		);
	});

	it("applies tierOverrides.stageWeights to RRF fusion", () => {
		const catalog = buildActionCatalog(actions);
		const baseline = retrieveActions({
			catalog,
			messageText: "schedule a meeting",
			measurementMode: true,
		});
		const heavyExact = retrieveActions({
			catalog,
			messageText: "schedule a meeting",
			parentActionHints: ["email"],
			tierOverrides: {
				stageWeights: { exact: 10 },
			},
			measurementMode: true,
		});

		// With a 10x weight on `exact` and EMAIL hinted explicitly, EMAIL must
		// out-rank CALENDAR in the heavyExact call even though BM25 still
		// favors CALENDAR.
		const heavyTopName = heavyExact.results[0]?.name;
		expect(heavyTopName).toBe("EMAIL");
		// Sanity: without the override, the BM25-favored CALENDAR wins.
		expect(baseline.results[0]?.name).toBe("CALENDAR");
	});
});
