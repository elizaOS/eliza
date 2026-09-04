import { describe, expect, it } from "vitest";
import type { Action } from "../types/components";
import {
	collectBudgetedStageOneCandidateActions,
	messageHandlerFromFieldResult,
} from "./message";

const actions: Action[] = [
	{
		name: "PAGE",
		description: "Page operations",
		subActions: ["GO", "READ_PAGE"],
	},
	{ name: "GO", description: "Navigate" },
	{ name: "READ_PAGE", description: "Read the loaded page" },
	{ name: "UNRELATED", description: "Another domain" },
];

describe("budgeted model-selected action surface", () => {
	it("preserves the model's complete intent list in the planner handoff", () => {
		const intents = [
			"open notes",
			"update the note body",
			"preserve its title",
		];
		const result = messageHandlerFromFieldResult({
			shouldRespond: "RESPOND",
			contexts: ["notes"],
			intents,
			candidateActionNames: ["VIEWS", "NOTES"],
			replyText: "",
			facts: [],
			relationships: [],
			addressedTo: [],
		});
		expect(result.plan.intents).toEqual(intents);
	});
	it("retains a selected child's authorized umbrella without exposing unrelated domains", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions,
				candidateActions: ["GO"],
				contexts: [],
			}).map((action) => action.name),
		).toEqual(["PAGE", "GO"]);
	});

	it("does not reintroduce a gated parent or infer one from name prefixes", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: actions.filter((action) => action.name !== "PAGE"),
				candidateActions: ["READ_PAGE"],
				contexts: [],
			}).map((action) => action.name),
		).toEqual(["READ_PAGE"]);
	});

	it("keeps the existing complete-surface fallback for unresolved candidates", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions,
				candidateActions: ["GO", "MISSING_CAPABILITY"],
				contexts: [],
			}),
		).toEqual([]);
	});

	it("retains model-selected domain actions when a synthetic candidate aliases to navigation", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: [
					{ name: "VIEWS", description: "Navigation" },
					{
						name: "NOTES",
						description: "Note data",
						contexts: ["notes", "general"],
					},
					{
						name: "CALENDAR",
						description: "Events",
						contexts: ["calendar", "general"],
					},
				],
				candidateActions: ["VIEWS", "NOTES_CREATE_NOTE"],
				contexts: ["notes", "general"],
			}).map((action) => action.name),
		).toEqual(["VIEWS", "NOTES"]);
	});

	it("does not broaden the surface based on generic or current-page contexts", () => {
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: [
					...actions,
					{ name: "GENERIC", description: "General", contexts: ["general"] },
					{
						name: "PAGE_ONLY",
						description: "Page",
						contexts: ["page", "page-notes"],
					},
				],
				candidateActions: ["GO"],
				contexts: ["general", "page", "page-notes"],
			}).map((action) => action.name),
		).toEqual(["PAGE", "GO"]);
	});

	it("does not expand a resolved Calendar candidate to every action sharing its context", () => {
		const calendarActions: Action[] = [
			{ name: "VIEWS", description: "Navigation", contexts: ["general"] },
			{
				name: "CALENDAR",
				description: "Calendar",
				contexts: ["calendar", "tasks"],
			},
			{
				name: "OWNER_ROUTINES",
				description: "Routines",
				contexts: ["calendar"],
			},
			{
				name: "OWNER_DOCUMENTS",
				description: "Documents",
				contexts: ["calendar"],
			},
		];
		expect(
			collectBudgetedStageOneCandidateActions({
				actions: calendarActions,
				candidateActions: ["VIEWS", "CALENDAR"],
				contexts: ["calendar"],
			}).map((action) => action.name),
		).toEqual(["VIEWS", "CALENDAR"]);
	});
});
