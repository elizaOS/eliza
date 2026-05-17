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
