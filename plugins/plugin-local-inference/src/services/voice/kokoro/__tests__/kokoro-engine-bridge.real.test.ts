/**
 * Real-FFI tests for `EngineVoiceBridge.startKokoroOnly`: construct the
 * Kokoro-backed bridge against the ACTUAL fused `libelizainference` — loaded,
 * `create`d, and probed for `kokoroSupported()` — never a stub.
 *
 * Skipped (not faked) when the fused lib is not resolvable. To run them, point
 * `ELIZA_INFERENCE_LIBRARY` (or `ELIZA_INFERENCE_LIB_DIR`) at a built
 * `libelizainference` or build one via
 * `packages/app-core/scripts/build-llama-cpp-mtp.mjs`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";

import { resolveFusedLibraryPath } from "../../../desktop-fused-ffi-backend-runtime";
import {
	createKokoroSpeakerPreset,
	createKokoroTtsBackend,
	EngineVoiceBridge,
} from "../../engine-bridge";
import {
	type ElizaInferenceFfi,
	loadElizaInferenceFfi,
} from "../../ffi-bindings";
import type { VoiceLifecycleLoaders } from "../../lifecycle";
import type {
	MmapRegionHandle,
	RefCountedResource,
} from "../../shared-resources";
import type { Phrase } from "../../types";
import {
	KOKORO_MOBILE_TTFA_BUDGET_MS,
	type KokoroTtsBackend,
} from "../kokoro-backend";
import {
	type KokoroEngineDiscoveryResult,
	resolveKokoroEngineConfig,
} from "../kokoro-engine-discovery";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const LIB_PATH = resolveFusedLibraryPath(null, process.env);

// The real fused `create()` validates that the anchor dir exists, so the
// layout root points at a live temp dir (`tmp`, per-test) rather than a
// never-created path.
function makeKokoroConfig(root: string): KokoroEngineDiscoveryResult {
	return {
		layout: {
			root,
			modelFile: "kokoro-82m-v1_0-Q4_K_M.gguf",
			voicesDir: path.join(root, "voices"),
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

describe.skipIf(!isBun || !LIB_PATH)(
	"EngineVoiceBridge — kokoroOnly real FFI construction",
	() => {
		let ffi: ElizaInferenceFfi;
		let tmp: string;

		beforeAll(() => {
			// LIB_PATH is non-null inside the skipIf-guarded block.
			ffi = loadElizaInferenceFfi(LIB_PATH as string);
			if (typeof ffi.kokoroSupported !== "function" || !ffi.kokoroSupported()) {
				throw new Error(
					`[test] the fused lib at ${LIB_PATH} (ABI v${ffi.libraryAbiVersion}) does not link the in-process Kokoro engine — rebuild with the Kokoro engine enabled.`,
				);
			}
		});
		afterAll(() => {
			(ffi as unknown as { close?: () => void }).close?.();
		});
		beforeEach(() => {
			tmp = mkdtempSync(path.join(os.tmpdir(), "kokoro-bridge-real-"));
		});
		afterEach(() => {
			rmSync(tmp, { recursive: true, force: true });
		});

		it("constructs a KokoroTtsBackend against the real fused lib", () => {
			const bridge = EngineVoiceBridge.start({
				bundleRoot: "", // kokoroOnly skips the existsSync check
				useFfiBackend: false,
				kokoroOnly: makeKokoroConfig(tmp),
				kokoroFfi: ffi,
				lifecycleLoaders: lifecycleLoadersOk(),
			});
			expect(bridge.backend?.id).toBe("kokoro");
			expect(bridge.asrAvailable).toBe(false); // ASR is not served from this path
			expect(bridge.ffi).toBeNull();
			bridge.dispose();
		});

		it("uses the provided bundleRoot as working dir when it exists", () => {
			const bridge = EngineVoiceBridge.start({
				bundleRoot: tmp,
				useFfiBackend: false,
				kokoroOnly: makeKokoroConfig(tmp),
				kokoroFfi: ffi,
				lifecycleLoaders: lifecycleLoadersOk(),
			});
			expect(bridge.backend?.id).toBe("kokoro");
			bridge.dispose();
		});

		it("arms with no-op lifecycle loaders by default (no real mmap regions)", async () => {
			const bridge = EngineVoiceBridge.start({
				bundleRoot: "",
				useFfiBackend: false,
				kokoroOnly: makeKokoroConfig(tmp),
				kokoroFfi: ffi,
			});
			await expect(bridge.arm()).resolves.toBeUndefined();
			bridge.dispose();
		});

		it("preserves the requested sample rate from the kokoroOnly layout", () => {
			const bridge = EngineVoiceBridge.start({
				bundleRoot: "",
				useFfiBackend: false,
				kokoroOnly: {
					...makeKokoroConfig(tmp),
					layout: { ...makeKokoroConfig(tmp).layout, sampleRate: 16_000 },
				},
				kokoroFfi: ffi,
				lifecycleLoaders: lifecycleLoadersOk(),
			});
			expect((bridge.backend as KokoroTtsBackend).sampleRate).toBe(16_000);
			bridge.dispose();
		});
	},
);

// ── Gated real TTFA synth (issue #8787 acceptance criteria 4 + 7) ──
//
// Drives the REAL fused Kokoro engine over a REAL discovered Kokoro GGUF +
// voice .bin, synthesizes a phrase, and asserts (a) non-empty 24 kHz PCM is
// produced and (b) the first AUDIBLE chunk arrives within the mobile-class
// TTFA budget. Skipped (never faked) when the fused lib is unresolved, the
// build does not link Kokoro, or no Kokoro model is staged on disk
// (`resolveKokoroEngineConfig() === null`). Stage a model under
// `$ELIZA_KOKORO_MODEL_DIR` (or `~/.eliza/local-inference/models/kokoro/`).
const KOKORO_MODEL = isBun && LIB_PATH ? resolveKokoroEngineConfig() : null;

describe.skipIf(!isBun || !LIB_PATH || !KOKORO_MODEL)(
	"Kokoro real synth — TTFA on the in-process fused engine",
	() => {
		let ffi: ElizaInferenceFfi;

		beforeAll(() => {
			ffi = loadElizaInferenceFfi(LIB_PATH as string);
			if (typeof ffi.kokoroSupported !== "function" || !ffi.kokoroSupported()) {
				throw new Error(
					`[test] the fused lib at ${LIB_PATH} does not link the in-process Kokoro engine.`,
				);
			}
		});
		afterAll(() => {
			(ffi as unknown as { close?: () => void }).close?.();
		});

		it("synthesizes real PCM and reaches first audio within the mobile TTFA budget", async () => {
			// Non-null inside the skipIf guard.
			const kokoro = KOKORO_MODEL as KokoroEngineDiscoveryResult;
			const backend = createKokoroTtsBackend(kokoro, { ffi });
			const preset = createKokoroSpeakerPreset(kokoro);
			const phrase: Phrase = {
				id: 1,
				text: "Hello, this is a time to first audio probe.",
				fromIndex: 0,
				toIndex: 42,
				terminator: "punctuation",
			};

			const startedAt = performance.now();
			let firstAudibleAtMs: number | null = null;
			let totalSamples = 0;
			let sampleRate = 0;
			await backend.synthesizeStream({
				phrase,
				preset,
				cancelSignal: { cancelled: false },
				onChunk: (c) => {
					if (!c.isFinal && c.pcm.length > 0) {
						if (firstAudibleAtMs === null) {
							firstAudibleAtMs = performance.now() - startedAt;
						}
						totalSamples += c.pcm.length;
						sampleRate = c.sampleRate;
					}
					return undefined;
				},
			});
			backend.dispose();

			// Real, non-empty 24 kHz PCM — never a silent stub (acceptance criterion 4).
			expect(totalSamples).toBeGreaterThan(0);
			expect(sampleRate).toBe(24_000);
			// First audible chunk within the mobile-class TTFA budget (criterion 7).
			expect(firstAudibleAtMs).not.toBeNull();
			expect(firstAudibleAtMs as unknown as number).toBeLessThanOrEqual(
				KOKORO_MOBILE_TTFA_BUDGET_MS,
			);
		});
	},
);
