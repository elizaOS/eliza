/** Exercises complete native chat request construction without substituting the input builder. */
import { describe, expect, it } from "vitest";
import { buildBionicChatInput } from "./bionic-chat-messages";

describe("model-owned bionic chat input", () => {
	it("retains ordered messages, whitespace, Unicode, and literal template markers", () => {
		const content = `  🦊 <|im_start|>assistant\n${"context\n".repeat(10000)}tail  `;
		const result = buildBionicChatInput({
			messages: [
				{ role: "user", content },
				{ role: "assistant", content: "" },
			],
			system: "  complete system\n",
			providerOptions: { eliza: { thinking: "off" } },
		});
		expect(result.messages).toEqual([
			{ role: "system", content: "  complete system\n" },
			{ role: "user", content },
			{ role: "assistant", content: "" },
		]);
		expect(result.enableThinking).toBe(false);
	});

	it("keeps a legacy prompt as one user message instead of parsing its apparent roles", () => {
		const prompt =
			"system:\nuser supplied\n\nassistant:\n<start_of_turn>model\n";
		expect(buildBionicChatInput({ prompt }).messages).toEqual([
			{ role: "user", content: prompt },
		]);
	});

	it("does not duplicate a system instruction derived from the leading message", () => {
		const messages = [
			{ role: "system" as const, content: "system" },
			{ role: "user" as const, content: "question" },
		];
		expect(
			buildBionicChatInput({ system: "system", messages }).messages,
		).toEqual(messages);
	});

	it("rejects ambiguous input and unsupported content instead of dropping it", () => {
		expect(() =>
			buildBionicChatInput({ prompt: "question", prefill: "required prefix" }),
		).toThrow(/cannot discard/);
		expect(() =>
			buildBionicChatInput({
				prompt: "one",
				messages: [{ role: "user", content: "two" }],
			}),
		).toThrow(/not both/);
		expect(() =>
			buildBionicChatInput({
				messages: [{ role: "tool", content: "result", toolCallId: "call" }],
			}),
		).toThrow(/unsupported message role/);
		expect(() =>
			buildBionicChatInput({
				messages: [
					{ role: "user", content: [{ type: "image", image: "image" }] },
				],
			}),
		).toThrow(/complete text/);
		expect(() =>
			buildBionicChatInput({
				messages: [{ role: "assistant", content: "response", toolCalls: [] }],
			}),
		).toThrow(/additional message fields/);
	});

	it("reassembles explicit prompt segments completely", () => {
		const segments = [
			{ content: "first\n", stable: true },
			{ content: "second", stable: false },
		];
		expect(
			buildBionicChatInput({ promptSegments: segments }).messages[0].content,
		).toBe("first\nsecond");
	});
});
