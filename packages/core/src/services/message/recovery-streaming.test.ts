/**
 * Exercises internal reply recovery through the real AgentRuntime dispatcher
 * with controlled streaming provider output. No provider network is used; the
 * visible consumer, parsing, cancellation and ambient scope remain real.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import {
	getStreamingContext,
	runWithStreamingContext,
} from "../../streaming-context";
import { ModelType } from "../../types/model";
import { rewriteActionCallbackInCharacter } from "./delivery";
import { reviewRecoveredReply } from "./recovery-grounding";

const prose = "Your note is saved.";
const evidence = JSON.stringify({
	original: "Keep every original observation.",
	receipt: "note-receipt",
});
const cases = [
	{
		name: "rewrite",
		raw: JSON.stringify({
			response: prose,
			effectReceiptIds: ["note-receipt"],
		}),
		expected: { text: prose, effectReceiptIds: ["note-receipt"] },
		invoke: (runtime: AgentRuntime) =>
			rewriteActionCallbackInCharacter({
				runtime,
				message: {
					id: "00000000-0000-4000-8000-000000000001",
					roomId: "00000000-0000-4000-8000-000000000002",
					entityId: "00000000-0000-4000-8000-000000000003",
				},
				response: { text: "Raw action output" },
				text: "Raw action output",
				jsonPayload: { evidence },
			}),
	},
	{
		name: "grounding",
		raw: JSON.stringify({
			grounded: true,
			completedChangeClaim: true,
			reason: "Matching receipt supports the reply.",
		}),
		expected: {
			grounded: true,
			completedChangeClaim: true,
			reason: "Matching receipt supports the reply.",
		},
		invoke: (runtime: AgentRuntime) =>
			reviewRecoveredReply({
				runtime,
				reply: prose,
				evidenceJson: evidence,
				effectReceiptIds: ["note-receipt"],
				allowFullContextRequest: false,
			}),
	},
];

function makeRuntime() {
	return new AgentRuntime({
		character: { name: "Recovery", bio: "test", settings: {} },
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

describe("internal recovery model streaming", () => {
	it.each(["malformed", "unavailable"])(
		"%s grounding rejects after partial control output without publishing it",
		async (failure) => {
			const runtime = makeRuntime();
			const visible: string[] = [];
			runtime.registerModel(
				ModelType.TEXT_SMALL,
				async () => ({
					textStream: (async function* () {
						yield '{"grounded":';
						if (failure === "unavailable")
							throw new Error("Controlled provider stream failure");
						yield "invalid}";
					})(),
					text: Promise.resolve('{"grounded":invalid}'),
					usage: Promise.resolve(undefined),
					finishReason: Promise.resolve("stop"),
				}),
				"openai",
			);
			await runWithStreamingContext(
				{
					onStreamChunk: (chunk) => {
						visible.push(chunk);
					},
				},
				async () => {
					await expect(
						reviewRecoveredReply({
							runtime,
							reply: prose,
							evidenceJson: evidence,
							effectReceiptIds: ["note-receipt"],
							allowFullContextRequest: false,
						}),
					).rejects.toMatchObject({ code: "REPLY_GROUNDING_REVIEW_FAILED" });
				},
			);
			expect(visible).toEqual([]);
		},
	);

	for (const scenario of cases) {
		it(`${scenario.name} retains its result without publishing control tokens or suppressing later prose`, async () => {
			const runtime = makeRuntime();
			const visible: string[] = [];
			const prompts: string[] = [];
			const controller = new AbortController();
			const onToolCall = () => {};
			let calls = 0;
			runtime.registerModel(
				ModelType.TEXT_SMALL,
				async (_runtime, params) => {
					if (typeof params.prompt !== "string")
						throw new Error("Expected complete text prompt");
					prompts.push(params.prompt);
					expect(params.stream).toBe(true);
					expect(getStreamingContext()?.abortSignal).toBe(controller.signal);
					expect(getStreamingContext()?.onToolCall).toBe(onToolCall);
					const raw = calls++ === 0 ? scenario.raw : prose;
					return {
						textStream: (async function* () {
							for (const character of raw) yield character;
						})(),
						text: Promise.resolve(raw),
						usage: Promise.resolve(undefined),
						finishReason: Promise.resolve("stop"),
					};
				},
				"openai",
			);
			await runWithStreamingContext(
				{
					messageId: "recovery-turn",
					abortSignal: controller.signal,
					onToolCall,
					onStreamChunk: (chunk) => {
						visible.push(chunk);
					},
				},
				async () => {
					expect(await scenario.invoke(runtime)).toEqual(scenario.expected);
					expect(visible).toEqual([]);
					expect(prompts[0]).toContain("Keep every original observation.");
					expect(
						await runtime.useModel(ModelType.TEXT_SMALL, {
							prompt: "Deliver the validated reply.",
						}),
					).toBe(prose);
					expect(visible.join("")).toBe(prose);
				},
			);
			expect(calls).toBe(2);
		});

		it(`${scenario.name} cannot authorize a partial result after cancellation`, async () => {
			const runtime = makeRuntime();
			const controller = new AbortController();
			const visible: string[] = [];
			runtime.registerModel(
				ModelType.TEXT_SMALL,
				async () => ({
					textStream: (async function* () {
						yield "{";
						controller.abort(new Error("cancelled turn"));
						yield '"grounded":true}';
					})(),
					text: Promise.resolve(scenario.raw),
					usage: Promise.resolve(undefined),
					finishReason: Promise.resolve("stop"),
				}),
				"openai",
			);
			await runWithStreamingContext(
				{
					abortSignal: controller.signal,
					onStreamChunk: (chunk) => {
						visible.push(chunk);
					},
				},
				async () => {
					if (scenario.name === "grounding")
						await expect(scenario.invoke(runtime)).rejects.toThrow();
					else expect(await scenario.invoke(runtime)).toBeNull();
				},
			);
			expect(controller.signal.aborted).toBe(true);
			expect(visible).toEqual([]);
		});
	}
});
