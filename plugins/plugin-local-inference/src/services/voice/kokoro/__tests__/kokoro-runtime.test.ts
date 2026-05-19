import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	KokoroGgufRuntime,
	KokoroMockRuntime,
	KokoroOnnxRuntime,
} from "../kokoro-runtime";
import type { KokoroVoicePack } from "../types";

const OLD_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...OLD_ENV };
});

function makeVoice(): KokoroVoicePack {
	return {
		id: "af_test",
		displayName: "Test",
		lang: "a",
		file: "af_test.bin",
		dim: 256,
		tags: ["test"],
	};
}

describe("KokoroMockRuntime", () => {
	it("emits chunks and a final marker", async () => {
		const runtime = new KokoroMockRuntime({
			sampleRate: 24_000,
			totalSamples: 100,
			chunkCount: 4,
		});
		const chunks: Array<{ isFinal: boolean; len: number }> = [];
		await runtime.synthesize({
			phonemes: { ids: Int32Array.from([1, 2, 3]), phonemes: "abc" },
			voice: makeVoice(),
			cancelSignal: { cancelled: false },
			onChunk: (c) => {
				chunks.push({ isFinal: c.isFinal, len: c.pcm.length });
				return undefined;
			},
		});
		expect(chunks.at(-1)?.isFinal).toBe(true);
		const bodyChunks = chunks.filter((c) => !c.isFinal);
		expect(bodyChunks.length).toBeGreaterThan(0);
		const total = bodyChunks.reduce((s, c) => s + c.len, 0);
		expect(total).toBe(100);
	});

	it("increments calls counter", async () => {
		const runtime = new KokoroMockRuntime({ sampleRate: 24_000 });
		expect(runtime.calls).toBe(0);
		await runtime.synthesize({
			phonemes: { ids: Int32Array.from([1]), phonemes: "a" },
			voice: makeVoice(),
			cancelSignal: { cancelled: false },
			onChunk: () => undefined,
		});
		expect(runtime.calls).toBe(1);
	});

	it("honours cancel signal", async () => {
		const runtime = new KokoroMockRuntime({
			sampleRate: 24_000,
			totalSamples: 1000,
			chunkCount: 10,
		});
		const signal = { cancelled: false };
		let bodyCount = 0;
		const result = await runtime.synthesize({
			phonemes: { ids: Int32Array.from([1, 2]), phonemes: "ab" },
			voice: makeVoice(),
			cancelSignal: signal,
			onChunk: (c) => {
				if (!c.isFinal) {
					bodyCount++;
					if (bodyCount >= 2) {
						signal.cancelled = true;
					}
				}
				return undefined;
			},
		});
		expect(result.cancelled).toBe(true);
		expect(bodyCount).toBeLessThan(10);
	});

	it("returns cancelled=true when onChunk returns true", async () => {
		const runtime = new KokoroMockRuntime({ sampleRate: 24_000 });
		const result = await runtime.synthesize({
			phonemes: { ids: Int32Array.from([1]), phonemes: "a" },
			voice: makeVoice(),
			cancelSignal: { cancelled: false },
			onChunk: () => true,
		});
		expect(result.cancelled).toBe(true);
	});
});

describe("KokoroGgufRuntime", () => {
	it("throws when server returns a non-ok response", async () => {
		const runtime = new KokoroGgufRuntime({
			serverUrl: "http://127.0.0.1:18789",
			modelId: "kokoro-v1.0",
			sampleRate: 24_000,
			fetchImpl: async () =>
				({
					ok: false,
					status: 503,
					statusText: "Service Unavailable",
					body: null,
				}) as unknown as Response,
		});
		await expect(
			runtime.synthesize({
				phonemes: { ids: Int32Array.from([1, 2]), phonemes: "ab" },
				voice: makeVoice(),
				cancelSignal: { cancelled: false },
				onChunk: () => undefined,
			}),
		).rejects.toThrow("503");
	});

	it("dispose is a no-op (stateless adapter)", () => {
		const runtime = new KokoroGgufRuntime({
			serverUrl: "http://127.0.0.1:18789",
			modelId: "kokoro-v1.0",
			sampleRate: 24_000,
		});
		expect(() => runtime.dispose()).not.toThrow();
	});
});

describe("KokoroOnnxRuntime", () => {
	it("passes explicit ONNX session memory and threading options", async () => {
		const root = await mkdtemp(join(tmpdir(), "kokoro-onnx-"));
		const voicesDir = join(root, "voices");
		await writeFile(join(root, "model.onnx"), "onnx");
		await mkdir(voicesDir);
		await writeFile(
			join(voicesDir, "af_test.bin"),
			Buffer.from(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer),
		);

		let createOptions: unknown;
		class Tensor {
			constructor(
				readonly type: string,
				readonly data: unknown,
				readonly dims: number[],
			) {}
		}
		const session = {
			inputNames: ["input_ids", "style", "speed"],
			run: async () => ({
				waveform: { data: new Float32Array([0, 0.1]) },
			}),
		};
		const runtime = new KokoroOnnxRuntime({
			layout: {
				root,
				modelFile: "model.onnx",
				voicesDir,
				sampleRate: 24_000,
			},
			intraOpNumThreads: 2,
			enableCpuMemArena: false,
			enableMemPattern: false,
			loadOrt: async () => ({
				Tensor,
				InferenceSession: {
					create: async (_modelPath: string, options: unknown) => {
						createOptions = options;
						return session;
					},
				},
			}),
		});

		await runtime.synthesize({
			phonemes: { ids: Int32Array.from([1]), phonemes: "a" },
			voice: { ...makeVoice(), dim: 4 },
			cancelSignal: { cancelled: false },
			onChunk: () => undefined,
		});

		expect(createOptions).toMatchObject({
			intraOpNumThreads: 2,
			enableCpuMemArena: false,
			enableMemPattern: false,
		});
	});
});
