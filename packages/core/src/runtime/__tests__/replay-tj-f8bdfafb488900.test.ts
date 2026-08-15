/**
 * Replay of live trajectory tj-f8bdfafb488900 (nubilio box, 2026-08-15) as
 * deterministic pins on hint membership in the retrieval surface. The live
 * turn — "now delete the submit the invoice reminder too" routed to
 * CLOSE_ALL_VIEWS after a leaked [FOLLOWUPS] block poisoned the window — is
 * replayed with its real message text, the verbatim leaked window, the real
 * 25-parent catalog composition recorded in the trajectory's results, and the
 * real stage-1 outputs (contexts=["simple"], candidateActions=["OWNER_REMINDERS"]).
 *
 * Scenario A documents the honest negative: the "simple"-gated catalog never
 * contained OWNER_REMINDERS, so candidate resolution had nothing to bind and
 * NO retrieval-layer membership guarantee could have saved the turn — the
 * closing seams are upstream (control-block stripping of the window, and a
 * context-gate candidate override that pulls a candidate's parent through the
 * catalog gate). Scenarios B/C pin the protection that ALREADY holds when the
 * parent is in the catalog: the exact-hint stage plus the hint-cohort
 * tie-break keep hinted parents in the surface under keyword flood and under
 * a topK override, including several hints competing at exact reciprocal
 * ranks 1, 1/2, 1/3. These pins exist so future rrf/stage-weight tuning
 * cannot silently regress hint membership.
 */
import { describe, expect, it } from "vitest";
import { buildActionCatalog } from "../action-catalog";
import { retrieveActions } from "../action-retrieval";

// The 25 parents recorded in tj-f8bdfafb488900's retrieval results — the
// catalog surface the "simple" context gate left for that turn. Descriptions
// carry the vocabulary families that produced the recorded ranking.
const LIVE_TURN_PARENT_NAMES = [
	"CLOSE_ALL_VIEWS",
	"VIEWS",
	"CLOSE_VIEW",
	"APP",
	"PAGE_DELEGATE",
	"WORKFLOW",
	"CALENDAR_SOURCES",
	"LIST_CLOUD_APPS",
	"RUNTIME",
	"SETTINGS",
	"NOTES",
	"REPLY",
	"IGNORE",
	"PERSONALITY",
	"NONE",
	"COMPACT_CONVERSATION",
	"SEARCH_CHANNEL_TOPICS",
	"WEB_SEARCH",
	"TASKS_CONTROL",
	"TASKS_CREATE",
	"TASKS_HISTORY",
	"TASKS_SPAWN_AGENT",
	"TASKS_SUBMIT_WORKSPACE",
	"TASKS_MANAGE_ISSUES",
	"TASKS_SEND",
] as const;

const VIEW_FAMILY = new Set([
	"CLOSE_ALL_VIEWS",
	"VIEWS",
	"CLOSE_VIEW",
	"APP",
	"PAGE_DELEGATE",
]);

function liveTurnCatalogActions() {
	return LIVE_TURN_PARENT_NAMES.map((name) => ({
		name,
		description: VIEW_FAMILY.has(name)
			? `${name}: open, close, navigate, and arrange app views, pages, panels, and prompt followups.`
			: `${name}: ${name.toLowerCase().replaceAll("_", " ")} operations.`,
		similes:
			name === "CLOSE_ALL_VIEWS"
				? ["close everything", "close all apps"]
				: [],
	}));
}

const OWNER_REMINDERS_ACTION = {
	name: "OWNER_REMINDERS",
	description:
		"Create, list, update, and delete the owner's reminders and scheduled nudges.",
	similes: ["my reminders", "delete reminder", "reminders list"],
};

// Verbatim window from the live conversation (the previous reply leaked the
// [FOLLOWUPS] block that this trajectory's query tokens record).
const LIVE_WINDOW = [
	'Deleted "water the garden".',
	"delete the water the garden reminder and the submit the invoice reminder. both are test junk.",
	"2 scheduled items:\n- water the garden — tomorrow at 9am\n- Submit the invoice — tomorrow at 12pm\n\n[FOLLOWUPS]\nnavigate:/apps/reminders=Open reminders\nprompt:Delete water the garden=Delete water garden\nprompt:Delete Submit the invoice=Delete invoice\n[/FOLLOWUPS]",
	"list my reminders",
	"on it.",
	"delete all my reminders — submit the invoice, water the plants, stretch, check the kettle, sip water, flip the record. they were test entries, clear them all.",
	'Time to sip some water. Scheduled trigger "sip water" fired. Do this now: sip water',
];

const LIVE_MESSAGE = "now delete the submit the invoice reminder too";

describe("replay tj-f8bdfafb488900 — hint membership pins", () => {
	it("A (honest negative): the live 'simple'-gated catalog binds no candidate, so no membership guarantee could apply", () => {
		const catalog = buildActionCatalog(liveTurnCatalogActions());
		const response = retrieveActions({
			catalog,
			messageText: LIVE_MESSAGE,
			recentConversationText: LIVE_WINDOW,
			candidateActions: ["OWNER_REMINDERS"],
			selectedContexts: ["simple"],
		});
		// The alias fallback may still emit sibling hints (OWNER_REMINDERS →
		// TRIGGER), but none of them resolve to a catalog member: the gated
		// catalog contains neither the candidate nor its alias family, so
		// nothing exists for any retrieval-layer guarantee to protect.
		expect(response.query.parentActionHints).not.toContain("OWNER_REMINDERS");
		expect(
			response.results.some(
				(entry) => entry.name === "OWNER_REMINDERS" || entry.name === "TRIGGER",
			),
		).toBe(false);
		// The recorded live ranking shape: view family on top off the leaked
		// block's vocabulary.
		expect(VIEW_FAMILY.has(response.results[0]?.name ?? "")).toBe(true);
	});

	it("B (pin): with the parent in the catalog, the exact-hint floor keeps it in results under the same poison", () => {
		const catalog = buildActionCatalog([
			...liveTurnCatalogActions(),
			OWNER_REMINDERS_ACTION,
		]);
		const response = retrieveActions({
			catalog,
			messageText: LIVE_MESSAGE,
			recentConversationText: LIVE_WINDOW,
			candidateActions: ["OWNER_REMINDERS"],
			selectedContexts: ["simple"],
		});
		expect(response.query.parentActionHints).toEqual(["OWNER_REMINDERS"]);
		expect(
			response.results.some((entry) => entry.name === "OWNER_REMINDERS"),
		).toBe(true);
	});

	it("C (pin): a topK override retains every hinted parent even with several hints competing against a flood", () => {
		// Later hints carry exact-stage reciprocal ranks 1/2 and 1/3, the
		// weakest membership position the exact stage produces; this pin holds
		// today via stage scoring plus the hint-cohort tie-break and must keep
		// holding through any future rrf/stage-weight tuning.
		const catalog = buildActionCatalog([
			...liveTurnCatalogActions(),
			OWNER_REMINDERS_ACTION,
			{
				name: "TRIGGER",
				description:
					"Create, run, toggle, and delete timed triggers and scheduled prompts.",
				similes: ["set a trigger", "scheduled prompt"],
			},
			{
				name: "CALENDAR",
				description: "Read and mutate calendar events for the owner.",
				similes: ["calendar event"],
			},
		]);
		const response = retrieveActions({
			catalog,
			messageText: LIVE_MESSAGE,
			recentConversationText: LIVE_WINDOW,
			candidateActions: ["OWNER_REMINDERS", "TRIGGER", "CALENDAR"],
			selectedContexts: ["simple"],
			tierOverrides: { topK: 5, stageWeights: {} },
		});
		const names = response.results.map((entry) => entry.name);
		for (const hinted of ["OWNER_REMINDERS", "TRIGGER", "CALENDAR"]) {
			expect(names, `${hinted} missing from tier surface`).toContain(hinted);
		}
	});
});
