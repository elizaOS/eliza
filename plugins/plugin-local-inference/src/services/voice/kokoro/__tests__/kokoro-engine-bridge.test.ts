/**
 * Integration tests for `EngineVoiceBridge.startKokoroOnly` — the entry
 * point that constructs a Kokoro-backed bridge without an Eliza-1 bundle.
 *
 * No `vi.mock` here: `KokoroOnnxRuntime`'s constructor does not touch
 * disk (the model file is only opened lazily inside `ensureSession()`,
 * which we never call in these tests), and `KokoroTtsBackend` works the
 * same way. So the tests exercise the real classes against a fake layout
 * pointing at a never-read path.
 *
 * The standalone integration script at `scripts/test-kokoro-tts.mjs`
 * covers the real-ORT path against staged artifacts on disk.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngineVoiceBridge, VoiceStartupError } from "../../engine-bridge";
import type { VoiceLifecycleLoaders } from "../../lifecycle";
import type {
	MmapRegionHandle,
	RefCountedResource,
} from "../../shared-resources";
import type { KokoroTtsBackend } from "../kokoro-backend";
import type { KokoroEngineDiscoveryResult } from "../kokoro-engine-discovery";

function makeKokoroConfig(rootOverride?: string): KokoroEngineDiscoveryResult {
	return {
		layout: {
			root: rootOverride ?? "/tmp/fake-kokoro",
			modelFile: "kokoro-v1.0.onnx",
			voicesDir: path.join(rootOverride ?? "/tmp/fake-kokoro", "voices"),
			sampleRate: 24_000,
		},
		defaultVoiceId: "af_bella",
	};
}

function lifecycleLoadersOk(): VoiceLifecycleLoaders {
	const region: MmapRegionHandle = {
		id: "test-region",
		path: "/tmp/test",
		sizeBytes: 0,
		async evictPages() {},
		async release() {},
	};
	const refc: RefCountedResource = { id: "refc", async release() {} };
	return {
		loadTtsRegion: async () => region,
		loadAsrRegion: async () => region,
		loadVoiceCaches: async () => refc,
		loadVoiceSchedulerNodes: async () => refc,
	};
}

describe("EngineVoiceBridge — kokoroOnly mode", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(path.join(os.tmpdir(), "kokoro-bridge-test-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("constructs a KokoroTtsBackend when kokoroOnly is set, even without a real bundle", () => {
		const bridge = EngineVoiceBridge.start({
			bundleRoot: "", // intentionally empty — kokoroOnly skips the existsSync check
			useFfiBackend: false,
			kokoroOnly: makeKokoroConfig(),
			lifecycleLoaders: lifecycleLoadersOk(),
		});
		expect(bridge.backend?.id).toBe("kokoro");
		expect(bridge.asrAvailable).toBe(false); // ASR is not served from this path
		expect(bridge.ffi).toBeNull();
		bridge.dispose();
	});

	it("uses provided bundleRoot as working dir when it exists", () => {
		const bridge = EngineVoiceBridge.start({
			bundleRoot: tmp, // a real tmp dir; should be honored as work-dir hint
			useFfiBackend: false,
			kokoroOnly: makeKokoroConfig(),
			lifecycleLoaders: lifecycleLoadersOk(),
		});
		expect(bridge.backend?.id).toBe("kokoro");
		bridge.dispose();
	});

	it("throws when kokoroOnly is combined with useFfiBackend:true", () => {
		expect(() =>
			EngineVoiceBridge.start({
				bundleRoot: "",
				useFfiBackend: true,
				kokoroOnly: makeKokoroConfig(),
			}),
		).toThrow(VoiceStartupError);
	});

	it("throws when kokoroOnly is combined with backendOverride", () => {
		expect(() =>
			EngineVoiceBridge.start({
				bundleRoot: "",
				useFfiBackend: false,
				kokoroOnly: makeKokoroConfig(),
				backendOverride: {
					async synthesize() {
						return {
							phraseId: 0,
							fromIndex: 0,
							toIndex: 0,
							pcm: new Float32Array(0),
							sampleRate: 24000,
						};
					},
				} as never,
			}),
		).toThrow(VoiceStartupError);
	});

	it("uses no-op lifecycle loaders by default (no real mmap regions)", async () => {
		const bridge = EngineVoiceBridge.start({
			bundleRoot: "",
			useFfiBackend: false,
			kokoroOnly: makeKokoroConfig(),
		});
		// Default loaders should arm without hitting real disk.
		await expect(bridge.arm()).resolves.toBeUndefined();
		bridge.dispose();
	});

	it("preserves the requested sample rate from the kokoroOnly layout", () => {
		const bridge = EngineVoiceBridge.start({
			bundleRoot: "",
			useFfiBackend: false,
			kokoroOnly: {
				...makeKokoroConfig(),
				layout: {
					...makeKokoroConfig().layout,
					sampleRate: 16_000,
				},
			},
			lifecycleLoaders: lifecycleLoadersOk(),
		});
		expect((bridge.backend as KokoroTtsBackend).sampleRate).toBe(16_000);
		bridge.dispose();
	});
});
