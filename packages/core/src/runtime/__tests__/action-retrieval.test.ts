import { describe, expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../actions/promote-subactions";
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

	it("groups promoted virtual subactions under their umbrella parent", () => {
		const [parent, ...virtuals] = promoteSubactionsToActions({
			name: "PAYMENT",
			description:
				"Create, deliver, verify, settle, await, and cancel payments.",
			parameters: [
				{
					name: "action",
					description: "Payment operation.",
					required: true,
					schema: {
						type: "string",
						enum: ["create_request", "deliver_link", "settle"],
					},
				},
			],
			validate: async () => true,
			handler: async () => ({ success: true }),
		});
		const catalog = buildActionCatalog([parent, ...virtuals]);

		expect(catalog.parents.map((entry) => entry.name)).toEqual(["PAYMENT"]);
		expect(catalog.parentByName.get("PAYMENT")?.childNames).toEqual([
			"PAYMENT_CREATE_REQUEST",
			"PAYMENT_DELIVER_LINK",
			"PAYMENT_SETTLE",
		]);

		const response = retrieveActions({
			catalog,
			candidateActions: ["PAYMENT_SETTLE"],
		});

		expect(response.results[0]).toMatchObject({
			name: "PAYMENT",
			matchedBy: expect.arrayContaining(["regex"]),
		});
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

		// NOTE: bun's `toMatchObject` with `expect.any(Number)` leaves residual
		// matcher state that breaks the following `toBeGreaterThanOrEqual`. Use
		// explicit name/matchedBy checks plus direct numeric comparisons.
		expect(namespaceResponse.results[0].name).toBe("CALENDAR");
		expect(namespaceResponse.results[0].matchedBy).toEqual(
			expect.arrayContaining(["regex"]),
		);
		expect(typeof namespaceResponse.results[0].score).toBe("number");
		expect(namespaceResponse.results[0].score).toBeGreaterThanOrEqual(0.8);
		expect(childResponse.results[0].name).toBe("MUSIC");
		expect(childResponse.results[0].matchedBy).toEqual(
			expect.arrayContaining(["regex"]),
		);
		expect(typeof childResponse.results[0].score).toBe("number");
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

	it("uses external i18n keyword matches as a retrieval signal", () => {
		const catalog = buildActionCatalog([
			{
				name: "CREATE_TASK",
				description: "Create scheduled user work.",
				contexts: ["tasks"],
			},
			{
				name: "EMAIL",
				description: "Read, draft, and send email messages to contacts.",
				contexts: ["email"],
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "remind me to stretch every day",
		});

		expect(response.results[0]).toMatchObject({
			name: "CREATE_TASK",
			matchedBy: expect.arrayContaining(["keyword"]),
		});
		expect(response.results[0].stageScores.keyword).toBeGreaterThan(0);
	});

	it("does not retrieve actions from context match alone", () => {
		const catalog = buildActionCatalog([
			{
				name: "MUSIC",
				description: "Control music playback.",
				contexts: ["music"],
			},
			{
				name: "EMAIL",
				description: "Read, draft, and send email.",
				contexts: ["email"],
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "please play the new album",
			candidateActions: ["play_music"],
			selectedContexts: ["email"],
		});
		const email = response.results.find((result) => result.name === "EMAIL");

		expect(email).toMatchObject({
			score: 0,
			matchedBy: [],
		});
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
