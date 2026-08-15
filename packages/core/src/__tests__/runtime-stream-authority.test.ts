/**
 * Pins one authoritative model-token source when a streamable provider exposes
 * both the runtime callback and a returned TextStreamResult. These are
 * deterministic adapter-contract tests; no provider or network is involved.
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
	it("uses pushed callback chunks without replaying a duplicate returned stream", async () => {
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

	it("ignores a callback echo fired from inside the authoritative returned stream", async () => {
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
});
