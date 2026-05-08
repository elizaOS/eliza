import { describe, expect, it } from "vitest";
import {
	HANDLE_RESPONSE_DIRECT_SCHEMA,
	HANDLE_RESPONSE_SCHEMA,
} from "../../actions/to-tool";
import { parseMessageHandlerOutput } from "../message-handler";

describe("message handler retrieval hint output", () => {
	it("parses, trims, dedupes, and caps retrieval hint arrays", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				processMessage: "RESPOND",
				thought: "Needs planner.",
				plan: {
					contexts: ["tasks"],
					contextSlices: [
						" slice:a ",
						"slice:b",
						"SLICE:A",
						"",
						7,
						"slice:c",
						"slice:d",
						"slice:e",
						"slice:f",
						"slice:g",
						"slice:h",
						"slice:i",
						"slice:j",
						"slice:k",
						"slice:l",
						"slice:m",
					],
					candidateActions: [
						" send_email ",
						"SEND_EMAIL",
						"calendar_create_event",
						"search_documents",
						"play_music",
						"create_task",
						"update_task",
						"phone_call",
						"browser_search",
						"book_travel",
						"health_steps",
						"message_contact",
						"settings_update",
						"extra_after_cap",
					],
					parentActionHints: [
						" EMAIL ",
						"email",
						"CALENDAR",
						"TASKS",
						"CONTACTS",
						"BROWSER",
						"PHONE",
						"EXTRA_AFTER_CAP",
					],
				},
			}),
		);

		expect(parsed?.plan.contextSlices).toEqual([
			"slice:a",
			"slice:b",
			"slice:c",
			"slice:d",
			"slice:e",
			"slice:f",
			"slice:g",
			"slice:h",
			"slice:i",
			"slice:j",
			"slice:k",
			"slice:l",
		]);
		expect(parsed?.plan.candidateActions).toEqual([
			"send_email",
			"calendar_create_event",
			"search_documents",
			"play_music",
			"create_task",
			"update_task",
			"phone_call",
			"browser_search",
			"book_travel",
			"health_steps",
			"message_contact",
			"settings_update",
		]);
		expect(parsed?.plan.parentActionHints).toEqual([
			"EMAIL",
			"CALENDAR",
			"TASKS",
			"CONTACTS",
			"BROWSER",
			"PHONE",
		]);
	});

	it("keeps missing hint arrays backward-compatible", () => {
		const parsed = parseMessageHandlerOutput(`{
  "processMessage": "RESPOND",
  "thought": "Calendar context is needed.",
  "plan": { "contexts": ["calendar"] }
}`);

		expect(parsed?.plan).toEqual({ contexts: ["calendar"], reply: undefined });
	});

	it("ignores non-array retrieval hint garbage", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				processMessage: "RESPOND",
				thought: "Needs planner.",
				plan: {
					contexts: ["email"],
					contextSlices: "slice:a",
					candidateActions: { action: "send_email" },
					parentActionHints: null,
				},
			}),
		);

		expect(parsed?.plan.contextSlices).toBeUndefined();
		expect(parsed?.plan.candidateActions).toBeUndefined();
		expect(parsed?.plan.parentActionHints).toBeUndefined();
	});

	it("exposes retrieval hint fields in normal and direct schemas", () => {
		const normalPlan = HANDLE_RESPONSE_SCHEMA.properties?.plan;
		const directPlan = HANDLE_RESPONSE_DIRECT_SCHEMA.properties?.plan;

		for (const plan of [normalPlan, directPlan]) {
			expect(plan?.properties).toMatchObject({
				contextSlices: { type: "array" },
				candidateActions: { type: "array" },
				parentActionHints: { type: "array" },
			});
			expect(plan?.required).toEqual(["contexts"]);
		}
	});
});
