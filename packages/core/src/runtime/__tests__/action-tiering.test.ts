/**
 * Tier assignment for the planner's exposed action surface: tierActionResults
 * pins Tier-0 protocol controls, expands Tier-A parents with their children,
 * keeps Tier-B parent-only, omits Tier-C, and applies Stage-1 candidate
 * narrowing (promotion/demotion, simile-vs-canonical collision resolution,
 * per-parent tier-A child capping) plus a deterministic surface hash.
 * In-memory catalog; no model.
 */
import { describe, expect, it } from "vitest";
import { buildActionCatalog } from "../action-catalog";
import {
	type ActionRetrievalResult,
	retrieveActions,
} from "../action-retrieval";
import {
	stableActionSurfaceHash,
	TIER0_PROTOCOL_ACTIONS,
	tierActionResults,
} from "../action-tiering";

const actions = [
	{
		name: "MUSIC",
		description: "Control music playback.",
		subActions: ["PLAY_TRACK", "PAUSE_MUSIC"],
	},
	{
		name: "PLAY_TRACK",
		description: "Play a song.",
	},
	{
		name: "PAUSE_MUSIC",
		description: "Pause music.",
	},
	{
		name: "CALENDAR",
		description: "Manage calendar events.",
		subActions: ["CREATE_EVENT"],
	},
	{
		name: "CREATE_EVENT",
		description: "Create a meeting.",
	},
	{
		name: "EMAIL",
		description: "Send email.",
		subActions: ["SEND_EMAIL"],
	},
	{
		name: "SEND_EMAIL",
		description: "Send an email message.",
	},
	{
		name: "DELEGATE",
		description: "Delegate work to a coding sub-agent.",
		subActions: ["SPAWN_WORKER"],
	},
	{
		name: "SPAWN_WORKER",
		description: "Spawn a worker sub-agent.",
		similes: ["SPAWN_AGENT", "SPAWN_SUB_AGENT"],
	},
];

describe("action tiering", () => {
	it("pins protocol controls in Tier 0", () => {
		const catalog = buildActionCatalog(actions);
		const surface = tierActionResults({
			catalog,
			results: [],
		});

		expect(surface.protocolActions).toEqual(TIER0_PROTOCOL_ACTIONS);
		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["IGNORE", "REPLY", "STOP", "CONTINUE"]),
		);
	});

	it("expands Tier A parents with all sub-actions", () => {
		const catalog = buildActionCatalog(actions);
		const music = catalog.parentByName.get("MUSIC");
		if (!music) {
			throw new Error("missing MUSIC parent");
		}

		const surface = tierActionResults({
			catalog,
			results: [resultFor(music, 0.92)],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"MUSIC",
		]);
		expect(surface.tierAParents[0].childNames).toEqual([
			"PAUSE_MUSIC",
			"PLAY_TRACK",
		]);
		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["MUSIC", "PAUSE_MUSIC", "PLAY_TRACK"]),
		);
	});

	it("keeps Tier B parents parent-only for nested planner expansion", () => {
		const catalog = buildActionCatalog(actions);
		const calendar = catalog.parentByName.get("CALENDAR");
		if (!calendar) {
			throw new Error("missing CALENDAR parent");
		}

		const surface = tierActionResults({
			catalog,
			results: [resultFor(calendar, 0.5)],
		});

		expect(surface.tierBParents.map((parent) => parent.name)).toEqual([
			"CALENDAR",
		]);
		expect(surface.tierBParents[0].childNames).toEqual([]);
		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["CALENDAR"]),
		);
		expect(surface.exposedActionNames).not.toContain("CREATE_EVENT");
	});

	it("omits Tier C parents from the exposed action surface", () => {
		const catalog = buildActionCatalog(actions);
		const email = catalog.parentByName.get("EMAIL");
		if (!email) {
			throw new Error("missing EMAIL parent");
		}

		const surface = tierActionResults({
			catalog,
			results: [resultFor(email, 0.12)],
		});

		expect(surface.tierCParents.map((parent) => parent.name)).toContain(
			"EMAIL",
		);
		expect(surface.omittedParentNames).toContain("EMAIL");
		expect(surface.exposedActionNames).not.toContain("EMAIL");
		expect(surface.exposedActionNames).not.toContain("SEND_EMAIL");
	});

	it("promotes a candidate parent from Tier C into Tier A, with children restored", () => {
		const catalog = buildActionCatalog(actions);
		const email = catalog.parentByName.get("EMAIL");
		if (!email) {
			throw new Error("missing EMAIL parent");
		}

		// Retrieval ranked EMAIL into Tier C (score 0.12), but Stage 1
		// explicitly routed to its child SEND_EMAIL — the candidate signal
		// must pull EMAIL onto the surface anyway.
		const surface = tierActionResults({
			catalog,
			results: [resultFor(email, 0.12)],
			narrowToCandidateActions: ["SEND_EMAIL"],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"EMAIL",
		]);
		expect(surface.tierAParents[0].childNames).toEqual(["SEND_EMAIL"]);
		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["EMAIL", "SEND_EMAIL"]),
		);
	});

	it("keeps a near-certain non-candidate match on the surface (Stage-1 omission safety)", () => {
		const catalog = buildActionCatalog(actions);
		const music = catalog.parentByName.get("MUSIC");
		const email = catalog.parentByName.get("EMAIL");
		if (!music || !email) {
			throw new Error("missing parents");
		}

		// Stage 1 narrowed to EMAIL, but retrieval matched MUSIC at a near-perfect
		// 1.0. A dominant match must still reach the surface so the planner can
		// choose it (the live "weather"/"btc price" → WEB_FETCH-at-1.0 case Stage 1
		// narrowed to VIEWS).
		const surface = tierActionResults({
			catalog,
			results: [
				resultFor(music, 1, 2, { keyword: 1, bm25: 1 }),
				resultFor(email, 0.5, 1, { exact: 1 }),
			],
			narrowToCandidateActions: ["SEND_EMAIL"],
		});

		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["MUSIC", "EMAIL", "SEND_EMAIL"]),
		);
	});

	it("keeps a sole absolute retrieval winner with asymmetric lexical evidence", () => {
		const catalog = buildActionCatalog(actions);
		const music = catalog.parentByName.get("MUSIC");
		const email = catalog.parentByName.get("EMAIL");
		if (!music || !email) {
			throw new Error("missing parents");
		}

		const surface = tierActionResults({
			catalog,
			results: [
				resultFor(music, 1, 1, { keyword: 1, bm25: 0.4 }),
				resultFor(email, 0.5, 2, { exact: 1 }),
			],
			narrowToCandidateActions: ["SEND_EMAIL"],
		});

		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["MUSIC", "EMAIL", "SEND_EMAIL"]),
		);
	});

	it("keeps WEB_FETCH exposed for a real weather retrieval when Stage-1 omits it", () => {
		const catalog = buildActionCatalog([
			{
				name: "WEB_FETCH",
				description: "Fetch current live data from a URL.",
				contexts: ["web"],
				similes: ["CURRENT_WEATHER", "LIVE_INFO"],
			},
			{
				name: "VIEWS",
				description: "Open app views and arrange panels.",
				similes: ["OPEN_VIEW"],
			},
			{
				name: "MESSAGE_SEARCH",
				description: "Search chat history.",
			},
		]);
		const retrieval = retrieveActions({
			catalog,
			messageText: "weather in tokyo",
			candidateActions: ["VIEWS"],
			selectedContexts: ["web"],
		});
		const webFetch = retrieval.results.find(
			(result) => result.name === "WEB_FETCH",
		);

		expect(webFetch).toMatchObject({ score: 1 });
		expect(webFetch?.stageScores.bm25).toBeLessThan(0.99);

		const surface = tierActionResults({
			catalog,
			results: retrieval.results,
			narrowToCandidateActions: ["VIEWS"],
			queryTokens: retrieval.query.tokens,
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"VIEWS",
			"WEB_FETCH",
		]);
		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["VIEWS", "WEB_FETCH"]),
		);
	});

	it("does not count a wrong exact candidate as message evidence in a saturated tie", () => {
		const catalog = buildActionCatalog([
			{
				name: "QUASAR_LOOKUP",
				description: "Inspect quasar telemetry and measurements.",
				contexts: ["general"],
			},
			{
				name: "VIEWS",
				description: "Open app views and arrange panels.",
				contexts: ["general"],
			},
		]);
		const retrieval = retrieveActions({
			catalog,
			messageText: "quasar",
			candidateActions: ["VIEWS"],
			selectedContexts: ["general"],
		});

		expect(retrieval.results.slice(0, 2)).toMatchObject([
			{ name: "QUASAR_LOOKUP", rank: 1, score: 1 },
			{ name: "VIEWS", rank: 2, score: 1 },
		]);
		expect(retrieval.results[1]?.stageScores).toMatchObject({
			exact: 1,
			bm25: 1,
		});
	});

	it("does not let tied perfect keyword matches flood a routed candidate", () => {
		const catalog = buildActionCatalog([
			...actions,
			{
				name: "VIEWS",
				description: "Open and arrange app views, including Notes.",
			},
			{
				name: "HOUSEHOLD_OPERATIONS",
				description: "Process household notes and responsibility records.",
			},
			{
				name: "SCHOOL_SOURCES",
				description: "Extract notes from school sources.",
			},
		]);
		const views = catalog.parentByName.get("VIEWS");
		const household = catalog.parentByName.get("HOUSEHOLD_OPERATIONS");
		const school = catalog.parentByName.get("SCHOOL_SOURCES");
		if (!views || !household || !school) {
			throw new Error("missing routed-candidate fixtures");
		}

		const surface = tierActionResults({
			catalog,
			results: [
				resultFor(views, 1, 1, { exact: 1 }),
				resultFor(household, 1, 2, { keyword: 1, bm25: 1 }),
				resultFor(school, 1, 3, { keyword: 1, bm25: 1 }),
			],
			narrowToCandidateActions: ["VIEWS"],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"VIEWS",
		]);
		expect(surface.exposedActionNames).not.toContain("HOUSEHOLD_OPERATIONS");
		expect(surface.exposedActionNames).not.toContain("SCHOOL_SOURCES");
	});

	it("does not collapse an unmatched candidate to an arbitrary saturated winner", () => {
		const catalog = buildActionCatalog([
			{
				name: "ALPHA_OPERATIONS",
				description: "Handle a generic operation.",
			},
			{
				name: "BETA_OPERATIONS",
				description: "Handle a generic operation.",
			},
			{
				name: "GAMMA_OPERATIONS",
				description: "Handle a generic operation.",
			},
		]);
		const alpha = catalog.parentByName.get("ALPHA_OPERATIONS");
		const beta = catalog.parentByName.get("BETA_OPERATIONS");
		const gamma = catalog.parentByName.get("GAMMA_OPERATIONS");
		if (!alpha || !beta || !gamma) {
			throw new Error("missing saturated-tie fixtures");
		}

		const surface = tierActionResults({
			catalog,
			results: [
				resultFor(alpha, 1, 1, { keyword: 1, bm25: 1 }),
				resultFor(beta, 1, 2, { keyword: 1, bm25: 1 }),
				resultFor(gamma, 1, 3, { keyword: 1, bm25: 1 }),
			],
			narrowToCandidateActions: ["MODEL_INVENTED_ACTION"],
		});

		// Nothing in the catalog resolves the Stage-1 hint, and retrieval has no
		// evidence that distinguishes the saturated parents. Preserve the normal
		// tier-A surface instead of selecting whichever tied result was assigned
		// rank 1 by a stable but semantically meaningless fallback order.
		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"ALPHA_OPERATIONS",
			"BETA_OPERATIONS",
			"GAMMA_OPERATIONS",
		]);
	});

	it("still demotes a merely-good non-candidate match below the override score", () => {
		const catalog = buildActionCatalog(actions);
		const music = catalog.parentByName.get("MUSIC");
		const email = catalog.parentByName.get("EMAIL");
		if (!music || !email) {
			throw new Error("missing parents");
		}

		// 0.8 is a solid tier-A hit but NOT near-certain — Stage-1's narrow stands.
		const surface = tierActionResults({
			catalog,
			results: [resultFor(music, 0.8), resultFor(email, 0.5)],
			narrowToCandidateActions: ["SEND_EMAIL"],
		});

		expect(surface.exposedActionNames).not.toContain("MUSIC");
		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["EMAIL"]),
		);
	});

	it("promotes a Tier B candidate to Tier A and restores its children", () => {
		const catalog = buildActionCatalog(actions);
		const calendar = catalog.parentByName.get("CALENDAR");
		if (!calendar) {
			throw new Error("missing CALENDAR parent");
		}

		// Tier B normally exposes the parent only; once it is the routed
		// candidate it must be promoted to Tier A so its child is reachable.
		const surface = tierActionResults({
			catalog,
			results: [resultFor(calendar, 0.5)],
			narrowToCandidateActions: ["CALENDAR"],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"CALENDAR",
		]);
		expect(surface.tierAParents[0].childNames).toEqual(["CREATE_EVENT"]);
		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["CALENDAR", "CREATE_EVENT"]),
		);
	});

	it("resolves a candidate that is a simile of a child sub-action", () => {
		const catalog = buildActionCatalog(actions);
		const delegate = catalog.parentByName.get("DELEGATE");
		if (!delegate) {
			throw new Error("missing DELEGATE parent");
		}

		// Stage 1 named "SPAWN_AGENT" — a simile of the child SPAWN_WORKER —
		// not the canonical name. It must still resolve back to DELEGATE.
		const surface = tierActionResults({
			catalog,
			results: [resultFor(delegate, 0.05)],
			narrowToCandidateActions: ["SPAWN_AGENT"],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"DELEGATE",
		]);
		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["DELEGATE", "SPAWN_WORKER"]),
		);
	});

	it("lets canonical candidate names beat another parent's simile", () => {
		const catalog = buildActionCatalog([
			{
				name: "SCHEDULED_TASKS",
				description: "Manage reminders and scheduled tasks.",
				similes: ["TASKS", "REMINDER_TASK"],
			},
			{
				name: "TASKS",
				description: "Delegate coding work to a sub-agent.",
				subActions: ["TASKS_SPAWN_AGENT"],
			},
			{
				name: "TASKS_SPAWN_AGENT",
				description: "Spawn a coding sub-agent.",
				similes: ["SPAWN_AGENT"],
			},
		]);
		const scheduledTasks = catalog.parentByName.get("SCHEDULED_TASKS");
		const codingTasks = catalog.parentByName.get("TASKS");
		if (!scheduledTasks || !codingTasks) {
			throw new Error("missing collision parents");
		}

		const surface = tierActionResults({
			catalog,
			results: [resultFor(scheduledTasks, 0.95), resultFor(codingTasks, 0.12)],
			narrowToCandidateActions: ["TASKS"],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"TASKS",
		]);
		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["TASKS", "TASKS_SPAWN_AGENT"]),
		);
		expect(surface.exposedActionNames).not.toContain("SCHEDULED_TASKS");
	});

	it("keeps simile candidate matching when there is no canonical name collision", () => {
		const catalog = buildActionCatalog([
			{
				name: "SCHEDULED_TASKS",
				description: "Manage reminders and scheduled tasks.",
				similes: ["TASKS", "REMINDER_TASK"],
			},
			{
				name: "TASKS",
				description: "Delegate coding work to a sub-agent.",
				subActions: ["TASKS_SPAWN_AGENT"],
			},
			{
				name: "TASKS_SPAWN_AGENT",
				description: "Spawn a coding sub-agent.",
				similes: ["SPAWN_AGENT"],
			},
		]);
		const scheduledTasks = catalog.parentByName.get("SCHEDULED_TASKS");
		if (!scheduledTasks) {
			throw new Error("missing scheduled tasks parent");
		}

		const surface = tierActionResults({
			catalog,
			results: [resultFor(scheduledTasks, 0.12)],
			narrowToCandidateActions: ["REMINDER_TASK"],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"SCHEDULED_TASKS",
		]);
		expect(surface.exposedActionNames).toContain("SCHEDULED_TASKS");
	});

	it("matches an unambiguous reversed compound child name", () => {
		const catalog = buildActionCatalog([
			{
				name: "TASKS",
				description: "Manage coding tasks.",
				subActions: ["TASKS_CANCEL"],
			},
			{ name: "TASKS_CANCEL", description: "Cancel a coding task." },
		]);
		const tasks = catalog.parentByName.get("TASKS");
		if (!tasks) throw new Error("missing TASKS parent");

		const surface = tierActionResults({
			catalog,
			results: [resultFor(tasks, 0.1)],
			narrowToCandidateActions: ["CANCEL_TASKS"],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"TASKS",
		]);
		expect(surface.exposedActionNames).toContain("TASKS_CANCEL");
	});

	it("does not guess when reversed compound tokens identify multiple parents", () => {
		const catalog = buildActionCatalog([
			{ name: "MUSIC", description: "Control music." },
			{
				name: "TASKS",
				description: "Manage coding tasks.",
				subActions: ["TASKS_CANCEL_NOW"],
			},
			{ name: "TASKS_CANCEL_NOW", description: "Cancel a coding task." },
			{
				name: "CANCELLATIONS",
				description: "Manage cancellation records.",
				subActions: ["CANCEL_NOW_TASKS"],
			},
			{ name: "CANCEL_NOW_TASKS", description: "Cancel task records." },
		]);
		const music = catalog.parentByName.get("MUSIC");
		const tasks = catalog.parentByName.get("TASKS");
		const cancellations = catalog.parentByName.get("CANCELLATIONS");
		if (!music || !tasks || !cancellations) {
			throw new Error("missing collision parents");
		}

		const surface = tierActionResults({
			catalog,
			results: [
				resultFor(music, 0.95),
				resultFor(tasks, 0.1),
				resultFor(cancellations, 0.1),
			],
			narrowToCandidateActions: ["NOW_TASKS_CANCEL"],
		});

		// No canonical action owns the proposed spelling and two parents own its
		// unordered token set, so narrowing must remain inactive.
		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"MUSIC",
		]);
		expect(surface.exposedActionNames).not.toContain("TASKS_CANCEL_NOW");
		expect(surface.exposedActionNames).not.toContain("CANCEL_NOW_TASKS");
	});

	it("demotes non-candidate Tier A parents when a candidate is promoted", () => {
		const catalog = buildActionCatalog(actions);
		const music = catalog.parentByName.get("MUSIC");
		const email = catalog.parentByName.get("EMAIL");
		if (!music || !email) {
			throw new Error("missing parents");
		}

		// MUSIC ranked into Tier A, EMAIL into Tier C — but Stage 1 routed
		// to SEND_EMAIL. EMAIL is promoted and the narrow demotes MUSIC.
		const surface = tierActionResults({
			catalog,
			results: [resultFor(music, 0.95), resultFor(email, 0.1)],
			narrowToCandidateActions: ["SEND_EMAIL"],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"EMAIL",
		]);
		expect(surface.exposedActionNames).not.toContain("MUSIC");
		expect(surface.omittedParentNames).toContain("MUSIC");
	});

	it("leaves the surface untouched when no parent matches any candidate", () => {
		const catalog = buildActionCatalog(actions);
		const music = catalog.parentByName.get("MUSIC");
		if (!music) {
			throw new Error("missing MUSIC parent");
		}

		// Stage 1 named an action that does not exist in the catalog — the
		// narrow must no-op rather than collapse the surface to empty.
		const surface = tierActionResults({
			catalog,
			results: [resultFor(music, 0.95)],
			narrowToCandidateActions: ["NONEXISTENT_ACTION"],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"MUSIC",
		]);
	});

	describe("per-parent tier-A child narrowing", () => {
		// A hot parent with a wide namespace: two children match the turn's
		// wording, the other ten are unrelated operations.
		const messageActions = [
			{
				name: "MESSAGE",
				description: "Message management parent.",
				subActions: [
					"MESSAGE_REVIEW_QUEUE",
					"MESSAGE_SEND_REPLY",
					...Array.from({ length: 10 }, (_, i) => `MESSAGE_OP_${i}`),
				],
			},
			{
				name: "MESSAGE_REVIEW_QUEUE",
				description: "Review channel messages awaiting a response.",
			},
			{
				name: "MESSAGE_SEND_REPLY",
				description: "Reply to messages needing a response.",
			},
			...Array.from({ length: 10 }, (_, i) => ({
				name: `MESSAGE_OP_${i}`,
				description: `Unrelated bulk operation number ${i}.`,
			})),
		];
		const reviewTurnTokens = [
			"review",
			"channel",
			"messages",
			"needing",
			"response",
			"reply",
		];

		it("caps children per tier-A parent and keeps the query-relevant ones", () => {
			const catalog = buildActionCatalog(messageActions);
			const message = catalog.parentByName.get("MESSAGE");
			if (!message) {
				throw new Error("missing MESSAGE parent");
			}

			const surface = tierActionResults({
				catalog,
				results: [resultFor(message, 0.95)],
				maxTierAChildrenPerParent: 4,
				queryTokens: reviewTurnTokens,
			});

			const tierA = surface.tierAParents[0];
			expect(tierA.name).toBe("MESSAGE");
			expect(tierA.childNames).toHaveLength(4);
			expect(tierA.childNames).toContain("MESSAGE_REVIEW_QUEUE");
			expect(tierA.childNames).toContain("MESSAGE_SEND_REPLY");
			// The parent umbrella stays exposed as the catch-all dispatcher.
			expect(surface.exposedActionNames).toContain("MESSAGE");
			// Narrowed-out children leave the exposed surface entirely.
			expect(surface.exposedActionNames).not.toContain("MESSAGE_OP_9");
		});

		it("always keeps Stage-1 candidate children even when token ranking misses them", () => {
			const catalog = buildActionCatalog(messageActions);
			const message = catalog.parentByName.get("MESSAGE");
			if (!message) {
				throw new Error("missing MESSAGE parent");
			}

			const surface = tierActionResults({
				catalog,
				results: [resultFor(message, 0.95)],
				narrowToCandidateActions: ["MESSAGE_OP_7"],
				maxTierAChildrenPerParent: 2,
				queryTokens: reviewTurnTokens,
			});

			const tierA = surface.tierAParents[0];
			expect(tierA.childNames).toContain("MESSAGE_OP_7");
			expect(tierA.childNames).toHaveLength(2);
		});

		it("applies the default cap of 8 when the knob is omitted", () => {
			const catalog = buildActionCatalog(messageActions);
			const message = catalog.parentByName.get("MESSAGE");
			if (!message) {
				throw new Error("missing MESSAGE parent");
			}

			const surface = tierActionResults({
				catalog,
				results: [resultFor(message, 0.95)],
				queryTokens: reviewTurnTokens,
			});

			expect(surface.tierAParents[0].childNames).toHaveLength(8);
			expect(surface.tierAParents[0].childNames).toContain(
				"MESSAGE_REVIEW_QUEUE",
			);
		});

		it("leaves parents whose children fit the cap untouched", () => {
			const catalog = buildActionCatalog(actions);
			const music = catalog.parentByName.get("MUSIC");
			if (!music) {
				throw new Error("missing MUSIC parent");
			}

			const surface = tierActionResults({
				catalog,
				results: [resultFor(music, 0.92)],
				queryTokens: ["pause", "the", "song"],
			});

			expect(surface.tierAParents[0].childNames).toEqual([
				"PAUSE_MUSIC",
				"PLAY_TRACK",
			]);
		});

		it("narrows deterministically without query tokens via catalog child order", () => {
			const catalog = buildActionCatalog(messageActions);
			const message = catalog.parentByName.get("MESSAGE");
			if (!message) {
				throw new Error("missing MESSAGE parent");
			}

			const first = tierActionResults({
				catalog,
				results: [resultFor(message, 0.95)],
				maxTierAChildrenPerParent: 3,
			});
			const second = tierActionResults({
				catalog,
				results: [resultFor(message, 0.95)],
				maxTierAChildrenPerParent: 3,
			});

			expect(first.tierAParents[0].childNames).toEqual(
				second.tierAParents[0].childNames,
			);
			expect(first.tierAParents[0].childNames).toHaveLength(3);
			expect(first.actionSurfaceHash).toBe(second.actionSurfaceHash);
		});
	});

	it("creates deterministic hashes from sorted parent sets", () => {
		const left = stableActionSurfaceHash({
			protocolActions: ["REPLY", "IGNORE", "STOP", "CONTINUE"],
			tierAParentNames: ["MUSIC", "CALENDAR"],
			tierBParentNames: ["EMAIL"],
			tierAChildNames: ["PLAY_TRACK", "CREATE_EVENT"],
		});
		const right = stableActionSurfaceHash({
			protocolActions: ["STOP", "CONTINUE", "IGNORE", "REPLY"],
			tierAParentNames: ["CALENDAR", "MUSIC"],
			tierBParentNames: ["EMAIL"],
			tierAChildNames: ["CREATE_EVENT", "PLAY_TRACK"],
		});

		expect(left).toBe(right);
	});
});

function resultFor(
	parent: {
		name: string;
		normalizedName: string;
	},
	score: number,
	rank = 1,
	stageScores: ActionRetrievalResult["stageScores"] = {},
): ActionRetrievalResult {
	return {
		parent: parent as ActionRetrievalResult["parent"],
		name: parent.name,
		normalizedName: parent.normalizedName,
		score,
		rank,
		rrfScore: score,
		stageScores,
		matchedBy: [],
	};
}
