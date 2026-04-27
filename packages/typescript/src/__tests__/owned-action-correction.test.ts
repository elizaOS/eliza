import { describe, expect, it } from "vitest";
import { findOwnedActionCorrectionFromMetadata } from "../services/message.ts";

describe("findOwnedActionCorrectionFromMetadata", () => {
	it("returns null when planner already included an explicit-intent action (SPAWN_AGENT)", () => {
		// Regression: the metadata corrector scores actions by keyword overlap
		// against the user message. SPAWN_AGENT has no keywords to match, so for
		// any coding-delegation request the scorer would otherwise rank a cross-
		// channel send action higher and silently override the planner's
		// deliberate SPAWN_AGENT choice, breaking the delegation.
		const result = findOwnedActionCorrectionFromMetadata(
			{ actions: [] },
			{ content: { text: "send a small pr to elizaOS/eliza" } },
			{ actions: ["REPLY", "SPAWN_AGENT"] },
		);
		expect(result).toBeNull();
	});

	it("returns null when planner picked SPAWN_AGENT alone", () => {
		const result = findOwnedActionCorrectionFromMetadata(
			{ actions: [] },
			{ content: { text: "build me an app that tracks coffee" } },
			{ actions: ["SPAWN_AGENT"] },
		);
		expect(result).toBeNull();
	});

	it("returns null when response has no actions", () => {
		const result = findOwnedActionCorrectionFromMetadata(
			{ actions: [] },
			{ content: { text: "anything" } },
			{ actions: [] },
		);
		expect(result).toBeNull();
	});

	it("returns a suggestion when the planner chose a low-scoring owned action", () => {
		// Positive-path guard: a future refactor that always returned null from
		// the explicit-intent early-return would still pass the three cases
		// above. This keeps the corrector's real job under test — upgrading a
		// weak planner pick to a clearly better owned action by keyword overlap.
		const runtime = {
			actions: [
				{
					name: "OWNER_SEND_MESSAGE",
					description:
						"Send a discord message to a contact or channel when the user asks to send, text, ping, or dm someone. Use this for owner send workflows.",
					tags: ["workflow"],
					similes: ["send discord message"],
				},
				{
					name: "READ_CALENDAR",
					description: "Read the user's calendar.",
				},
			],
		};
		const result = findOwnedActionCorrectionFromMetadata(
			runtime,
			{ content: { text: "send a discord message to the team channel" } },
			{ actions: ["READ_CALENDAR"] },
		);
		expect(result).not.toBeNull();
		expect(result?.actionName).toBe("OWNER_SEND_MESSAGE");
	});

	// Regression: an LLM pick of CREATE_CRON for "every 9 minutes write a
	// ping log entry" was overridden to LIFE by the keyword-overlap scorer
	// because LIFE's multi-paragraph description mentions reminders,
	// alarms, and recurring verbs. That reroute broke trigger creation on
	// page-automations because LIFE's handler — gated by the dispatch-time
	// scope guard on foreign page-* scopes — short-circuits to empty, so
	// no trigger is created. Adding CREATE_TRIGGER_TASK + its schedule
	// similes to EXPLICIT_INTENT_ACTIONS makes the planner's schedule
	// picks authoritative, same as SPAWN_AGENT.
	describe("schedule-intent planner picks are authoritative", () => {
		const runtime = {
			actions: [
				{
					name: "LIFE",
					// Truncated real LIFE description with reminder/alarm vocabulary.
					description:
						"Manage the user's personal routines, habits, goals, reminders, alarms, and escalation settings through LifeOps. USE this action for: creating, editing, or deleting tasks, habits, routines, and goals; todo and goal requests like 'add a todo', 'remember to call mom', or 'set a goal'; setting one-off alarms or wake-up reminders.",
					similes: ["CREATE_HABIT", "SET_ALARM", "CREATE_TODO"],
				},
				{
					name: "CREATE_TRIGGER_TASK",
					description:
						"Create a scheduled task that executes on a schedule (interval, once, or cron). Use when the user wants to schedule, automate, or create a recurring/timed task, trigger, or heartbeat.",
					similes: [
						"CREATE_TRIGGER",
						"SCHEDULE_TRIGGER",
						"SCHEDULE_TASK",
						"CREATE_HEARTBEAT",
						"SCHEDULE_HEARTBEAT",
						"CREATE_AUTOMATION",
						"SCHEDULE_AUTOMATION",
						"CREATE_CRON",
						"CREATE_RECURRING",
					],
				},
			],
		};

		it.each([
			"CREATE_TRIGGER_TASK",
			"CREATE_CRON",
			"CREATE_TRIGGER",
			"SCHEDULE_TRIGGER",
			"SCHEDULE_TASK",
			"CREATE_HEARTBEAT",
			"SCHEDULE_HEARTBEAT",
			"CREATE_AUTOMATION",
			"SCHEDULE_AUTOMATION",
			"CREATE_RECURRING",
		])("treats %s as explicit intent (no override to LIFE)", (actionName) => {
			const result = findOwnedActionCorrectionFromMetadata(
				runtime,
				{ content: { text: "every 9 minutes write a ping log entry" } },
				{ actions: [actionName] },
			);
			expect(result).toBeNull();
		});
	});
});
