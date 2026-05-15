import { describe, expect, it } from "vitest";
import { HANDLE_RESPONSE_SCHEMA } from "../../actions/to-tool";
import {
	BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
	replyTextFieldEvaluator,
} from "../builtin-field-evaluators";
import { parseMessageHandlerOutput } from "../message-handler";
import { ResponseHandlerFieldRegistry } from "../response-handler-field-registry";

describe("message handler retrieval hint output", () => {
	it("normalizes structural JSON punctuation out of replyText", () => {
		expect(replyTextFieldEvaluator.parse("}")).toBe("");
		expect(replyTextFieldEvaluator.parse(' " , ')).toBe("");
		expect(replyTextFieldEvaluator.parse("Hello there.")).toBe("Hello there.");
	});

	it("parses, trims, dedupes, and caps canonical action hint arrays", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "",
				contexts: ["tasks"],
				candidateActionNames: [
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
			}),
		);

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
	});

	it("keeps missing hint arrays backward-compatible", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "",
				contexts: ["calendar"],
			}),
		);

		expect(parsed?.plan).toEqual({ contexts: ["calendar"], reply: "" });
	});

	it("ignores non-array canonical retrieval hint garbage", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "",
				contexts: ["email"],
				candidateActionNames: { action: "send_email" },
			}),
		);

		expect(parsed?.plan.candidateActions).toBeUndefined();
	});

	it("exposes the canonical field-registry fields in the default schema", () => {
		expect(Object.keys(HANDLE_RESPONSE_SCHEMA.properties ?? {})).toEqual([
			"shouldRespond",
			"contexts",
			"intents",
			"replyText",
			"candidateActionNames",
			"facts",
			"relationships",
			"addressedTo",
			"emotion",
		]);
		expect(HANDLE_RESPONSE_SCHEMA.required).toEqual([
			"shouldRespond",
			"contexts",
			"intents",
			"replyText",
			"candidateActionNames",
			"facts",
			"relationships",
			"addressedTo",
			"emotion",
		]);
	});

	it("keeps the default schema aligned with the production field-registry schema", () => {
		const registry = new ResponseHandlerFieldRegistry();
		for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
			registry.register(evaluator);
		}

		const composedSchema = registry.composeSchema();

		expect(Object.keys(composedSchema.properties ?? {})).toEqual([
			"shouldRespond",
			"contexts",
			"intents",
			"replyText",
			"candidateActionNames",
			"facts",
			"relationships",
			"addressedTo",
			"emotion",
		]);
		expect(composedSchema.properties).toMatchObject({
			shouldRespond: { type: "string", enum: ["RESPOND", "IGNORE", "STOP"] },
			contexts: { type: "array" },
			intents: { type: "array" },
			replyText: { type: "string" },
			candidateActionNames: { type: "array" },
			facts: { type: "array" },
			relationships: { type: "array" },
			addressedTo: { type: "array" },
			emotion: { type: "string" },
		});
		expect(composedSchema.properties?.thought).toBeUndefined();
		expect(composedSchema.properties?.contextSlices).toBeUndefined();
		expect(composedSchema.properties?.candidateActions).toBeUndefined();
		expect(composedSchema.properties?.parentActionHints).toBeUndefined();
		expect(composedSchema.properties?.requiresTool).toBeUndefined();
		expect(composedSchema.properties?.extract).toBeUndefined();
		expect(Object.keys(composedSchema.properties ?? {})).toEqual(
			Object.keys(HANDLE_RESPONSE_SCHEMA.properties ?? {}),
		);
		expect(composedSchema.required).toEqual(HANDLE_RESPONSE_SCHEMA.required);
	});
});
