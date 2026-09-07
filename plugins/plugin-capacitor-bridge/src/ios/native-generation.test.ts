/** Exercises the real iOS request/response boundary with deterministic native-host envelopes, including complete text and explicit exhaustion failures. */
import { describe, expect, it } from "vitest";
import {
	cleanIosNativeConversationReply,
	dispatchIosNativeGeneration,
} from "./native-generation";

const request = {
	context_id: 7,
	prompt: "Preserve this complete request.\n\nSecond paragraph: 日本語🙂",
	temperature: 0,
	top_p: 0.95,
	top_k: 40,
	stop: ["<end_of_turn>"],
};
const base = {
	provider: "ios-native-llama",
	model: "local.gguf",
	contextWindowTokens: 8192,
	request,
};

describe("iOS native output integrity", () => {
	it("delivers every sentence and paragraph beyond the old clipping boundary", async () => {
		const text =
			"This is the first sentence.\n\n" +
			"The full second paragraph contains 日本語🙂 and preserved spacing.  ".repeat(
				30,
			);
		const actual = await dispatchIosNativeGeneration({
			...base,
			invoke: async (wire) => {
				expect(wire.prompt).toBe(request.prompt);
				expect(wire.max_tokens).toBe(base.contextWindowTokens);
				return { text, incomplete: false, finish_reason: "eog" };
			},
		});
		expect(actual).toBe(text);
		expect(cleanIosNativeConversationReply(actual)).toBe(text.trim());
	});

	it("passes an explicitly requested output boundary unchanged to the host", async () => {
		const text = "A complete response.";
		await expect(
			dispatchIosNativeGeneration({
				...base,
				requestedMaxTokens: 1536,
				invoke: async (wire) => {
					expect(wire.max_tokens).toBe(1536);
					expect(wire.prompt).toBe(request.prompt);
					return { text, incomplete: false, finish_reason: "stop_sequence" };
				},
			}),
		).resolves.toBe(text);
	});

	for (const reason of ["max_tokens", "context_exhausted", "cancelled"]) {
		it(`rejects ${reason} rather than delivering partial text`, async () => {
			await expect(
				dispatchIosNativeGeneration({
					...base,
					invoke: async () => ({
						text: "Partial sentence.",
						incomplete: true,
						finish_reason: reason,
					}),
				}),
			).rejects.toMatchObject({
				code: "MODEL_INCOMPLETE_OUTPUT",
				context: { reason },
			});
		});
	}

	for (const requestedMaxTokens of [
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	]) {
		it(`rejects invalid output boundary ${requestedMaxTokens} before native dispatch`, async () => {
			let called = false;
			await expect(
				dispatchIosNativeGeneration({
					...base,
					requestedMaxTokens,
					invoke: async () => {
						called = true;
						return { text: "unreachable", incomplete: false };
					},
				}),
			).rejects.toMatchObject({ code: "MODEL_OUTPUT_BOUNDARY_INVALID" });
			expect(called).toBe(false);
		});
	}

	for (const result of [
		null,
		"untyped reply",
		{ text: "Missing completion metadata" },
		{ text: 42, incomplete: false },
	]) {
		it("rejects malformed host replies instead of fabricating completed text", async () => {
			await expect(
				dispatchIosNativeGeneration({ ...base, invoke: async () => result }),
			).rejects.toMatchObject({ code: "MODEL_NATIVE_RESPONSE_INVALID" });
		});
	}
});
