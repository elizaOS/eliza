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

	it("narrows generated view action candidates to the VIEWS parent", () => {
		const catalog = buildActionCatalog([
			{
				name: "PAGE_DELEGATE",
				description: "Delegate page-scoped browser and owner operations.",
			},
			{
				name: "VIEWS",
				description:
					"Open, close, split, tile, and manage UI views and panels.",
				similes: ["OPEN_VIEW", "CLOSE_VIEW", "SPLIT_VIEWS"],
			},
		]);
		const pageDelegate = catalog.parentByName.get("PAGE_DELEGATE");
		const views = catalog.parentByName.get("VIEWS");
		if (!pageDelegate || !views) {
			throw new Error("missing view routing parents");
		}

		for (const candidateAction of [
			"CALENDAR_CLOSE_VIEW",
			"CREATE_BOARD_CARD",
			"GET_BOARD_CARDS",
			"CREATE_TIMELINE_EVENT",
			"GET_DASHBOARD_STATE",
			"VIEW_OPEN",
			"OPEN_VIEW",
			"OPEN_APPLICATION",
		]) {
			const surface = tierActionResults({
				catalog,
				results: [resultFor(pageDelegate, 0.95), resultFor(views, 0.92)],
				narrowToCandidateActions: [candidateAction],
			});

			expect(
				surface.tierAParents.map((parent) => parent.name),
				candidateAction,
			).toEqual(["VIEWS"]);
			expect(surface.exposedActionNames).toContain("VIEWS");
			expect(surface.exposedActionNames).not.toContain("PAGE_DELEGATE");
		}
	});

	it("does not narrow generated capability candidates away from a real namespace parent", () => {
		const catalog = buildActionCatalog([
			{
				name: "CALENDAR",
				description: "Manage calendar events.",
				subActions: ["CALENDAR_CREATE_EVENT"],
			},
			{
				name: "CALENDAR_CREATE_EVENT",
				description: "Create a calendar event.",
			},
			{
				name: "VIEWS",
				description: "Manage UI views and invoke view capabilities.",
			},
		]);
		const calendar = catalog.parentByName.get("CALENDAR");
		const views = catalog.parentByName.get("VIEWS");
		if (!calendar || !views) {
			throw new Error("missing test parents");
		}

		const surface = tierActionResults({
			catalog,
			results: [resultFor(calendar, 0.95), resultFor(views, 0.92)],
			narrowToCandidateActions: ["CALENDAR_CREATE_EVENT"],
		});

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"CALENDAR",
		]);
		expect(surface.exposedActionNames).toContain("CALENDAR_CREATE_EVENT");
		expect(surface.exposedActionNames).not.toContain("VIEWS");
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
