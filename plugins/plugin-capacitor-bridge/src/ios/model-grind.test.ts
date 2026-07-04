/**
 * Deterministic coverage for the iOS local model grind helpers.
 *
 * The tests exercise WAV decoding, PCM resampling, WER scoring, and injected
 * model-grind dependencies without invoking native llama, TTS, or ASR engines.
 */

import { describe, expect, it } from "vitest";
import {
	decodeWavToPcm,
	type ModelGrindDeps,
	resamplePcm,
	runModelGrind,
	wordErrorRate,
} from "./model-grind.ts";

function makeWav(
	samples: number[],
	sampleRate: number,
	float = false,
): Uint8Array {
	const bytesPerSample = float ? 4 : 2;
	const dataLen = samples.length * bytesPerSample;
	const buf = new ArrayBuffer(44 + dataLen);
	const v = new DataView(buf);
	v.setUint32(0, 0x52494646, false); // RIFF
	v.setUint32(4, 36 + dataLen, true);
	v.setUint32(8, 0x57415645, false); // WAVE
	v.setUint32(12, 0x666d7420, false); // "fmt "
	v.setUint32(16, 16, true);
	v.setUint16(20, float ? 3 : 1, true);
	v.setUint16(22, 1, true); // mono
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, sampleRate * bytesPerSample, true);
	v.setUint16(32, bytesPerSample, true);
	v.setUint16(34, float ? 32 : 16, true);
	v.setUint32(36, 0x64617461, false); // "data"
	v.setUint32(40, dataLen, true);
	for (let i = 0; i < samples.length; i++) {
		if (float) v.setFloat32(44 + i * 4, samples[i], true);
		else v.setInt16(44 + i * 2, Math.round(samples[i] * 32767), true);
	}
	return new Uint8Array(buf);
}

describe("wordErrorRate", () => {
	it("is 0 for identical (case/punct-insensitive)", () => {
		expect(wordErrorRate("Hello world.", "hello WORLD")).toBe(0);
	});
	it("counts substitutions/insertions/deletions", () => {
		expect(wordErrorRate("a b c", "a x c")).toBeCloseTo(1 / 3, 5);
		expect(wordErrorRate("a b c", "a b c d")).toBeCloseTo(1 / 3, 5);
		expect(wordErrorRate("a b c", "a c")).toBeCloseTo(1 / 3, 5);
	});
	it("empty hypothesis -> full error", () => {
		expect(wordErrorRate("one two", "")).toBe(1);
	});
});

describe("decodeWavToPcm", () => {
	it("round-trips int16 WAV", () => {
		const samples = [0, 0.5, -0.5, 0.25];
		const { pcm, sampleRate } = decodeWavToPcm(makeWav(samples, 24000));
		expect(sampleRate).toBe(24000);
		expect(pcm.length).toBe(4);
		expect(pcm[1]).toBeCloseTo(0.5, 2);
		expect(pcm[2]).toBeCloseTo(-0.5, 2);
	});
	it("decodes float32 WAV", () => {
		const samples = [0.1, -0.2, 0.3];
		const { pcm, sampleRate } = decodeWavToPcm(makeWav(samples, 16000, true));
		expect(sampleRate).toBe(16000);
		expect(pcm[0]).toBeCloseTo(0.1, 5);
	});
	it("rejects non-WAV", () => {
		expect(() => decodeWavToPcm(new Uint8Array([1, 2, 3, 4]))).toThrow();
	});
});

describe("resamplePcm", () => {
	it("no-op for equal rates", () => {
		const pcm = [1, 2, 3];
		expect(resamplePcm(pcm, 16000, 16000)).toBe(pcm);
	});
	it("downsamples 24k->16k by ~2/3", () => {
		const pcm = Array.from({ length: 2400 }, () => 0.1);
		const out = resamplePcm(pcm, 24000, 16000);
		expect(out.length).toBe(1600);
	});
});

function baseDeps(over: Partial<ModelGrindDeps> = {}): ModelGrindDeps {
	const wav = makeWav(
		Array.from({ length: 24000 }, () => 0.05),
		24000,
	);
	return {
		callIosHost: async () => ({ text: "hello there", outputTokens: 12 }),
		ensureTextModelLoaded: async () => ({ contextId: 7 }),
		synthesizeTts: async () => ({ bytes: wav, sampleRate: 24000 }),
		transcribeAsr: async () =>
			"Eliza local voice end to end check one two three",
		hardwareInfo: async () => ({ total_ram_gb: 8, available_ram_gb: 4 }),
		bundleDir: "/bundle",
		...over,
	};
}

describe("runModelGrind", () => {
	it("passes all models on a healthy stack", async () => {
		const report = await runModelGrind(baseDeps());
		expect(report.models.map((m) => m.model)).toEqual(["text", "tts", "asr"]);
		expect(report.overall.allPassed).toBe(true);
		expect(report.overall.passed).toBe(3);
		const asr = report.models.find((m) => m.model === "asr");
		expect(asr?.throughput?.kind).toBe("wer");
		expect(asr?.throughput?.value).toBeLessThanOrEqual(0.5);
		const tts = report.models.find((m) => m.model === "tts");
		expect(tts?.throughput?.kind).toBe("rtf");
	});

	it("marks text failed on empty output, still runs tts+asr", async () => {
		const report = await runModelGrind(
			baseDeps({ callIosHost: async () => ({ text: "", outputTokens: 0 }) }),
		);
		const text = report.models.find((m) => m.model === "text");
		expect(text?.ok).toBe(false);
		expect(report.overall.failed).toBe(1);
		expect(report.models.find((m) => m.model === "tts")?.ok).toBe(true);
	});

	it("sends Gemma turn tokens to the native text smoke", async () => {
		let request: Record<string, unknown> | null = null;
		await runModelGrind(
			baseDeps({
				callIosHost: async (_method, payload) => {
					request = payload;
					return { text: "hello there", outputTokens: 12 };
				},
			}),
		);
		expect(request?.prompt).toBe(
			"<start_of_turn>user\nSay hello in one short sentence.<end_of_turn>\n<start_of_turn>model\n",
		);
		expect(request?.stop).toEqual([
			"<end_of_turn>",
			"<start_of_turn>",
			"<endoftext>",
		]);
	});

	it("marks asr failed (and reports) when TTS throws", async () => {
		const report = await runModelGrind(
			baseDeps({
				synthesizeTts: async () => {
					throw new Error("tts engine missing");
				},
			}),
		);
		expect(report.models.find((m) => m.model === "tts")?.ok).toBe(false);
		const asr = report.models.find((m) => m.model === "asr");
		expect(asr?.ok).toBe(false);
		expect(asr?.error).toContain("no TTS audio");
	});

	it("marks asr failed on high WER", async () => {
		const report = await runModelGrind(
			baseDeps({
				transcribeAsr: async () => "completely different words here",
			}),
		);
		expect(report.models.find((m) => m.model === "asr")?.ok).toBe(false);
	});
});
