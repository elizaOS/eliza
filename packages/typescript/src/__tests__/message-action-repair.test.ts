import { describe, expect, it } from "vitest";
import { inferPlannerActionRepairCandidates } from "../services/message";

describe("planner action repair heuristics", () => {
	it("repairs recurring Jill time blocks to calendar actions", () => {
		expect(
			inferPlannerActionRepairCandidates({
				messageText:
					"Need to book 1 hour per day for time with Jill. Any time is fine, ideally before sleep.",
				selectedActions: [],
			}),
		).toEqual(["CALENDAR_ACTION", "PROPOSE_MEETING_TIMES"]);
	});

	it("overrides missed-call repair requests away from slot-proposal only", () => {
		expect(
			inferPlannerActionRepairCandidates({
				messageText:
					"I missed a call with the Frontier Tower guys today. Need to repair that and reschedule if possible asap.",
				selectedActions: ["PROPOSE_MEETING_TIMES"],
			}),
		).toEqual([
			"INBOX",
			"GMAIL_ACTION",
			"CROSS_CHANNEL_SEND",
			"CALENDAR_ACTION",
		]);
	});

	it("repairs portal-upload policies to computer-use actions", () => {
		expect(
			inferPlannerActionRepairCandidates({
				messageText: "When I send over the deck, upload it to the portal for me.",
				selectedActions: [],
			}),
		).toEqual(["LIFEOPS_COMPUTER_USE", "PUBLISH_DEVICE_INTENT"]);
	});

	it("repairs stuck-browser escalation policies to call-user actions", () => {
		expect(
			inferPlannerActionRepairCandidates({
				messageText:
					"If you get stuck in the browser or on my computer, call me and let me jump in to unblock it.",
				selectedActions: [],
			}),
		).toEqual(["CALL_USER", "LIFEOPS_COMPUTER_USE"]);
	});

	it("overrides life-task drift for event asset checklists", () => {
		expect(
			inferPlannerActionRepairCandidates({
				messageText:
					"Tell me what slides, bio, title, or portal assets I still owe before the event.",
				selectedActions: ["LIFE"],
			}),
		).toEqual(["INBOX", "CALENDAR_ACTION", "LIFEOPS_COMPUTER_USE"]);
	});

	it("repairs daily briefs back to inbox actions", () => {
		expect(
			inferPlannerActionRepairCandidates({
				messageText:
					"Give me the daily brief with actions first, then reminders, then unread messages across channels.",
				selectedActions: ["LIFE"],
			}),
		).toEqual(["INBOX", "CALENDAR_ACTION", "SEARCH_ACROSS_CHANNELS"]);
	});

	it("repairs signature reminders before appointments", () => {
		expect(
			inferPlannerActionRepairCandidates({
				messageText:
					"The clinic sent docs for me to sign before the appointment. Keep me on top of that.",
				selectedActions: [],
			}),
		).toEqual(["PUBLISH_DEVICE_INTENT", "LIFE", "CALENDAR_ACTION"]);
	});

	it("repairs bundled-travel scheduling requests", () => {
		expect(
			inferPlannerActionRepairCandidates({
				messageText:
					"I'm in Tokyo for limited time, so schedule PendingReality and Ryan at the same time if possible.",
				selectedActions: [],
			}),
		).toEqual(["PROPOSE_MEETING_TIMES", "CALENDAR_ACTION"]);
	});

	it("repairs dossier requests for the next meeting", () => {
		expect(
			inferPlannerActionRepairCandidates({
				messageText: "Give me the dossier for my next meeting or event.",
				selectedActions: [],
			}),
		).toEqual(["DOSSIER", "CALENDAR_ACTION"]);
	});

	it("suppresses repair on subtle null prompts", () => {
		expect(
			inferPlannerActionRepairCandidates({
				messageText:
					"Do not do this yet. I'm only thinking out loud: When I send over the deck, upload it to the portal for me.",
				selectedActions: [],
			}),
		).toBeNull();
	});
});
