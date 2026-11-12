/** transcribeWavWithWords over the useModel provider chain (engine not the active backend). */
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/engine", () => ({
	localInferenceEngine: { available: async () => false },
}));

const { transcribeWavWithWords } = await import(
	"./local-inference-asr-transcribe"
);

function runtime(result: unknown): AgentRuntime {
	return { useModel: async () => result } as unknown as AgentRuntime;
}

describe("transcribeWavWithWords via the model chain", () => {
	it("returns an empty transcript for silence, as the engine path does", async () => {
		await expect(
			transcribeWavWithWords(runtime("  "), new Uint8Array(44)),
		).resolves.toEqual({ text: "", words: [] });
	});

	it("still rejects an invalid transcript shape", async () => {
		await expect(
			transcribeWavWithWords(runtime(42), new Uint8Array(44)),
		).rejects.toThrow("invalid transcript");
	});
});
