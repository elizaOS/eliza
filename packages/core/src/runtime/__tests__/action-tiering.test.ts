import { describe, expect, it } from "vitest";
import { buildActionCatalog } from "../action-catalog";
import type { ActionRetrievalResult } from "../action-retrieval";
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
			results: [resultFor(music, 1), resultFor(email, 0.5)],
			narrowToCandidateActions: ["SEND_EMAIL"],
		});

		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining(["MUSIC", "EMAIL", "SEND_EMAIL"]),
		);
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
): ActionRetrievalResult {
	return {
		parent: parent as ActionRetrievalResult["parent"],
		name: parent.name,
		normalizedName: parent.normalizedName,
		score,
		rank: 1,
		rrfScore: score,
		stageScores: {},
		matchedBy: [],
	};
}
