import { describe, expect, it, vi } from "vitest";
import {
	extractPlannerActionNames,
	extractPlannerProviderNames,
	resolvePlannerActionName,
	suggestOwnedActionFromMetadata,
} from "../services/message.ts";
import type { Action, Memory } from "../types";

describe("extractPlannerActionNames", () => {
	it("parses bare XML action entries without nested <name> tags", () => {
		expect(
			extractPlannerActionNames({
				actions:
					"<action>CALENDAR_ACTION</action><action>REQUEST_FIELD_FILL</action>",
			}),
		).toEqual(["CALENDAR_ACTION", "REQUEST_FIELD_FILL"]);
	});

	it("normalizes action arrays that still contain XML wrappers", () => {
		expect(
			extractPlannerActionNames({
				actions: ['<action>CALENDAR_ACTION</action>', '"REQUEST_FIELD_FILL"'],
			}),
		).toEqual(["CALENDAR_ACTION", "REQUEST_FIELD_FILL"]);
	});
});

describe("extractPlannerProviderNames", () => {
	it("parses structured provider lists and rejects prose fallback junk", () => {
		expect(
			extractPlannerProviderNames({
				providers: "CURRENT_TIME, ATTACHMENTS",
			}),
		).toEqual(["CURRENT_TIME", "ATTACHMENTS"]);
		expect(
			extractPlannerProviderNames({
				providers:
					"Use CURRENT_TIME and maybe ATTACHMENTS if needed for this reply.",
			}),
		).toEqual([]);
	});

	it("parses XML provider tags but ignores malformed XML prose", () => {
		expect(
			extractPlannerProviderNames({
				providers:
					"<provider>CURRENT_TIME</provider><provider>ATTACHMENTS</provider>",
			}),
		).toEqual(["CURRENT_TIME", "ATTACHMENTS"]);
		expect(
			extractPlannerProviderNames({
				providers:
					"<providers>I think CURRENT_TIME would help here</providers>",
			}),
		).toEqual([]);
	});
});

describe("resolvePlannerActionName", () => {
	it("repairs observed calendar-planning aliases into registered actions", () => {
		const runtime = {
			actions: [
				{ name: "OWNER_CALENDAR" },
				{ name: "UPDATE_OWNER_PROFILE" },
				{ name: "PUBLISH_DEVICE_INTENT" },
				{ name: "LIFEOPS_COMPUTER_USE" },
				{ name: "BOOK_TRAVEL" },
				{ name: "CALL_EXTERNAL" },
			],
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
			},
		} as Parameters<typeof resolvePlannerActionName>[0];
		const actionLookup = new Map(
			runtime.actions.map((action) => [action.name.replace(/_/g, ""), action]),
		);

		expect(
			resolvePlannerActionName(runtime, actionLookup, "BULK_RESCHEDULE"),
		).toEqual(["OWNER_CALENDAR"]);
		expect(
			resolvePlannerActionName(runtime, actionLookup, "GET_AVAILABILITY"),
		).toEqual(["OWNER_CALENDAR"]);
		expect(
			resolvePlannerActionName(
				runtime,
				actionLookup,
				"CREATE_TRAVEL_PREFERENCES",
			),
		).toEqual(["UPDATE_OWNER_PROFILE"]);
		expect(
			resolvePlannerActionName(
				runtime,
				actionLookup,
				"HANDLE_CANCELLATION_FEE",
			),
		).toEqual(["PUBLISH_DEVICE_INTENT"]);
		expect(
			resolvePlannerActionName(
				runtime,
				actionLookup,
				"SET_MULTI_DEVICE_REMINDER",
			),
		).toEqual(["PUBLISH_DEVICE_INTENT"]);
		expect(resolvePlannerActionName(runtime, actionLookup, "UPLOAD_PORTAL")).toEqual(
			["LIFEOPS_COMPUTER_USE"],
		);
		expect(resolvePlannerActionName(runtime, actionLookup, "BOOK_TRAVEL")).toEqual(
			["BOOK_TRAVEL"],
		);
	});
});

describe("suggestOwnedActionFromMetadata", () => {
	function buildAction(
		overrides: Partial<Action> & Pick<Action, "name" | "description">,
	): Action {
		return {
			name: overrides.name,
			description: overrides.description,
			handler: async () => undefined,
			validate: async () => true,
			...overrides,
		};
	}

	function buildMessage(text: string): Pick<Memory, "content"> {
		return { content: { text } };
	}

	it("recovers computer-use ownership for delegated future portal uploads", () => {
		const runtime = {
			actions: [
				buildAction({
					name: "LIFEOPS_COMPUTER_USE",
					description:
						"Use this for portal uploads and browser workflows, including standing instructions like when I send the file, upload it to the portal for me.",
					tags: ["portal upload", "upload deck", "future upload policy"],
					examples: [
						[
							{
								name: "{{name1}}",
								content: {
									text: "When I send over the deck, upload it to the portal for me.",
								},
							},
						],
					],
				}),
				buildAction({
					name: "PUBLISH_DEVICE_INTENT",
					description: "Use this for cross-device reminders and warnings.",
					tags: ["reminder", "warning"],
				}),
			],
		};

		expect(
			suggestOwnedActionFromMetadata(
				runtime,
				buildMessage("When I send over the deck, upload it to the portal for me."),
			),
		).toMatchObject({
			actionName: "LIFEOPS_COMPUTER_USE",
		});
	});

	it("recovers device-intent ownership for workflow warnings and artifact nudges", () => {
		const runtime = {
			actions: [
				buildAction({
					name: "PUBLISH_DEVICE_INTENT",
					description:
						"Use this for updated-ID interventions, cancellation-fee warnings, and other standing warning policies.",
					tags: [
						"updated id copy",
						"workflow escalation",
						"cancellation fee warning",
					],
					examples: [
						[
							{
								name: "{{name1}}",
								content: {
									text: "If the only ID on file is expired, ask me for an updated copy so the workflow can continue.",
								},
							},
						],
						[
							{
								name: "{{name1}}",
								content: {
									text: "If missing this could trigger a cancellation fee, warn me clearly and offer to handle it now.",
								},
							},
						],
						[
							{
								name: "{{name1}}",
								content: {
									text: "The clinic sent docs for me to sign before the appointment. Keep me on top of that.",
								},
							},
						],
					],
				}),
				buildAction({
					name: "LIFEOPS_COMPUTER_USE",
					description: "Use this for browser and portal workflows.",
					tags: ["portal upload"],
				}),
			],
		};

		expect(
			suggestOwnedActionFromMetadata(
				runtime,
				buildMessage(
					"If the only ID on file is expired, ask me for an updated copy so the workflow can continue.",
				),
			),
		).toMatchObject({
			actionName: "PUBLISH_DEVICE_INTENT",
		});
		expect(
			suggestOwnedActionFromMetadata(
				runtime,
				buildMessage(
					"If missing this could trigger a cancellation fee, warn me clearly and offer to handle it now.",
				),
			),
		).toMatchObject({
			actionName: "PUBLISH_DEVICE_INTENT",
		});
		expect(
			suggestOwnedActionFromMetadata(
				runtime,
				buildMessage(
					"The clinic sent docs for me to sign before the appointment. Keep me on top of that.",
				),
			),
		).toMatchObject({
			actionName: "PUBLISH_DEVICE_INTENT",
		});
	});

	it("prefers calendar ownership over device intents for protected sleep windows", () => {
		const runtime = {
			actions: [
				buildAction({
					name: "OWNER_CALENDAR",
					description:
						"Owner calendar umbrella. Sleep windows, no-call hours, blackout windows, and meeting preferences belong here. Requests that define when meetings or calls may be scheduled, even in a policy form like 'no calls between 11pm and 8am unless I explicitly say it's okay', belong here.",
					tags: [
						"sleep window",
						"no-call hours",
						"protected hours",
						"meeting preferences",
					],
					similes: ["UPDATE_MEETING_PREFERENCES", "NO_CALL_HOURS"],
					examples: [
						[
							{
								name: "{{name1}}",
								content: {
									text: "No calls between 11pm and 8am unless I explicitly say it's okay.",
								},
							},
						],
					],
				}),
				buildAction({
					name: "PUBLISH_DEVICE_INTENT",
					description:
						"Publish cross-device reminders and warnings. Do not use this for scheduling preferences like protected sleep windows or no-call meeting hours; those belong to OWNER_CALENDAR.",
					tags: ["device reminder", "warning", "cross-device escalation"],
				}),
			],
		};

		expect(
			suggestOwnedActionFromMetadata(
				runtime,
				buildMessage(
					"sorry my english not perfect but no calls between 11pm and 8am unless I explicitly say it's okay please",
				),
			),
		).toMatchObject({
			actionName: "OWNER_CALENDAR",
		});
	});

	it("stays out of non-actionable chat", () => {
		const runtime = {
			actions: [
				buildAction({
					name: "PUBLISH_DEVICE_INTENT",
					description: "Use this for warnings and reminders.",
					tags: ["warning"],
				}),
			],
		};

		expect(
			suggestOwnedActionFromMetadata(
				runtime,
				buildMessage("I hate cancellation fees."),
			),
		).toBeNull();
	});

	it("prefers inbox ownership over generic life tracking for event asset checklists", () => {
		const runtime = {
			actions: [
				buildAction({
					name: "OWNER_INBOX",
					description:
						"Use this for inbox-shaped coordination, including event asset checklists like slides, bio, title, or portal assets still owed before an event.",
					tags: ["event asset checklist", "slides", "bio", "title", "portal"],
					examples: [
						[
							{
								name: "{{name1}}",
								content: {
									text: "Tell me what slides, bio, title, or portal assets I still owe before the event.",
								},
							},
						],
					],
				}),
				buildAction({
					name: "LIFE",
					description:
						"Use this for tasks, habits, goals, reminders, and LifeOps follow-through. Do not use it for pre-event asset checklists.",
					tags: ["todo", "habit", "goal", "reminder"],
				}),
			],
		};

		expect(
			suggestOwnedActionFromMetadata(
				runtime,
				buildMessage(
					"Tell me what slides, bio, title, or portal assets I still owe before the event.",
				),
			),
		).toMatchObject({
			actionName: "OWNER_INBOX",
		});
	});

	it("recovers calendar ownership for bulk partnership reschedules", () => {
		const runtime = {
			actions: [
				buildAction({
					name: "OWNER_CALENDAR",
					description:
						"Use this for calendar-owned requests, including bulk requests to cancel or push a cohort of meetings into next month.",
					tags: ["bulk partnership reschedule", "push meetings to next month"],
					examples: [
						[
							{
								name: "{{name1}}",
								content: {
									text: "We're gonna cancel some stuff and push everything back until next month. All partnership meetings.",
								},
							},
						],
					],
				}),
				buildAction({
					name: "REPLY",
					description: "Direct chat reply.",
				}),
			],
		};

		expect(
			suggestOwnedActionFromMetadata(
				runtime,
				buildMessage(
					"We're gonna cancel some stuff and push everything back until next month. All partnership meetings.",
				),
			),
		).toMatchObject({
			actionName: "OWNER_CALENDAR",
		});
	});
});
