/**
 * ASR drive-mode gating at the engine-bridge transcriber seam (#12254).
 * Constructs real bridges over a mocked `loadElizaInferenceFfi` (no native
 * library): a streaming-capable fake yields a `StabilizedStreamingTranscriber`
 * with committed-prefix partials; an unsupported build (today's state) or the
 * `ELIZA_VOICE_STREAMING_ASR` kill switch yields the interim batch adapter.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFfi } from "./__test-helpers__/fake-ffi";
import { EngineVoiceBridge } from "./engine-bridge";
import type { ElizaInferenceFfi } from "./ffi-bindings";
import type { VoiceLifecycleLoaders } from "./lifecycle";
import type { MmapRegionHandle, RefCountedResource } from "./shared-resources";
import { StabilizedStreamingTranscriber } from "./streaming-asr/streaming-pipeline-adapter";
import { FfiBatchTranscriber } from "./transcriber";
import type { TranscriberEvent } from "./types";
import { writeVoicePresetFile } from "./voice-preset-format";

const ffiHolder = vi.hoisted(() => ({
	current: null as unknown,
}));

vi.mock("./ffi-bindings", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ffi-bindings")>();
	return {
		...actual,
		loadElizaInferenceFfi: () => {
			if (!ffiHolder.current) {
				throw new Error("test forgot to set ffiHolder.current");
			}
			return ffiHolder.current;
		},
	};
});

function lifecycleLoadersOk(): VoiceLifecycleLoaders {
	const region: MmapRegionHandle = {
		id: "region-ok",
		path: "/tmp/tts-ok",
		sizeBytes: 1024,
		async evictPages() {},
		async release() {},
	};
	const refc: RefCountedResource = { id: "refc-ok", async release() {} };
	return {
		loadTtsRegion: async () => region,
		loadAsrRegion: async () => region,
		loadVoiceCaches: async () => refc,
		loadVoiceSchedulerNodes: async () => refc,
	};
}

describe("EngineVoiceBridge ASR drive mode (#12254)", () => {
	let bundleRoot: string;
	let savedFlag: string | undefined;
	let savedBackendPin: string | undefined;

	beforeEach(() => {
		bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-asr-mode-"));
		mkdirSync(path.join(bundleRoot, "cache"), { recursive: true });
		const embedding = new Float32Array(16);
		for (let i = 0; i < embedding.length; i++) embedding[i] = (i + 1) / 100;
		writeFileSync(
			path.join(bundleRoot, "cache", "voice-preset-default.bin"),
			Buffer.from(writeVoicePresetFile({ embedding, phrases: [] })),
		);
		// A lib file must exist on disk (loadElizaInferenceFfi itself is mocked)
		// and an asr/ region so the bundle reports ASR available.
		mkdirSync(path.join(bundleRoot, "lib"), { recursive: true });
		for (const name of [
			"libelizainference.dylib",
			"libelizainference.so",
			"elizainference.dll",
		]) {
			writeFileSync(path.join(bundleRoot, "lib", name), "fake");
		}
		mkdirSync(path.join(bundleRoot, "asr"), { recursive: true });
		writeFileSync(path.join(bundleRoot, "asr", "asr-model.gguf"), "fake");
		savedFlag = process.env.ELIZA_VOICE_STREAMING_ASR;
		savedBackendPin = process.env.ELIZA_LOCAL_ASR_BACKEND;
		delete process.env.ELIZA_VOICE_STREAMING_ASR;
		delete process.env.ELIZA_LOCAL_ASR_BACKEND;
	});

	afterEach(() => {
		rmSync(bundleRoot, { recursive: true, force: true });
		if (savedFlag === undefined) delete process.env.ELIZA_VOICE_STREAMING_ASR;
		else process.env.ELIZA_VOICE_STREAMING_ASR = savedFlag;
		if (savedBackendPin === undefined)
			delete process.env.ELIZA_LOCAL_ASR_BACKEND;
		else process.env.ELIZA_LOCAL_ASR_BACKEND = savedBackendPin;
	});

	async function armedBridge(
		ffi: ElizaInferenceFfi,
	): Promise<EngineVoiceBridge> {
		ffiHolder.current = ffi;
		const bridge = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: true,
			lifecycleLoaders: lifecycleLoadersOk(),
		});
		await bridge.arm();
		return bridge;
	}

	it("picks streaming + stabilization when the fused decoder is live (default flag ON)", async () => {
		const bridge = await armedBridge(
			fakeFfi("hello there world", { asrStreamSupported: true }),
		);
		const transcriber = bridge.createStreamingTranscriber();
		expect(transcriber).toBeInstanceOf(StabilizedStreamingTranscriber);

		// Per-frame partials reach subscribers as committed prefixes: the fake
		// repeats the same hypothesis, so LocalAgreement-2 commits on frame 2.
		const events: TranscriberEvent[] = [];
		transcriber.on((e) => events.push(e));
		const frame = {
			pcm: new Float32Array(1600).fill(0.05),
			sampleRate: 16_000,
			timestampMs: 0,
		};
		transcriber.feed(frame);
		transcriber.feed({ ...frame, timestampMs: 100 });
		const partials = events.filter((e) => e.kind === "partial");
		expect(partials).toHaveLength(1);
		expect(
			partials[0]?.kind === "partial" ? partials[0].update.partial : "",
		).toBe("hello there world");

		// The final seeds the drafter identically to batch.
		const final = await transcriber.flush();
		expect(final.partial).toBe("hello there world");

		transcriber.dispose();
		bridge.dispose();
	});

	it("keeps the batch adapter byte-identical when the build reports unsupported (today)", async () => {
		const bridge = await armedBridge(
			fakeFfi("hello", { asrStreamSupported: false }),
		);
		const transcriber = bridge.createStreamingTranscriber();
		expect(transcriber).toBeInstanceOf(FfiBatchTranscriber);
		transcriber.dispose();
		bridge.dispose();
	});

	it("ELIZA_VOICE_STREAMING_ASR=0 pins batch even on a streaming-capable build", async () => {
		process.env.ELIZA_VOICE_STREAMING_ASR = "0";
		const bridge = await armedBridge(
			fakeFfi("hello", { asrStreamSupported: true }),
		);
		const transcriber = bridge.createStreamingTranscriber();
		expect(transcriber).toBeInstanceOf(FfiBatchTranscriber);
		transcriber.dispose();
		bridge.dispose();
	});

	it("an explicit ELIZA_LOCAL_ASR_BACKEND=fused pin wins over the capability gate", async () => {
		process.env.ELIZA_LOCAL_ASR_BACKEND = "fused";
		const bridge = await armedBridge(
			fakeFfi("hello", { asrStreamSupported: true }),
		);
		const transcriber = bridge.createStreamingTranscriber();
		expect(transcriber).toBeInstanceOf(StabilizedStreamingTranscriber);
		transcriber.dispose();
		bridge.dispose();
	});
});
