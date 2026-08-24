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

describe("action tiering boundary behaviour", () => {
	it("breaks score ties deterministically by normalized name", () => {
		const catalog = buildActionCatalog([
			{ name: "ZULU", description: "Zulu action." },
			{ name: "ALPHA", description: "Alpha action." },
			{ name: "MIKE", description: "Mike action." },
		]);
		const scored = ["ZULU", "ALPHA", "MIKE"].map((name) => {
			const parent = catalog.parentByName.get(name);
			if (!parent) throw new Error(`missing ${name} parent`);
			return resultFor(parent, 0.5);
		});

		const surface = tierActionResults({ catalog, results: scored });

		expect(surface.tierAParents.map((parent) => parent.name)).toEqual([
			"ALPHA",
			"MIKE",
			"ZULU",
		]);
	});

	it("lets callers override the protocol control set", () => {
		const catalog = buildActionCatalog([
			{ name: "DELTA", description: "Delta action." },
			{ name: "ECHO", description: "Echo action." },
		]);

		const surface = tierActionResults({
			catalog,
			results: [],
			protocolActions: ["STOP"],
		});

		expect(surface.protocolActions).toEqual(["STOP"]);
		expect(surface.exposedActionNames).toEqual(["STOP", "DELTA", "ECHO"]);
	});

	it("ignores retrieval results whose normalized name matches no catalog parent", () => {
		const wideCatalog = buildActionCatalog([
			{ name: "SOLO", description: "Only entry in the narrow catalog." },
			{ name: "GHOST", description: "Absent from the narrow catalog." },
		]);
		const catalog = buildActionCatalog([
			{ name: "SOLO", description: "Only entry in the narrow catalog." },
		]);
		const ghost = wideCatalog.parentByName.get("GHOST");
		if (!ghost) throw new Error("missing GHOST parent");

		const surface = tierActionResults({
			catalog,
			results: [resultFor(ghost, 0.9)],
		});
		const solo = surface.tierAParents[0];
		if (!solo) throw new Error("missing SOLO parent");

		expect(surface.exposedParentNames).toEqual(["SOLO"]);
		expect(surface.exposedActionNames).toEqual([
			...TIER0_PROTOCOL_ACTIONS,
			"SOLO",
		]);
		expect(solo.score).toBe(0);
		expect(solo.result.rank).toBe(0);
		expect(solo.result.rrfScore).toBe(0);
		expect(solo.result.matchedBy).toEqual([]);
		expect(solo.result.name).toBe("SOLO");
	});

	it("passes retrieval results through and isolates child arrays from the catalog", () => {
		const catalog = buildActionCatalog([
			{
				name: "MUSIC",
				description: "Control music playback.",
				subActions: ["PLAY_TRACK", "PAUSE_MUSIC"],
			},
			{ name: "PLAY_TRACK", description: "Play a song." },
			{ name: "PAUSE_MUSIC", description: "Pause music." },
		]);
		const music = catalog.parentByName.get("MUSIC");
		if (!music) throw new Error("missing MUSIC parent");
		const musicResult = resultFor(music, 0.7);

		const surface = tierActionResults({ catalog, results: [musicResult] });
		const tieredMusic = surface.tierAParents.find(
			(parent) => parent.name === "MUSIC",
		);
		if (!tieredMusic) throw new Error("missing tiered MUSIC parent");

		expect(tieredMusic.result).toBe(musicResult);
		tieredMusic.childNames.push("MUTATED_CHILD");
		tieredMusic.childNormalizedNames.push("MUTATED_CHILD");
		expect(music.childNames).toEqual(["PAUSE_MUSIC", "PLAY_TRACK"]);
		expect(tieredMusic.childNames.at(-1)).toBe("MUTATED_CHILD");
	});

	it("keeps the surface hash independent of relevance but sensitive to the callable set", () => {
		const catalog = buildActionCatalog(actions);
		const music = catalog.parentByName.get("MUSIC");
		const email = catalog.parentByName.get("EMAIL");
		if (!music || !email) throw new Error("missing catalog parent");
		const smallerCatalog = buildActionCatalog([
			{ name: "EMAIL", description: "Send email.", subActions: ["SEND_EMAIL"] },
			{ name: "SEND_EMAIL", description: "Send an email message." },
		]);

		const musicLeads = tierActionResults({
			catalog,
			results: [resultFor(music, 0.99), resultFor(email, 0.1)],
		});
		const emailLeads = tierActionResults({
			catalog,
			results: [resultFor(email, 0.99), resultFor(music, 0.1)],
		});

		expect(musicLeads.actionSurfaceHash).toBe(emailLeads.actionSurfaceHash);
		expect(musicLeads.actionSurfaceHash).not.toBe(
			tierActionResults({ catalog: smallerCatalog, results: [] })
				.actionSurfaceHash,
		);
	});

	it("hashes omitted segments identically to explicitly empty ones", () => {
		expect(stableActionSurfaceHash({})).toBe(
			stableActionSurfaceHash({
				protocolActions: [],
				tierAParentNames: [],
				tierBParentNames: [],
				tierAChildNames: [],
			}),
		);
		expect(stableActionSurfaceHash({ tierAParentNames: ["X"] })).not.toBe(
			stableActionSurfaceHash({ tierBParentNames: ["X"] }),
		);
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
