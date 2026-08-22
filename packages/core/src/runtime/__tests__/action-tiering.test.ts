/**
 * Complete planner action-surface coverage using an in-memory catalog and
 * deterministic retrieval results; no model or transport is involved.
 */
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
	{ name: "PLAY_TRACK", description: "Play a song." },
	{ name: "PAUSE_MUSIC", description: "Pause music." },
	{
		name: "CALENDAR",
		description: "Manage calendar events.",
		subActions: ["CREATE_EVENT"],
	},
	{ name: "CREATE_EVENT", description: "Create a meeting." },
	{
		name: "EMAIL",
		description: "Send email.",
		subActions: ["SEND_EMAIL"],
	},
	{ name: "SEND_EMAIL", description: "Send an email message." },
];

describe("complete action surface", () => {
	it("keeps protocol controls and every catalog parent and child callable", () => {
		const catalog = buildActionCatalog(actions);
		const music = catalog.parentByName.get("MUSIC");
		if (!music) throw new Error("missing MUSIC parent");

		const surface = tierActionResults({
			catalog,
			results: [resultFor(music, 0.95)],
		});

		expect(surface.protocolActions).toEqual(TIER0_PROTOCOL_ACTIONS);
		expect(surface.tierBParents).toEqual([]);
		expect(surface.tierCParents).toEqual([]);
		expect(surface.omittedParentNames).toEqual([]);
		expect(surface.exposedParentNames).toHaveLength(catalog.parents.length);
		expect(surface.exposedActionNames).toEqual(
			expect.arrayContaining([
				...TIER0_PROTOCOL_ACTIONS,
				"MUSIC",
				"PLAY_TRACK",
				"PAUSE_MUSIC",
				"CALENDAR",
				"CREATE_EVENT",
				"EMAIL",
				"SEND_EMAIL",
			]),
		);
	});

	it("uses relevance only for ordering", () => {
		const catalog = buildActionCatalog(actions);
		const music = catalog.parentByName.get("MUSIC");
		const email = catalog.parentByName.get("EMAIL");
		if (!music || !email) throw new Error("missing catalog parent");

		const surface = tierActionResults({
			catalog,
			results: [resultFor(email, 0.4), resultFor(music, 0.9)],
		});

		expect(
			surface.tierAParents.slice(0, 2).map((parent) => parent.name),
		).toEqual(["MUSIC", "EMAIL"]);
		expect(surface.tierAParents.map((parent) => parent.name)).toEqual(
			expect.arrayContaining(catalog.parents.map((parent) => parent.name)),
		);
	});

	it("ignores legacy parent, child, threshold, and candidate caps", () => {
		const manyChildren = Array.from({ length: 24 }, (_, index) => ({
			name: `CHILD_${String(index).padStart(2, "0")}`,
			description: `Child ${index}`,
		}));
		const catalog = buildActionCatalog([
			{
				name: "LARGE_PARENT",
				description: "Large action family.",
				subActions: manyChildren.map((child) => child.name),
			},
			...manyChildren,
			...Array.from({ length: 30 }, (_, index) => ({
				name: `PARENT_${String(index).padStart(2, "0")}`,
				description: `Parent ${index}`,
			})),
		]);

		const surface = tierActionResults({
			catalog,
			results: [],
			tierAThreshold: 1,
			tierBThreshold: 1,
			maxTierAParents: 1,
			maxTierBParents: 1,
			maxTierAChildrenPerParent: 1,
			narrowToCandidateActions: ["PARENT_00"],
		});
		const large = surface.tierAParents.find(
			(parent) => parent.name === "LARGE_PARENT",
		);

		expect(surface.tierAParents).toHaveLength(catalog.parents.length);
		expect(large?.childNames).toHaveLength(24);
		expect(surface.omittedParentNames).toEqual([]);
	});

	it("assigns zero-score catalog entries deterministic ranks without omitting them", () => {
		const catalog = buildActionCatalog(actions);
		const first = tierActionResults({ catalog, results: [] });
		const second = tierActionResults({ catalog, results: [] });

		expect(first.exposedActionNames).toEqual(second.exposedActionNames);
		expect(first.actionSurfaceHash).toBe(second.actionSurfaceHash);
		expect(first.tierAParents.every((parent) => parent.score === 0)).toBe(true);
	});

	it("hashes the complete surface independent of caller ordering", () => {
		const first = stableActionSurfaceHash({
			protocolActions: ["REPLY", "STOP"],
			tierAParentNames: ["EMAIL", "CALENDAR"],
			tierAChildNames: ["SEND_EMAIL", "CREATE_EVENT"],
		});
		const second = stableActionSurfaceHash({
			protocolActions: ["STOP", "REPLY"],
			tierAParentNames: ["CALENDAR", "EMAIL"],
			tierAChildNames: ["CREATE_EVENT", "SEND_EMAIL"],
		});
		expect(first).toBe(second);
	});
});

function resultFor(
	parent: ReturnType<typeof buildActionCatalog>["parents"][number],
	score: number,
): ActionRetrievalResult {
	return {
		parent,
		name: parent.name,
		normalizedName: parent.normalizedName,
		score,
		rank: 1,
		rrfScore: score,
		stageScores: {},
		matchedBy: [],
	};
}
