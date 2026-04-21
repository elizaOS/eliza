import { describe, expect, it } from "vitest";
import { ACTION_BENCHMARK_CASES } from "../../../app-core/test/benchmarks/action-selection-cases.ts";
import {
	composeActionExamples,
	formatActionNames,
	formatActions,
	parseActionParams,
	validateActionParams,
} from "../actions";
import { allActionDocs } from "../generated/action-docs";
import type { Action } from "../types";

describe("Actions", () => {
	const mockActions: Action[] = [
		{
			name: "greet",
			description: "Greet someone",
			examples: [
				[
					{ name: "name1", content: { text: "Hello {{name2}}!" } },
					{
						name: "name2",
						content: { text: "Hi {{name1}}!", action: "wave" },
					},
				],
				[
					{
						name: "name1",
						content: { text: "Hey {{name2}}, how are you?" },
					},
					{
						name: "name2",
						content: { text: "I'm good {{name1}}, thanks!" },
					},
				],
			],
			similes: ["say hi", "welcome"],
			handler: async () => {
				throw new Error("Not implemented");
			},
			validate: async () => {
				throw new Error("Not implemented");
			},
		},
		{
			name: "farewell",
			description: "Say goodbye",
			examples: [
				[
					{ name: "name1", content: { text: "Goodbye {{name2}}!" } },
					{ name: "name2", content: { text: "Bye {{name1}}!" } },
				],
			],
			similes: ["say bye", "leave"],
			handler: async () => {
				throw new Error("Not implemented");
			},
			validate: async () => {
				throw new Error("Not implemented");
			},
		},
		{
			name: "help",
			description: "Get assistance",
			examples: [
				[
					{
						name: "name1",
						content: { text: "Can you help me {{name2}}?" },
					},
					{
						name: "name2",
						content: {
							text: "Of course {{name1}}, what do you need?",
							action: "assist",
						},
					},
				],
			],
			similes: ["assist", "support"],
			handler: async () => {
				throw new Error("Not implemented");
			},
			validate: async () => {
				throw new Error("Not implemented");
			},
		},
	];

	describe("composeActionExamples", () => {
		it("should be deterministic for the same seed", () => {
			const first = composeActionExamples(mockActions, 2, "room-seed");
			const second = composeActionExamples(mockActions, 2, "room-seed");
			expect(first).toBe(second);
		});

		it("should generate examples with correct format", () => {
			const examples = composeActionExamples(mockActions, 1);
			const lines = examples.trim().split("\n");
			expect(lines.length).toBeGreaterThan(0);
			expect(lines[0]).toMatch(/^name\d: .+/);
		});

		it("should replace name placeholders with generated names", () => {
			const examples = composeActionExamples(mockActions, 1);
			expect(examples).not.toContain("{{name1}}");
			expect(examples).not.toContain("{{name2}}");
		});

		it("should handle empty actions array", () => {
			const examples = composeActionExamples([], 5);
			expect(examples).toBe("");
		});

		it("should handle count larger than available examples", () => {
			const examples = composeActionExamples(mockActions, 10);
			expect(examples.length).toBeGreaterThan(0);
		});

		it("should handle actions without examples", () => {
			const actionsWithoutExamples: Action[] = [
				{
					name: "test",
					description: "Test action without examples",
					examples: [], // Empty examples array
					similes: [],
					handler: async () => {
						throw new Error("Not implemented");
					},
					validate: async () => {
						throw new Error("Not implemented");
					},
				},
				{
					name: "test2",
					description: "Test action with no examples property",
					// examples property not defined
					similes: [],
					handler: async () => {
						throw new Error("Not implemented");
					},
					validate: async () => {
						throw new Error("Not implemented");
					},
				} as Action,
			];

			const examples = composeActionExamples(actionsWithoutExamples, 5);
			expect(examples).toBe("");
		});

		it("should handle count of zero", () => {
			const examples = composeActionExamples(mockActions, 0);
			expect(examples).toBe("");
		});

		it("should handle negative count", () => {
			const examples = composeActionExamples(mockActions, -5);
			expect(examples).toBe("");
		});
	});

	describe("formatActionNames", () => {
		it("should keep action ordering deterministic for the same seed", () => {
			const first = formatActionNames(
				[mockActions[0], mockActions[1], mockActions[2]],
				"room-seed",
			);
			const second = formatActionNames(
				[mockActions[0], mockActions[1], mockActions[2]],
				"room-seed",
			);
			expect(first).toBe(second);
		});

		it("should format action names correctly", () => {
			const formatted = formatActionNames([mockActions[0], mockActions[1]]);
			expect(formatted).toMatch(/^(greet|farewell)(, (greet|farewell))?$/);
		});

		it("should handle single action", () => {
			const formatted = formatActionNames([mockActions[0]]);
			expect(formatted).toBe("greet");
		});

		it("should handle empty actions array", () => {
			const formatted = formatActionNames([]);
			expect(formatted).toBe("");
		});
	});

	describe("formatActions", () => {
		it("should format actions with descriptions", () => {
			const formatted = formatActions([mockActions[0]]);
			expect(formatted).toContain("actions[1]:");
			expect(formatted).toContain("- greet:");
			expect(formatted).toContain("Greet someone");
			expect(formatted).toContain("aliases[2]: say hi, welcome");
		});

		it("should include parameter definitions and examples when present", () => {
			const formatted = formatActions([
				{
					name: "MOVE",
					description: "Move the agent.",
					parameters: [
						{
							name: "direction",
							description: "Direction to move.",
							required: true,
							schema: { type: "string", enum: ["north", "south"] },
							examples: ["north", "south"],
						},
					],
					examples: [],
					similes: [],
					handler: async () => {
						throw new Error("Not implemented");
					},
					validate: async () => {
						throw new Error("Not implemented");
					},
				},
			]);

			expect(formatted).toContain("- MOVE: Move the agent.");
			expect(formatted).toContain("params[1]:");
			expect(formatted).toContain("direction:string");
			expect(formatted).toContain("values=north|south");
			expect(formatted).toContain('examples="north"|"south"');
		});

		it("includes action-tagged example hints when available", () => {
			const formatted = formatActions([
				{
					name: "LIFE",
					description: "Manage habits.",
					examples: [
						[
							{
								name: "name1",
								content: {
									text: "help me brush my teeth at 8 am and 9 pm every day",
								},
							},
							{
								name: "name2",
								content: {
									text: 'I can set up a habit named "Brush teeth".',
									actions: ["LIFE"],
								},
							},
						],
					],
					similes: [],
					handler: async () => {
						throw new Error("Not implemented");
					},
					validate: async () => {
						throw new Error("Not implemented");
					},
				},
			]);

			expect(formatted).toContain(
				'example: User: "help me brush my teeth at 8 am and 9 pm every day" -> actions: LIFE',
			);
		});

		it("deduplicates and trims aliases before rendering them", () => {
			const formatted = formatActions([
				{
					name: "FOLLOW_UP",
					description: "Schedule a follow-up.",
					examples: [],
					similes: ["  ping back  ", "ping back", "", "check in"],
					handler: async () => {
						throw new Error("Not implemented");
					},
					validate: async () => {
						throw new Error("Not implemented");
					},
				},
			]);

			expect(formatted).toContain("aliases[2]: ping back, check in");
			expect(formatted).not.toContain("aliases[4]");
		});

		it("should include commas and newlines between multiple actions", () => {
			const formatted = formatActions([mockActions[0], mockActions[1]]);
			expect(formatted).toContain("actions[2]:");
			expect(formatted).toContain("greet");
			expect(formatted).toContain("farewell");
		});

		it("should handle empty actions array", () => {
			const formatted = formatActions([]);
			expect(formatted).toBe("");
		});
	});

	describe("Action benchmark cases", () => {
		it("keeps structurally tricky routing cases single-turn and supported", () => {
			const casesById = new Map(
				ACTION_BENCHMARK_CASES.map((testCase) => [testCase.id, testCase]),
			);

			expect(casesById.has("cross-send-slack")).toBe(false);
			expect(casesById.get("cross-send-signal")).toMatchObject({
				expectedAction: "OWNER_SEND_MESSAGE",
				userMessage:
					"send a Signal message to Priya saying thanks for the review",
			});

			expect(casesById.has("computer-use-fill-form")).toBe(false);
			expect(casesById.get("computer-use-screenshot")).toMatchObject({
				expectedAction: "LIFEOPS_COMPUTER_USE",
				userMessage: "take a screenshot of my desktop",
			});

			expect(casesById.has("intent-sync-send-to-mobile")).toBe(false);
			expect(
				casesById.get("intent-sync-mobile-routine-reminder"),
			).toMatchObject({
				expectedAction: "INTENT_SYNC",
				expectedParams: {
					subaction: "broadcast",
					kind: "routine_reminder",
					target: "mobile",
					title: "Stretch break",
					body: "Get up and stretch for five minutes",
				},
			});

			expect(casesById.has("calendly-list-slots")).toBe(false);
			expect(casesById.get("calendly-check-availability")).toMatchObject({
				expectedAction: "OWNER_CALENDAR",
				expectedParams: {
					subaction: "availability",
					eventTypeUri: "https://api.calendly.com/event_types/abc",
					startDate: "2026-04-20",
					endDate: "2026-04-24",
				},
			});
			expect(casesById.get("calendly-create-single-use-link")).toMatchObject({
				expectedAction: "OWNER_CALENDAR",
				expectedParams: {
					subaction: "single_use_link",
					eventTypeUri: "https://api.calendly.com/event_types/abc",
				},
			});
		});
	});

	describe("parseActionParams", () => {
		it("parses JSON payloads inside legacy flat action wrappers", () => {
			const params = parseActionParams(
				'<LIFE>{"action":"create","intent":"create a habit to brush teeth at 8am and 9pm daily","title":"Brush Teeth"}</LIFE>',
			);

			expect(params.get("LIFE")).toEqual({
				action: "create",
				intent: "create a habit to brush teeth at 8am and 9pm daily",
				title: "Brush Teeth",
			});
		});
	});

	describe("validateActionParams", () => {
		it("coerces comma-separated strings into string arrays for array params", () => {
			const action: Action = {
				name: "BLOCK_WEBSITES",
				description: "Block websites.",
				parameters: [
					{
						name: "websites",
						description: "Website hostnames to block.",
						required: true,
						schema: {
							type: "array",
							items: { type: "string" },
						},
					},
				],
				examples: [],
				similes: [],
				handler: async () => {
					throw new Error("Not implemented");
				},
				validate: async () => {
					throw new Error("Not implemented");
				},
			};

			expect(
				validateActionParams(action, {
					websites: "x.com, twitter.com",
				}),
			).toEqual({
				valid: true,
				params: {
					websites: ["x.com", "twitter.com"],
				},
				errors: [],
			});
		});
	});

	describe("Action Structure", () => {
		it("keeps REPLY scoped to chat replies in the current conversation", () => {
			const replyDoc = allActionDocs.find((doc) => doc.name === "REPLY");
			expect(replyDoc).toBeDefined();
			expect(replyDoc?.description).toContain(
				"direct chat reply in the current conversation/thread",
			);
			expect(replyDoc?.description).toContain(
				"not an email reply, inbox workflow, or external-channel send",
			);
			expect(replyDoc?.similes ?? []).not.toContain("REPLY_TO_MESSAGE");
			expect(replyDoc?.similes ?? []).not.toContain("SEND_REPLY");
		});

		it("should validate action structure", () => {
			for (const action of mockActions) {
				expect(action).toHaveProperty("name");
				expect(action).toHaveProperty("description");
				expect(action).toHaveProperty("examples");
				expect(action).toHaveProperty("similes");
				expect(action).toHaveProperty("handler");
				expect(action).toHaveProperty("validate");
				expect(Array.isArray(action.examples)).toBe(true);
				expect(Array.isArray(action.similes)).toBe(true);
			}
		});

		it("should validate example structure", () => {
			for (const action of mockActions) {
				for (const example of action.examples ?? []) {
					for (const message of example) {
						expect(message).toHaveProperty("name");
						expect(message).toHaveProperty("content");
						expect(message.content).toHaveProperty("text");
					}
				}
			}
		});

		it("should have unique action names", () => {
			const names = mockActions.map((action) => action.name);
			const uniqueNames = new Set(names);
			expect(names.length).toBe(uniqueNames.size);
		});
	});
});
