/**
 * Pins one authoritative model-token source when a streamable provider exposes
 * both the handler callback and a returned TextStreamResult. Deterministic
 * adapter-contract tests; no provider or network is involved.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import { runWithStreamingContext } from "../streaming-context";
import type { Character, TextStreamResult } from "../types";
import { ModelType } from "../types";

function makeRuntime(): AgentRuntime {
	const runtime = new AgentRuntime({
		character: { name: "stream-authority-test" } as Character,
		logLevel: "fatal",
	});
	(runtime as unknown as { logModelCall: () => void }).logModelCall = () => {};
	return runtime;
}

function streamResult(
	chunks: () => AsyncIterable<string>,
	text: string,
): TextStreamResult {
	return {
		textStream: chunks(),
		text: Promise.resolve(text),
		usage: Promise.resolve(undefined),
		finishReason: Promise.resolve("stop"),
	};
}

describe("AgentRuntime model stream authority", () => {
	it("uses pushed callback chunks without replaying a returned stream", async () => {
		const runtime = makeRuntime();
		let returnedStreamPulls = 0;
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params) => {
				const onChunk = params.onStreamChunk as
					| ((chunk: string) => Promise<void>)
					| undefined;
				await onChunk?.("same ");
				await onChunk?.("same");
				return streamResult(async function* () {
					returnedStreamPulls += 1;
					yield "same ";
					yield "same";
				}, "same same");
			},
			"dual-stream-test",
			100,
			{ streamable: true },
		);
		const delivered: string[] = [];

		const result = await runWithStreamingContext(
			{ onStreamChunk: async (chunk) => delivered.push(chunk) },
			() =>
				runtime.useModel(ModelType.TEXT_LARGE, {
					prompt: "repeat",
					stream: true,
				}),
		);

		expect(delivered).toEqual(["same ", "same"]);
		expect(result).toBe("same same");
		expect(returnedStreamPulls).toBe(0);
	});

	it("ignores callback echoes fired by the authoritative returned stream", async () => {
		const runtime = makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params) => {
				const onChunk = params.onStreamChunk as
					| ((chunk: string) => Promise<void>)
					| undefined;
				return streamResult(async function* () {
					await onChunk?.("echo");
					yield "real ";
					yield "real";
				}, "real real");
			},
			"late-callback-test",
			100,
			{ streamable: true },
		);
		const delivered: string[] = [];

		const result = await runWithStreamingContext(
			{ onStreamChunk: async (chunk) => delivered.push(chunk) },
			() =>
				runtime.useModel(ModelType.TEXT_LARGE, {
					prompt: "repeat",
					stream: true,
				}),
		);

		expect(delivered).toEqual(["real ", "real"]);
		expect(result).toBe("real real");
	});

	it("serializes and settles structured field callbacks before returning", async () => {
		const runtime = makeRuntime();
		const skeleton = {
			spans: [
				{ kind: "literal" as const, value: '{"text":' },
				{ kind: "free-string" as const, key: "text" },
				{ kind: "literal" as const, value: "}" },
			],
		};
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params) => {
				const onChunk = params.onStreamChunk as
					| ((chunk: string) => Promise<void>)
					| undefined;
				await onChunk?.('{"text":"first ');
				await onChunk?.('second"}');
				return "first second";
			},
			"structured-callback-order-test",
			100,
			{ streamable: true },
		);

		const delivered: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: "respond",
			stream: true,
			streamStructured: true,
			responseSkeleton: skeleton,
			onStreamChunk: async (chunk: string) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				if (chunk.includes("first")) {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				delivered.push(chunk);
				inFlight -= 1;
			},
		});

		expect(delivered.join("")).toBe("first second");
		expect(maxInFlight).toBe(1);
		expect(inFlight).toBe(0);
	});

	it("settles callbacks fired without awaiting them before stream end and return", async () => {
		const runtime = makeRuntime();
		const skeleton = {
			spans: [
				{ kind: "literal" as const, value: '{"text":' },
				{ kind: "free-string" as const, key: "text" },
				{ kind: "literal" as const, value: "}" },
			],
		};
		const events: string[] = [];
		runtime.registerPipelineHook({
			id: "delay-stream-ingress",
			phase: "model_stream_chunk",
			handler: async () => {
				await new Promise((resolve) => setTimeout(resolve, 25));
			},
		});
		runtime.registerPipelineHook({
			id: "capture-stream-end",
			phase: "model_stream_end",
			handler: () => {
				events.push("end");
			},
		});
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params) => {
				const onChunk = params.onStreamChunk as
					| ((chunk: string) => Promise<void>)
					| undefined;
				void onChunk?.('{"text":"first ');
				void onChunk?.('second"}');
				return "first second";
			},
			"nonawaiting-stream-callback-test",
			100,
			{ streamable: true },
		);

		const delivered: string[] = [];
		const result = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: "respond",
			stream: true,
			streamStructured: true,
			responseSkeleton: skeleton,
			onStreamChunk: async (chunk: string) => {
				delivered.push(chunk);
				events.push(chunk);
			},
		});

		expect(result).toBe("first second");
		expect(delivered.join("")).toBe("first second");
		expect(events.at(-1)).toBe("end");
	});
});
