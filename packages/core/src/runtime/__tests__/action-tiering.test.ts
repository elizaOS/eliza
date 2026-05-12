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
