/**
 * Unit tests for `transcribeWavWithWords`: the fused-engine timed path vs the
 * `useModel` provider-chain fallback and its missing-provider skip logic. The
 * engine is mocked; no GGUF/FFI runs.
 */

import { type AgentRuntime, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localInferenceEngine } from "../services/engine";
import { transcribeWavWithWords } from "./local-inference-asr-transcribe";

vi.mock("../services/engine", () => ({
	localInferenceEngine: {
		available: vi.fn(),
		ensureActiveBundleAsrReady: vi.fn(),
		transcribePcmTimed: vi.fn(),
	},
}));

const engine = vi.mocked(localInferenceEngine, true) as unknown as {
	available: ReturnType<typeof vi.fn>;
	ensureActiveBundleAsrReady: ReturnType<typeof vi.fn>;
	transcribePcmTimed: ReturnType<typeof vi.fn>;
};

/** Minimal mono PCM16 16 kHz WAV with four samples. */
function wavBytes(): Uint8Array {
	const pcm = new Int16Array([0, 900, -900, 0]);
	const buffer = new ArrayBuffer(44 + pcm.length * 2);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i += 1) {
			view.setUint8(offset + i, value.charCodeAt(i));
		}
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + pcm.length * 2, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16_000, true);
	view.setUint32(28, 16_000 * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, "data");
	view.setUint32(40, pcm.length * 2, true);
	for (let i = 0; i < pcm.length; i += 1) {
		view.setInt16(44 + i * 2, pcm[i] ?? 0, true);
	}
	return new Uint8Array(buffer);
}

describe("transcribeWavWithWords", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("runs the fused FFI timed pipe when the in-process engine is active", async () => {
		engine.available.mockResolvedValue(true);
		engine.ensureActiveBundleAsrReady.mockResolvedValue(undefined);
		engine.transcribePcmTimed.mockResolvedValue({
			text: "  hello world  ",
			words: [
				{ text: "hello", startMs: 0, endMs: 500 },
				{ text: "world", startMs: 500, endMs: 1000 },
			],
		});
		const runtime = {
			useModel: vi.fn(),
		} as unknown as AgentRuntime;

		const result = await transcribeWavWithWords(runtime, wavBytes());

		// useModel is never touched — the single FFI pipe owns this path.
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(engine.ensureActiveBundleAsrReady).toHaveBeenCalledTimes(1);
		// The WAV decoded to a Float32Array @ 16 kHz before the timed call.
		const [audioArg] = engine.transcribePcmTimed.mock.calls[0] ?? [];
		expect((audioArg as { pcm: Float32Array }).pcm).toBeInstanceOf(
			Float32Array,
		);
		expect((audioArg as { sampleRate: number }).sampleRate).toBe(16_000);
		expect(result).toEqual({
			text: "hello world",
			words: [
				{ text: "hello", startMs: 0, endMs: 500 },
				{ text: "world", startMs: 500, endMs: 1000 },
			],
		});
	});

	it("falls back to the useModel provider chain when the engine is inactive", async () => {
		engine.available.mockResolvedValue(false);
		const useModel = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("No handler found for delegate type: TRANSCRIPTION"),
			)
			.mockResolvedValueOnce({ text: "hello local voice" });
		const runtime = { useModel } as unknown as AgentRuntime;

		const result = await transcribeWavWithWords(runtime, wavBytes());

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.TRANSCRIPTION);
		expect(useModel.mock.calls[0]?.[2]).toBe("eliza-local-inference");
		expect(useModel.mock.calls[1]?.[2]).toBe("capacitor-llama");
		// Fallback path carries no word timings (TRANSCRIPTION ⇒ string).
		expect(result).toEqual({ text: "hello local voice", words: [] });
		expect(engine.transcribePcmTimed).not.toHaveBeenCalled();
	});

	it("rejects an invalid transcript shape from the provider chain", async () => {
		engine.available.mockResolvedValue(false);
		const useModel = vi.fn().mockResolvedValue(42);
		const runtime = { useModel } as unknown as AgentRuntime;

		await expect(transcribeWavWithWords(runtime, wavBytes())).rejects.toThrow(
			/invalid transcript/,
		);
	});
});
