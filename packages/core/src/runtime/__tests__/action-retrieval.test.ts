import { describe, expect, it } from "vitest";
import { buildActionCatalog } from "../action-catalog";
import { retrieveActions, tokenizeActionSearchText } from "../action-retrieval";

const actions = [
	{
		name: "MUSIC",
		description:
			"Control music playback, songs, albums, playlists, and speakers.",
		descriptionCompressed: "music playback",
		similes: ["play music", "song controls"],
		tags: ["audio"],
		subActions: [
			"PLAY_TRACK",
			{
				name: "PAUSE_MUSIC",
				description: "Pause or stop current playback.",
				tags: ["audio"],
			},
			"PLAY_TRACK",
			"MISSING_CHILD",
		],
		cacheStable: true,
		cacheScope: "agent",
	},
	{
		name: "PLAY_TRACK",
		description: "Play a requested song, album, artist, or playlist.",
		similes: ["start a song"],
		tags: ["music"],
		parameters: { query: "song name" },
	},
	{
		name: "CALENDAR",
		description:
			"Manage calendar events, meetings, schedules, dates, and reminders.",
		similes: ["book a meeting", "schedule time"],
		tags: ["productivity"],
		subActions: ["CREATE_EVENT"],
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
		subActions: ["SEND_EMAIL"],
	},
	{
		name: "SEND_EMAIL",
		description: "Send an email to a recipient with a subject and body.",
		tags: ["email"],
	},
];

describe("action catalogue and retrieval", () => {
	it("builds a deterministic parent/child catalogue and reports non-fatal warnings", () => {
		const catalog = buildActionCatalog(actions);

		expect(catalog.parents.map((parent) => parent.name)).toEqual([
			"CALENDAR",
			"EMAIL",
			"MUSIC",
		]);
		expect(catalog.parentByName.get("MUSIC")?.childNames).toEqual([
			"PAUSE_MUSIC",
			"PLAY_TRACK",
		]);
		expect(catalog.parentByName.get("MUSIC")?.cacheStable).toBe(true);
		expect(catalog.parentByName.get("MUSIC")?.cacheScope).toBe("agent");
		expect(catalog.warnings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "DUPLICATE_SUB_ACTION",
					parentName: "MUSIC",
					subActionName: "PLAY_TRACK",
				}),
				expect.objectContaining({
					code: "MISSING_SUB_ACTION",
					parentName: "MUSIC",
					subActionName: "MISSING_CHILD",
				}),
			]),
		);
	});

	it("applies exact parent hints as a score floor", () => {
		const catalog = buildActionCatalog(actions);
		const response = retrieveActions({
			catalog,
			messageText: "do the thing",
			parentActionHints: ["music"],
		});

		expect(response.results[0]).toMatchObject({
			name: "MUSIC",
			score: 1,
			matchedBy: expect.arrayContaining(["exact"]),
		});
	});

	it("matches candidate action namespaces and child names with regex scoring", () => {
		const catalog = buildActionCatalog(actions);
		const namespaceResponse = retrieveActions({
			catalog,
			candidateActions: ["calendar_*"],
		});
		const childResponse = retrieveActions({
			catalog,
			candidateActions: ["PLAY_TRACK"],
		});

		expect(namespaceResponse.results[0]).toMatchObject({
			name: "CALENDAR",
			score: expect.any(Number),
			matchedBy: expect.arrayContaining(["regex"]),
		});
		expect(namespaceResponse.results[0].score).toBeGreaterThanOrEqual(0.8);
		expect(childResponse.results[0]).toMatchObject({
			name: "MUSIC",
			matchedBy: expect.arrayContaining(["regex"]),
		});
		expect(childResponse.results[0].score).toBeGreaterThanOrEqual(0.8);
	});

	it("uses BM25 over message text plus candidate action terms", () => {
		const catalog = buildActionCatalog(actions);
		const response = retrieveActions({
			catalog,
			messageText: "book lunch with Ada on my calendar tomorrow",
			candidateActions: ["create event"],
		});

		expect(response.results[0]).toMatchObject({
			name: "CALENDAR",
			matchedBy: expect.arrayContaining(["bm25"]),
		});
		expect(response.results[0].score).toBeGreaterThanOrEqual(0.7);
	});

	it("uses reciprocal rank fusion and optional embedding scores only when provided", () => {
		const catalog = buildActionCatalog(actions);
		const response = retrieveActions({
			catalog,
			messageText: "write to shaw with a subject line",
			candidateActions: ["send_email"],
			embedding: {
				enabled: true,
				scoresByParentName: {
					EMAIL: 0.99,
				},
			},
		});

		expect(response.results[0]).toMatchObject({
			name: "EMAIL",
			matchedBy: expect.arrayContaining(["regex", "bm25", "embedding"]),
		});
		expect(response.results[0].rrfScore).toBeGreaterThan(0);
	});

	it("tokenizes action-like names, camelCase, and prose consistently", () => {
		expect(tokenizeActionSearchText("playMusic music_* send-email")).toEqual([
			"play",
			"music",
			"music",
			"send",
			"email",
		]);
	});
});
