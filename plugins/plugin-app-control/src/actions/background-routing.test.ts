/**
 * Retrieval/tiering regression for #11360: naturally-phrased background
 * undo/redo/reset follow-ups must keep the BACKGROUND action on the planner
 * surface under a live model's Stage-1 output.
 *
 * Ground truth is the committed misroute trajectory
 * `test-results/evidence/10694-gemma4-live-scenarios/trajectory-variance-undo-misroute.json`:
 * on "Undo the background change." gemma-4-31b emitted
 * `contexts:["settings"], candidateActions:["UPDATE_SETTINGS","RESET_SETTINGS"]`.
 * The UPDATE_SETTINGS candidate alias-hinted VIEWS (exact score 1.0) and the
 * candidate narrow demoted BACKGROUND (score 0.9675 — just under the 0.97
 * retrieval-override keep) to tier-C, so the planner was never offered
 * BACKGROUND at all and routed the turn to VIEWS.
 *
 * This test drives the REAL retrieval + tiering pipeline (the same
 * `retrieveActions` → `tierActionResults` calls `message.ts` makes) over the
 * plugin's REAL action metadata, so it fails whenever the BACKGROUND metadata
 * regresses below the score that survives a settings-flavored Stage-1 narrow.
 */

import { buildActionCatalog } from "@elizaos/core/runtime/action-catalog.js";
import { retrieveActions } from "@elizaos/core/runtime/action-retrieval.js";
import { tierActionResults } from "@elizaos/core/runtime/action-tiering.js";
import { satisfiesContextGate } from "@elizaos/core/runtime/context-gates.js";
import { describe, expect, it } from "vitest";
import { appAction } from "./app.ts";
import { backgroundAction } from "./background.ts";
import { viewsAction } from "./views.ts";

/**
 * Minimal stand-ins for the other parent actions that were on the live
 * catalog (CHARACTER, CREDENTIALS, …). Only name/description/contexts matter
 * to retrieval; keeping them in the catalog preserves realistic bm25
 * document-frequency + score normalization instead of a 3-action toy corpus.
 */
const FILLER_ACTIONS = [
	{
		name: "CHARACTER",
		description:
			"Modify the agent character: name, persona, style, identity, memory flush.",
		contexts: ["settings", "character"],
	},
	{
		name: "CREDENTIALS",
		description:
			"Look up or update saved credentials, passwords, and API keys in settings.",
		contexts: ["settings", "secrets"],
	},
	{
		name: "CONNECTOR",
		description:
			"Enable, disable, or configure connectors and integrations in settings.",
		contexts: ["settings", "connectors"],
	},
	{
		name: "PERSONALITY",
		description:
			"Adjust the agent personality traits and response style settings.",
		contexts: ["settings", "character"],
	},
	{
		name: "BLOCK",
		description: "Block or unblock a user, contact, or channel.",
		contexts: ["settings", "messaging"],
	},
	{
		name: "SKILL",
		description: "Run a skill from the knowledge base.",
		contexts: ["general"],
	},
	{
		name: "ROOM",
		description: "Manage rooms: mute, unmute, follow, unfollow.",
		contexts: ["messaging"],
	},
	{
		name: "REMOTE_DESKTOP",
		description: "Control a remote desktop session.",
		contexts: ["automation"],
	},
];

const CATALOG_ACTIONS = [
	backgroundAction,
	viewsAction,
	appAction,
	...FILLER_ACTIONS,
];

/** Mirrors the retrieval → tiering flow of collectToolSearchSurface. */
function routeTurn(params: {
	messageText: string;
	candidateActions: string[];
	selectedContexts: string[];
}) {
	const catalog = buildActionCatalog(CATALOG_ACTIONS);
	const retrieval = retrieveActions({
		catalog,
		messageText: params.messageText,
		candidateActions: params.candidateActions,
		selectedContexts: params.selectedContexts,
	});
	const tiered = tierActionResults({
		catalog,
		results: retrieval.results,
		narrowToCandidateActions: params.candidateActions,
	});
	return { retrieval, tiered };
}

function exposedParents(tiered: {
	tierAParents: Array<{ name: string }>;
	tierBParents: Array<{ name: string }>;
}): string[] {
	return [
		...tiered.tierAParents.map((parent) => parent.name),
		...tiered.tierBParents.map((parent) => parent.name),
	];
}

describe("BACKGROUND stays on the planner surface for undo/redo/reset follow-ups (#11360)", () => {
	it("survives the exact live misroute: settings-flavored Stage-1 narrow on the undo turn", () => {
		// Verbatim Stage-1 output from the committed misroute trajectory.
		const { retrieval, tiered } = routeTurn({
			messageText: "Undo the background change.",
			candidateActions: ["UPDATE_SETTINGS", "RESET_SETTINGS"],
			selectedContexts: ["settings"],
		});

		const background = retrieval.results.find((r) => r.name === "BACKGROUND");
		expect(background).toBeDefined();
		// ≥ the tiering RETRIEVAL_OVERRIDE_SCORE (0.97): the score at which a
		// candidate narrow that omitted BACKGROUND still keeps it on the surface.
		expect(background?.score ?? 0).toBeGreaterThanOrEqual(0.97);
		expect(exposedParents(tiered)).toContain("BACKGROUND");
	});

	it.each([
		["undo that background change", ["UPDATE_SETTINGS", "RESET_SETTINGS"]],
		["redo the background change", ["UPDATE_SETTINGS", "RESET_SETTINGS"]],
		[
			"reset the background to the default look",
			["UPDATE_SETTINGS", "RESET_SETTINGS"],
		],
		["Undo the background change.", ["RESET_SETTINGS"]],
		["revert the wallpaper", ["UPDATE_SETTINGS"]],
	])("keeps BACKGROUND exposed for %j under a settings narrow", (messageText, candidateActions) => {
		const { tiered } = routeTurn({
			messageText,
			candidateActions,
			selectedContexts: ["settings"],
		});
		expect(exposedParents(tiered)).toContain("BACKGROUND");
	});

	it("keeps BACKGROUND exposed when Stage-1 names background-scoped candidates", () => {
		// A live model that DOES stay on-topic emits names like these; the
		// tiering candidate narrow matches them against BACKGROUND's similes.
		for (const candidate of [
			"UNDO_BACKGROUND",
			"UNDO_BACKGROUND_CHANGE",
			"REVERT_BACKGROUND",
			"REDO_BACKGROUND_CHANGE",
			"RESET_WALLPAPER",
			"RESTORE_BACKGROUND",
		]) {
			const { tiered } = routeTurn({
				messageText: "undo that background change",
				candidateActions: [candidate],
				selectedContexts: ["settings"],
			});
			expect(
				tiered.tierAParents.map((parent) => parent.name),
				`candidate ${candidate} must keep BACKGROUND in tier-A`,
			).toContain("BACKGROUND");
		}
	});

	it("survives a code-classified set turn (live run: 'give me a slow lava-lamp style animated background')", () => {
		// Observed live on gemma-4-31b: Stage-1 read the animated-background ask
		// as a BUILD request (contexts:["code"], candidates
		// GENERATE_CODE/CREATE_FILE). Retrieval must still rank BACKGROUND high
		// enough to survive the candidate narrow.
		const { retrieval, tiered } = routeTurn({
			messageText: "give me a slow lava-lamp style animated background",
			candidateActions: ["GENERATE_CODE", "CREATE_FILE"],
			selectedContexts: ["code"],
		});
		const background = retrieval.results.find((r) => r.name === "BACKGROUND");
		expect(background?.score ?? 0).toBeGreaterThanOrEqual(0.97);
		expect(exposedParents(tiered)).toContain("BACKGROUND");
	});

	it("context gate admits the classifications live models actually pick", () => {
		// The planner surface drops any action whose contextGate rejects the
		// Stage-1 contexts BEFORE retrieval runs — a gated-out action can never
		// be recovered by ranking. Live-observed classifications for background
		// requests: settings (undo/redo/reset), code (animated-shader set),
		// media (generate a wallpaper), general.
		for (const context of ["general", "settings", "media", "code"]) {
			expect(
				satisfiesContextGate([context], backgroundAction.contextGate),
				`contextGate must admit a ${context}-classified turn`,
			).toBe(true);
		}
	});

	it("does not hijack a genuine settings-navigation turn", () => {
		// "open the settings" has no background vocabulary. The candidate-matched
		// VIEWS must stay ranked FIRST (candidate keeps sort ahead of
		// retrieval-override keeps), so the planner sees VIEWS as the primary
		// tool. BACKGROUND may remain exposed lower down — every settings-context
		// action rides the shared settings keyword — but it must not outrank the
		// navigation action the Stage-1 candidates named.
		const { tiered } = routeTurn({
			messageText: "open the settings",
			candidateActions: ["OPEN_SETTINGS"],
			selectedContexts: ["settings"],
		});
		const tierA = tiered.tierAParents.map((parent) => parent.name);
		expect(tierA[0]).toBe("VIEWS");
		if (tierA.includes("BACKGROUND")) {
			expect(tierA.indexOf("VIEWS")).toBeLessThan(tierA.indexOf("BACKGROUND"));
		}
	});
});
