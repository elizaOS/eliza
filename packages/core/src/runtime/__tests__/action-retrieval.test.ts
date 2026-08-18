/**
 * Deterministic action catalogue assembly and multi-stage retrieval:
 * buildActionCatalog's parent/child grouping (with non-fatal duplicate/missing
 * sub-action warnings and virtual-subaction promotion) and retrieveActions'
 * scoring stages — exact parent hints, regex over candidate namespaces/child
 * names, BM25, the external i18n keyword signal, RRF fusion with optional
 * embeddings, and recent-conversation gating for continuation-shaped turns.
 * No model or embeddings; scores are computed from the in-memory catalog.
 */
import { describe, expect, it } from "vitest";
import { promoteSubactionsToActions } from "../../actions/promote-subactions";
import { searchMessagesAction } from "../../features/messaging/triage/actions/searchMessages";
import { buildActionCatalog } from "../action-catalog";
import {
	parentAliasesForCandidateAction,
	retrieveActions,
	stripControlBlockMarkers,
	tokenizeActionSearchText,
} from "../action-retrieval";

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

	it("resolves wildcard candidate hints against child action names (#20467)", () => {
		// normalizeActionName strips "*" before the wildcard branch ran, and the
		// escape/replace pair searched for a "\*" that was never produced, so
		// "GMAIL_*" compiled to ^GMAIL$ and matched nothing it was meant to.
		const [parent, ...virtuals] = promoteSubactionsToActions({
			name: "GMAIL",
			description: "Send mail, and create or update drafts.",
			parameters: [
				{
					name: "action",
					description: "Gmail operation.",
					required: true,
					schema: {
						type: "string",
						enum: ["send", "create_draft"],
					},
				},
			],
			validate: async () => true,
			handler: async () => ({ success: true }),
		});
		const catalog = buildActionCatalog([
			parent,
			...virtuals,
			{ name: "CALENDAR", description: "Manage calendar events." },
		]);

		for (const hint of ["GMAIL_*", "gmail-*", "GMAIL_*_DRAFT", "*_DRAFT"]) {
			const response = retrieveActions({
				catalog,
				candidateActions: [hint],
			});
			expect(response.results[0]).toMatchObject({
				name: "GMAIL",
				matchedBy: expect.arrayContaining(["regex"]),
			});
			expect(
				response.results.some(
					(entry) =>
						entry.name === "CALENDAR" && entry.matchedBy.includes("regex"),
				),
			).toBe(false);
		}
	});

	it("keeps a separator-less trailing wildcard anchored to its own name (#20467 review)", () => {
		// "GMAIL_SEND*" means "that action and anything under it": it must match
		// the exact anchored name (zero wildcard characters) AND its extensions,
		// and the separator-less "GMAIL*" spelling is the one that may reach a
		// GMAILSYNC sibling — the user wrote no separator to forbid it.
		const catalog = buildActionCatalog([
			{ name: "GMAIL_SEND", description: "Send a mail message." },
			{ name: "GMAIL_SEND_LATER", description: "Schedule a mail message." },
			{ name: "GMAILSYNC", description: "Synchronize the mail archive." },
			{ name: "CALENDAR", description: "Manage calendar events." },
		]);
		const creditedBy = (hint: string) =>
			retrieveActions({ catalog, candidateActions: [hint] })
				.results.filter((entry) => entry.matchedBy.includes("regex"))
				.map((entry) => entry.name)
				.sort();

		expect(creditedBy("GMAIL_SEND*")).toEqual([
			"GMAIL_SEND",
			"GMAIL_SEND_LATER",
		]);
		expect(creditedBy("GMAIL*")).toEqual([
			"GMAILSYNC",
			"GMAIL_SEND",
			"GMAIL_SEND_LATER",
		]);
		expect(creditedBy("*SYNC")).toEqual(["GMAILSYNC"]);
	});

	it("keeps a wildcard's adjacent underscore from swallowing sibling namespaces (#20467)", () => {
		// A normalized separator ahead of the wildcard is load-bearing in the
		// compiled pattern: neither "GMAIL_*" nor "GMAIL *" may translate to
		// ^GMAIL.*$ and wrongly claim GMAILSYNC or its children.
		const catalog = buildActionCatalog([
			{ name: "GMAIL_SEND", description: "Send a mail message." },
			{ name: "GMAILSYNC", description: "Synchronize the mail archive." },
			{ name: "CALENDAR", description: "Manage calendar events." },
		]);
		const creditedBy = (hint: string) =>
			retrieveActions({ catalog, candidateActions: [hint] })
				.results.filter((entry) => entry.matchedBy.includes("regex"))
				.map((entry) => entry.name);

		expect(creditedBy("GMAIL_*")).toEqual(["GMAIL_SEND"]);
		expect(creditedBy("  GMAIL *  ")).toEqual(["GMAIL_SEND"]);
	});

	it("preserves a separator-only literal between wildcards (#20467 review)", () => {
		const catalog = buildActionCatalog([
			{
				name: "GMAIL_CREATE_DRAFT",
				description: "Create a Gmail draft.",
			},
			{
				name: "GMAILCREATEDRAFT",
				description: "A sibling without normalized separators.",
			},
		]);
		const creditedBy = (hint: string) =>
			retrieveActions({ catalog, candidateActions: [hint] })
				.results.filter((entry) => entry.matchedBy.includes("regex"))
				.map((entry) => entry.name);

		expect(creditedBy("GMAIL* *DRAFT")).toEqual(["GMAIL_CREATE_DRAFT"]);
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

	it("normalizes simile candidate hints before resolving catalog parents", () => {
		// Stage-1 producers may use lower- or camel-cased spellings while action
		// metadata remains canonical. Both must resolve through the same exact-hint
		// path rather than falling through to unrelated keyword matches.
		const catalog = buildActionCatalog([
			{
				name: "SHELL",
				description: "Run a shell command on the host.",
				similes: ["BASH", "EXEC", "RUN_COMMAND"],
				tags: ["system"],
			},
			...actions,
		]);
		for (const candidateAction of ["bash", "runCommand"]) {
			const response = retrieveActions({
				catalog,
				messageText: "how much disk space is left on the server",
				candidateActions: [candidateAction],
			});
			expect(response.results[0]).toMatchObject({
				name: "SHELL",
				matchedBy: expect.arrayContaining(["exact"]),
			});
		}
	});

	it("routes invented document candidate names to the DOCUMENT parent", () => {
		const catalog = buildActionCatalog([
			{
				name: "DOCUMENT",
				description: "List, search, and read stored documents.",
				similes: ["search documents", "read document", "list documents"],
			},
			...actions,
		]);
		for (const candidateAction of [
			"DOCUMENT_SEARCH",
			"SEARCH_DOCUMENT",
			"READ_DOCUMENTS",
			"GET_DOCUMENTS",
		]) {
			const response = retrieveActions({
				catalog,
				messageText: "what documents do i have",
				candidateActions: [candidateAction],
			});
			expect(response.results[0]).toMatchObject({
				name: "DOCUMENT",
				matchedBy: expect.arrayContaining(["exact"]),
			});
		}
	});

	it("drops a simile claimed by multiple parents instead of first-writer-wins (#16561)", () => {
		// The live collision this locks: LIST_FILES was a simile on BOTH the
		// coding-tools FILE action and the stored-media FILES action; catalog
		// order is alphabetical, so the earlier parent silently stole the
		// other's intent. An ambiguous simile must not route at all — the
		// planner then falls back to keyword/BM25 scoring over both parents.
		const catalog = buildActionCatalog([
			{
				name: "FILE",
				description: "Read, write, edit, grep, glob, or list files.",
				similes: ["LIST_FILES"],
				tags: ["files"],
			},
			{
				name: "FILES",
				description: "List, get, or delete stored media files.",
				similes: ["LIST_FILES", "RECENT_FILES"],
				tags: ["media"],
			},
			...actions,
		]);
		const response = retrieveActions({
			catalog,
			messageText: "totally unrelated message",
			candidateActions: ["LIST_FILES"],
		});
		// Neither parent may claim the ambiguous hint via the exact stage.
		for (const result of response.results) {
			if (result.name === "FILE" || result.name === "FILES") {
				expect(result.matchedBy).not.toContain("exact");
			}
		}
		// An unambiguous simile on the same parents still routes normally.
		const unambiguous = retrieveActions({
			catalog,
			messageText: "totally unrelated message",
			candidateActions: ["RECENT_FILES"],
		});
		expect(unambiguous.results[0]).toMatchObject({
			name: "FILES",
			matchedBy: expect.arrayContaining(["exact"]),
		});
	});

	it("resolves a child simile hint to the child's parent", () => {
		const catalog = buildActionCatalog([
			{
				name: "TASKS",
				description: "Manage coding agent task sessions.",
				subActions: ["SEND_PROMPT"],
			},
			{
				name: "SEND_PROMPT",
				description: "Send a follow-up prompt to a running session.",
				similes: ["SEND_TO_AGENT"],
			},
			...actions,
		]);
		const response = retrieveActions({
			catalog,
			messageText: "pass this along",
			candidateActions: ["SEND_TO_AGENT"],
		});
		expect(response.results[0]).toMatchObject({
			name: "TASKS",
			matchedBy: expect.arrayContaining(["exact"]),
		});
	});

	it("does not let a simile hijack a real parent name", () => {
		// EMAIL exists as a real parent; a MUSIC simile spelled "EMAIL" must not
		// reroute an EMAIL candidate hint to MUSIC.
		const catalog = buildActionCatalog([
			{
				name: "MUSIC2",
				description: "Control playback.",
				similes: ["EMAIL"],
			},
			...actions,
		]);
		const response = retrieveActions({
			catalog,
			messageText: "message my contact",
			candidateActions: ["email"],
		});
		expect(response.results[0]?.name).toBe("EMAIL");
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

	it("treats a canonical candidate parent as an exact hint", () => {
		const catalog = buildActionCatalog([
			{
				name: "CALENDAR",
				description:
					"Manage calendar events, meetings, schedules, dates, times, and reminders.",
			},
			{
				name: "OWNER_REMINDERS",
				description: "Create and manage exact-time owner reminders.",
			},
		]);

		for (const messageText of [
			"remind me in 2 minutes to check the mail",
			"remind me at 9pm to check the oven",
		]) {
			const response = retrieveActions({
				catalog,
				messageText,
				candidateActions: ["owner reminders"],
			});

			expect(response.query.parentActionHints).toEqual(["owner reminders"]);
			expect(response.results[0]).toMatchObject({
				name: "OWNER_REMINDERS",
				score: 1,
				matchedBy: expect.arrayContaining(["exact"]),
			});
			expect(
				response.results.findIndex(
					(result) => result.name === "OWNER_REMINDERS",
				),
			).toBeLessThan(
				response.results.findIndex((result) => result.name === "CALENDAR"),
			);
		}

		const appointment = retrieveActions({
			catalog,
			messageText: "add a dentist appointment Thursday at 2pm",
			candidateActions: ["CALENDAR"],
		});
		expect(appointment.results[0]).toMatchObject({
			name: "CALENDAR",
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

	it("does not let prior standalone requests dominate current-turn action search", () => {
		const catalog = buildActionCatalog([
			{
				name: "TASKS",
				description: "Build apps, websites, code projects, and files.",
			},
			{
				name: "SHELL",
				description: "Run local shell commands and inspect runtime logs.",
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "Can you tell me what elizaOS is?",
			recentConversationText: [
				"Code me an app showing how good gpt oss is",
				"What is the price of bitcoin right now?",
			],
		});

		expect(
			response.results.find((result) => result.name === "TASKS"),
		).toMatchObject({
			score: 0,
			matchedBy: [],
		});
	});

	it("does not use recent conversation for short standalone turns", () => {
		const catalog = buildActionCatalog([
			{
				name: "TASKS",
				description: "Build apps, websites, code projects, and files.",
			},
		]);

		for (const messageText of ["what is elizaOS?", "thanks"]) {
			const response = retrieveActions({
				catalog,
				messageText,
				recentConversationText: "Code me an app showing how good gpt oss is",
			});

			expect(
				response.results.find((result) => result.name === "TASKS"),
			).toMatchObject({
				score: 0,
				matchedBy: [],
			});
		}
	});

	it("uses recent conversation for continuation-shaped current turns", () => {
		const catalog = buildActionCatalog([
			{
				name: "TASKS",
				description: "Build apps, websites, code projects, and files.",
			},
			{
				name: "SHELL",
				description: "Run local shell commands and inspect runtime logs.",
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "Do that again",
			recentConversationText: "Code me an app showing how good gpt oss is",
		});

		expect(response.results[0]).toMatchObject({
			name: "TASKS",
			matchedBy: expect.arrayContaining(["bm25"]),
		});
	});

	it("still uses recent conversation for continuation turns with candidate hints", () => {
		const catalog = buildActionCatalog([
			{
				name: "TASKS",
				description: "Build apps, websites, code projects, and files.",
			},
			{
				name: "MUSIC",
				description: "Control music playback.",
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "Do that again",
			candidateActions: ["play_music"],
			recentConversationText: "Build a small app with a button",
		});

		expect(response.results[0]).toMatchObject({
			name: "TASKS",
			matchedBy: expect.arrayContaining(["bm25"]),
		});
	});

	it("maps SEARCH_MESSAGES candidate hints to MESSAGE even when recent context is searched", () => {
		const catalog = buildActionCatalog([
			searchMessagesAction,
			{
				name: "TASKS",
				description: "Build apps, websites, code projects, and files.",
			},
			{
				name: "SHELL",
				description: "Run local shell commands and inspect files.",
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "Can you find that in the chat again?",
			candidateActions: ["SEARCH_MESSAGES"],
			recentConversationText:
				"Build a small app and inspect the project files.",
		});

		expect(response.query.parentActionHints).toEqual(["MESSAGE"]);
		expect(response.results[0]).toMatchObject({
			name: "MESSAGE",
			score: 1,
			matchedBy: expect.arrayContaining(["exact"]),
		});
		expect(searchMessagesAction.similes).toContain("SEARCH_MESSAGES");
		expect(searchMessagesAction.similes).toContain("MESSAGE_SEARCH");
		expect(searchMessagesAction.similes).toContain("SEARCH_CHAT");
		expect(searchMessagesAction.similes).toContain("FIND_MESSAGES");
	});

	it("maps all message-search simile hints to MESSAGE with recent context", () => {
		const catalog = buildActionCatalog([
			searchMessagesAction,
			{
				name: "TASKS",
				description: "Build apps, websites, code projects, and files.",
			},
		]);

		for (const candidateAction of [
			"SEARCH_INBOX",
			"SEARCH_EMAIL",
			"CROSS_CHANNEL_SEARCH",
		]) {
			const response = retrieveActions({
				catalog,
				messageText: "Search there again",
				candidateActions: [candidateAction],
				recentConversationText: "Find email and chat history about launch",
			});

			expect(response.query.parentActionHints).toEqual(["MESSAGE"]);
			expect(response.results[0]).toMatchObject({
				name: "MESSAGE",
				score: 1,
				matchedBy: expect.arrayContaining(["exact"]),
			});
		}
	});

	it("maps synthetic goal candidate hints to the owner goals parent", () => {
		const catalog = buildActionCatalog([
			{
				name: "OWNER_GOALS",
				description:
					"Owner goals: create, update, delete, and review long-horizon goals.",
				contexts: ["goals"],
			},
			{
				name: "SCHEDULED_TASKS",
				description: "Low-level scheduled item administration.",
				contexts: ["tasks"],
			},
		]);

		for (const candidateAction of ["GOAL_SAVE", "CREATE_SAVINGS_PLAN"]) {
			const response = retrieveActions({
				catalog,
				messageText:
					candidateAction === "GOAL_SAVE"
						? "Yes, save it."
						: "I want to save money for a trip.",
				candidateActions: [candidateAction],
				selectedContexts: ["goals"],
			});

			expect(response.query.parentActionHints).toEqual(["OWNER_GOALS"]);
			expect(response.results[0]).toMatchObject({
				name: "OWNER_GOALS",
				score: 1,
				matchedBy: expect.arrayContaining(["exact"]),
			});
		}
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

	// #14622: Stage-1 invents varied synthetic names for a permission grant/revoke
	// ("revoke network access for the weather app"). They must hint the SETTINGS
	// writer, and — because SET/APP tokens otherwise trip the view heuristic —
	// SETTINGS must win over VIEWS so the write is not routed to navigation.
	it("routes app/OS permission candidate names to the SETTINGS parent", () => {
		for (const candidate of [
			"REVOKE_NETWORK_ACCESS",
			"GRANT_NETWORK_ACCESS",
			"SET_APP_NETWORK_PERMISSION",
			"REVOKE_APP_PERMISSION",
			"UPDATE_APP_PERMISSION",
			"GRANT_FILESYSTEM_ACCESS",
			"REVOKE_SHELL_ACCESS",
			"REQUEST_CAMERA_PERMISSION",
		]) {
			expect(parentAliasesForCandidateAction(candidate)).toEqual(["SETTINGS"]);
		}
	});

	// Observed coding/repo inventions route to the TASKS coding umbrella. Keep
	// this mapping explicit: generic CODE, PR, COMMIT, and BRANCH tokens are
	// ambiguous and must not admit the coding surface on their own.
	it("routes observed coding candidates to TASKS without broad token guessing", () => {
		for (const candidate of [
			"CODE_EDIT",
			"CODE_PR_CREATE",
			"CREATE_PR",
			"OPEN_PULL_REQUEST",
			"FIX_BUG",
			"UPDATE_REPO_README",
			"GITHUB_ISSUE_FIX",
			"COMMIT_CHANGES",
			"CREATE_BRANCH",
		]) {
			expect(parentAliasesForCandidateAction(candidate)).toEqual(["TASKS"]);
		}
		for (const unrelatedCandidate of [
			"SCAN_QR_CODE",
			"READ_ERROR_CODE",
			"BANK_BRANCH",
			"PUBLIC_RELATIONS_PR",
			"COMMITMENT_STATUS",
		]) {
			expect(parentAliasesForCandidateAction(unrelatedCandidate)).not.toContain(
				"TASKS",
			);
		}
	});

	// Habit/reminder-shaped invented names must hint the owner-life umbrella AND
	// the TRIGGER scheduler, so deployments without plugin-personal-assistant
	// keep the only real scheduled-work capability on the planner surface.
	it("hints habit/routine candidates at OWNER_ROUTINES and TRIGGER", () => {
		for (const candidate of [
			"ADD_HABIT",
			"CREATE_HABIT",
			"CREATE_ROUTINE",
			"DAILY_HABIT",
			"HABIT_CREATE",
			"NEW_HABIT",
			"SAVE_HABIT",
			"SET_HABIT",
			"TRACK_HABIT",
		]) {
			expect(parentAliasesForCandidateAction(candidate)).toEqual([
				"OWNER_ROUTINES",
				"TRIGGER",
			]);
		}
		// Lookup is keyed on the normalized UPPER_SNAKE form: camelCase and
		// spaced/mixed-case emissions hit the same rows.
		expect(parentAliasesForCandidateAction("setHabit")).toEqual([
			"OWNER_ROUTINES",
			"TRIGGER",
		]);
	});

	// Stage-1 recall candidates must resolve to the MEMORY umbrella: the
	// classifier emits RECALL_MEMORY for "who is X" recalls, and when the name
	// resolved to nothing the turn paid a full extra planner round to
	// rediscover MEMORY op:search (live sol-dev 2026-08-17/18,
	// gate=resolved-to-no-runtime-action).
	it("hints memory-recall candidates at the MEMORY umbrella", () => {
		for (const candidate of [
			"RECALL_MEMORY",
			"RECALL_MEMORIES",
			"MEMORY_RECALL",
			"MEMORY_SEARCH",
			"SEARCH_MEMORIES",
			"CHECK_MEMORY",
		]) {
			expect(parentAliasesForCandidateAction(candidate)).toEqual(["MEMORY"]);
		}
		expect(parentAliasesForCandidateAction("recall memory")).toEqual([
			"MEMORY",
		]);
	});

	it("hints reminder candidates at OWNER_REMINDERS and TRIGGER", () => {
		for (const candidate of [
			"ADD_REMINDER",
			"CREATE_REMINDER",
			"DAILY_REMINDER",
			"NEW_REMINDER",
			"RECURRING_REMINDER",
			"REMINDER_CREATE",
		]) {
			expect(parentAliasesForCandidateAction(candidate)).toEqual([
				"OWNER_REMINDERS",
				"TRIGGER",
			]);
		}
		expect(parentAliasesForCandidateAction("create reminder")).toEqual([
			"OWNER_REMINDERS",
			"TRIGGER",
		]);
	});

	// Todo-shaped invented names must hint both todo owners: the
	// personal-assistant umbrella and plugin-todos' TODO parent. Deployments
	// load one or the other; the resolver keeps whichever is registered.
	it("hints todo candidates at OWNER_TODOS and TODO", () => {
		for (const candidate of [
			"ADD_TODO",
			"CREATE_TODO",
			"TODO_CREATE",
			"TODOS_CREATE",
			"TODO_ADD",
			"NEW_TODO",
			"SAVE_TODO",
			"TODOS",
			"TODO_LIST",
			"LIST_TODOS",
			"GET_TODOS",
			"SHOW_TODOS",
			"READ_TODOS",
			"USER_TODOS_READ",
			"COMPLETE_TODO",
			"TODO_COMPLETE",
			"DELETE_TODO",
			"REMOVE_TODO",
		]) {
			expect(parentAliasesForCandidateAction(candidate)).toEqual([
				"OWNER_TODOS",
				"TODO",
			]);
		}
		// Bare TODO hints only the owner umbrella: when plugin-todos is loaded
		// its TODO action resolves directly by name before aliases apply.
		expect(parentAliasesForCandidateAction("TODO")).toEqual(["OWNER_TODOS"]);
	});

	it("retains both registered todo owners through production retrieval", () => {
		const catalog = buildActionCatalog([
			{
				name: "OWNER_TODOS",
				description: "Manage the owner's private LifeOps todos.",
			},
			{
				name: "TODO",
				description: "Manage the current user's standalone todo list.",
			},
		]);

		for (const candidate of ["CREATE_TODO", "TODOS_CREATE"]) {
			const response = retrieveActions({
				catalog,
				messageText: "add a todo to buy milk",
				candidateActions: [candidate],
			});

			expect(response.query.parentActionHints).toEqual(["OWNER_TODOS", "TODO"]);
			expect(response.results.map((result) => result.name)).toEqual(
				expect.arrayContaining(["OWNER_TODOS", "TODO"]),
			);
		}
	});

	it("does not route non-financial budget language to owner finances", () => {
		const catalog = buildActionCatalog([
			{
				name: "OWNER_FINANCES",
				description: "Manage the owner's private financial records.",
			},
			{
				name: "REPLY",
				description:
					"Reply to the user within the requested response constraints.",
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "keep this response within the token budget",
			candidateActions: ["BUDGET"],
		});

		expect(response.query.parentActionHints).not.toContain("OWNER_FINANCES");
		expect(response.results[0]?.name).toBe("REPLY");
	});

	it("hints alarm candidates at OWNER_ALARMS and TRIGGER", () => {
		for (const candidate of [
			"ADD_ALARM",
			"SET_ALARM",
			"CREATE_ALARM",
			"ALARM_CREATE",
			"WAKE_ME_UP",
		]) {
			expect(parentAliasesForCandidateAction(candidate)).toEqual([
				"OWNER_ALARMS",
				"TRIGGER",
			]);
		}
	});

	it("hints finance candidates at OWNER_FINANCES", () => {
		for (const candidate of [
			"FINANCE",
			"SPENDING",
			"SPENDING_SUMMARY",
			"EXPENSES",
		]) {
			expect(parentAliasesForCandidateAction(candidate)).toEqual([
				"OWNER_FINANCES",
			]);
		}
	});

	it("leaves non-permission candidates off the SETTINGS parent", () => {
		// A bare person-scoped access revoke is BLOCK, not a settings write; view /
		// app surface candidates keep their existing VIEWS/APP hints untouched.
		expect(parentAliasesForCandidateAction("REVOKE_ACCESS")).toEqual([]);
		expect(parentAliasesForCandidateAction("OPEN_APP")).toEqual([
			"VIEWS",
			"APP",
		]);
		expect(parentAliasesForCandidateAction("LAUNCH_APP")).toEqual(["APP"]);
	});
});

describe("canonical OWNER_* fallbacks for non-PA topologies", () => {
	// The stage-1 routing floor names OWNER_* parents; on deployments without
	// plugin-personal-assistant those names must degrade to the registered
	// capability instead of forcing an unavailable surface (#19863 review P1).
	it("aliases canonical owner parents to their topology fallbacks", () => {
		expect(parentAliasesForCandidateAction("OWNER_TODOS")).toEqual(["TODO"]);
		expect(parentAliasesForCandidateAction("OWNER_REMINDERS")).toEqual([
			"TRIGGER",
		]);
		expect(parentAliasesForCandidateAction("OWNER_ALARMS")).toEqual([
			"TRIGGER",
		]);
		expect(parentAliasesForCandidateAction("OWNER_ROUTINES")).toEqual([
			"TRIGGER",
		]);
		expect(parentAliasesForCandidateAction("OWNER_GOALS")).toEqual([]);
	});

	it("falls back to TODO when the owner-todo parent is absent from the catalog", () => {
		const catalog = buildActionCatalog([
			{ name: "TODO", description: "User-scoped persistent todos with CRUD." },
			{
				name: "TRIGGER",
				description: "Schedule one-shot and recurring triggers.",
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "add a todo: buy milk",
			candidateActions: ["OWNER_TODOS"],
		});
		expect(response.query.parentActionHints).toEqual(["TODO"]);
		expect(response.results[0]).toMatchObject({ name: "TODO" });
	});

	it("does not reinterpret an unavailable owner goal as a todo or raw trigger", () => {
		const catalog = buildActionCatalog([
			{ name: "TODO", description: "User-scoped persistent todos with CRUD." },
			{
				name: "TRIGGER",
				description: "Schedule one-shot and recurring triggers.",
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "set a goal to save for a trip",
			candidateActions: ["OWNER_GOALS"],
		});
		expect(response.query.parentActionHints).toEqual([]);
		expect(
			response.results.every((result) => result.matchedBy.length === 0),
		).toBe(true);
	});

	it("keeps the direct owner parent when personal-assistant is registered", () => {
		const catalog = buildActionCatalog([
			{
				name: "OWNER_TODOS",
				description: "Owner todos: create/update/delete/complete/review.",
			},
			{ name: "TODO", description: "User-scoped persistent todos with CRUD." },
		]);
		const response = retrieveActions({
			catalog,
			messageText: "add a todo: buy milk",
			candidateActions: ["OWNER_TODOS"],
		});
		// Direct catalog reference wins; the fallback aliases must not fire.
		expect(response.query.parentActionHints).toEqual(["OWNER_TODOS"]);
		expect(response.results[0]).toMatchObject({ name: "OWNER_TODOS" });
	});

	it("strips app-surface control blocks from text", () => {
		const text = [
			"2 scheduled items: water the garden, submit the invoice",
			"[FOLLOWUPS]",
			"navigate:/apps/reminders=Open reminders",
			"prompt:Delete water the garden=Delete water garden",
			"[/FOLLOWUPS]",
			"[CHECKLIST]",
			'{"title":"Cleanup","items":[]}',
			"[/CHECKLIST]",
			"connect it first. [CONFIG:google_calendars]",
		].join("\n");
		const cleaned = stripControlBlockMarkers(text);
		expect(cleaned).toContain("water the garden, submit the invoice");
		expect(cleaned).toContain("connect it first.");
		for (const leak of [
			"FOLLOWUPS",
			"navigate",
			"/apps/",
			"prompt:",
			"CHECKLIST",
			"CONFIG",
		]) {
			expect(cleaned).not.toContain(leak);
		}
	});

	it("does not let a leaked control block in the window evict the candidate action (tj-f8bdfafb488900)", () => {
		const catalog = buildActionCatalog([
			{
				name: "OWNER_REMINDERS",
				description:
					"Create, list, update, and delete the owner's reminders and scheduled nudges.",
			},
			{
				name: "CLOSE_ALL_VIEWS",
				description:
					"Close every open app view. Navigate views, open apps, prompt panels.",
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "now delete the submit the invoice reminder too",
			candidateActions: ["OWNER_REMINDERS"],
			recentConversationText: [
				"2 scheduled items: water the garden, submit the invoice",
				"[FOLLOWUPS]\nnavigate:/apps/reminders=Open reminders\nprompt:Delete water the garden=Delete water garden\nprompt:Delete submit the invoice=Delete invoice\n[/FOLLOWUPS]",
			],
		});

		// Live failure shape: the leaked navigate/apps/open/prompt vocabulary
		// out-scored the stage-1 candidate and tiering kept only the view
		// action. With the window stripped, the candidate stays on top.
		expect(response.results[0]).toMatchObject({ name: "OWNER_REMINDERS" });
	});
});

describe("F21 alias rows: email + terminal candidates bind to real parents", () => {
	it("email-shaped candidates alias to the inbox triage umbrella", () => {
		expect(parentAliasesForCandidateAction("EMAIL")).toEqual([
			"MESSAGE",
			"INBOX",
		]);
		expect(parentAliasesForCandidateAction("EMAIL_SEARCH")).toEqual([
			"MESSAGE",
			"INBOX",
		]);
		expect(parentAliasesForCandidateAction("CHECK_INBOX")).toEqual([
			"MESSAGE",
			"INBOX",
		]);
	});

	it("terminal-shaped candidates alias to the shell surface", () => {
		expect(parentAliasesForCandidateAction("TERMINAL_COMMAND")).toEqual([
			"SHELL",
			"TERMINAL_SHELL",
		]);
		expect(parentAliasesForCandidateAction("RUN_COMMAND")).toEqual([
			"SHELL",
			"TERMINAL_SHELL",
		]);
	});
});

describe("contact lookup candidate aliases", () => {
	it.each([
		"CONTACTS_LOOKUP",
		"CONTACT_LOOKUP",
		"LOOKUP_CONTACT",
		"FIND_CONTACT",
		"CONTACT_INFO",
		"SHOW_CONTACT",
		"CONTACTS",
		"ROLODEX",
	])("binds the contact-specific %s invention to both readers", (candidate) => {
		expect(parentAliasesForCandidateAction(candidate)).toEqual([
			"CONTACT",
			"ENTITY",
		]);
	});

	it("does not claim a generic WHO_IS invention for private contacts", () => {
		expect(parentAliasesForCandidateAction("WHO_IS")).toEqual([]);

		const catalog = buildActionCatalog([
			{
				name: "CONTACT",
				description: "Read and manage private Rolodex contacts.",
			},
			{
				name: "ENTITY",
				description: "Read the owner's private entity graph.",
			},
			{
				name: "WEB_SEARCH",
				description: "Search the public web for people and facts.",
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "who is Ada Lovelace",
			candidateActions: ["WHO_IS"],
		});

		expect(response.query.parentActionHints).toEqual([]);
		expect(
			response.results.find((result) => result.name === "CONTACT")?.matchedBy,
		).not.toContain("exact");
		expect(
			response.results.find((result) => result.name === "ENTITY")?.matchedBy,
		).not.toContain("exact");
	});

	it.each(["ADD_CONTACT", "CREATE_CONTACT", "GET_CONTACT", "FIND_PERSON"])(
		"leaves existing CONTACT simile %s authoritative instead of adding ENTITY",
		(candidate) => {
			const catalog = buildActionCatalog([
				{
					name: "CONTACT",
					description: "Read and manage private Rolodex contacts.",
					similes: [candidate],
				},
				{
					name: "ENTITY",
					description: "Read the owner's private entity graph.",
				},
			]);
			const response = retrieveActions({
				catalog,
				messageText: "",
				candidateActions: [candidate],
			});

			expect(response.query.parentActionHints).toEqual(["CONTACT"]);
			expect(response.results[0]).toMatchObject({ name: "CONTACT" });
			expect(
				response.results.find((result) => result.name === "ENTITY")?.matchedBy,
			).not.toContain("exact");
		},
	);
});

describe("F21 aliases survive production retrieval topology filtering", () => {
	it.each([
		["EMAIL", "MESSAGE"],
		["EMAIL_SEARCH", "INBOX"],
		["TERMINAL_COMMAND", "SHELL"],
		["RUN_COMMAND", "TERMINAL_SHELL"],
	])("binds %s to the available %s parent", (candidate, parentName) => {
		const catalog = buildActionCatalog([
			{
				name: parentName,
				description:
					"A registered runtime surface with no candidate-name overlap.",
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: "",
			candidateActions: [candidate],
		});

		expect(response.results[0]).toMatchObject({ name: parentName });
	});

	it("keeps a registered EMAIL parent authoritative over its fallback aliases", () => {
		const catalog = buildActionCatalog([
			{ name: "EMAIL", description: "Direct email capability." },
			{ name: "MESSAGE", description: "Per-channel message triage." },
			{ name: "INBOX", description: "Cross-channel inbox triage." },
		]);
		const response = retrieveActions({
			catalog,
			messageText: "",
			candidateActions: ["EMAIL"],
		});

		expect(response.query.parentActionHints).toEqual(["EMAIL"]);
		expect(response.results[0]).toMatchObject({ name: "EMAIL" });
	});
});
