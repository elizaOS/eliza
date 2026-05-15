/**
 * Integration test: VoiceProfileStore + VoiceAttributionPipeline wired
 * into EngineVoiceBridge via the `profileStore` option.
 *
 * Covers (W3-1 item 1):
 *   - EngineVoiceBridge.start() accepts `profileStore` and wires an
 *     internal VoiceAttributionPipeline.
 *   - `runVoiceTurn` invokes attribution in parallel with ASR.
 *   - When `profileStore` is absent, `onAttribution` is never called.
 *   - Attribution errors do NOT crash the turn (AGENTS.md §3 best-effort).
 *   - The `VoiceTurnEvents` type extends `VoicePipelineEvents` with
 *     `onAttribution`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EngineVoiceBridge,
	type VoiceTurnEvents,
} from "../src/services/voice/engine-bridge";
import { VoiceProfileStore } from "../src/services/voice/profile-store";
import type { VoiceLifecycleLoaders } from "../src/services/voice/lifecycle";
import type {
	MmapRegionHandle,
	RefCountedResource,
} from "../src/services/voice/shared-resources";
import { writeVoicePresetFile } from "../src/services/voice/voice-preset-format";

// ── helpers ─────────────────────────────────────────────────────────────────

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

function writeBundlePreset(root: string): void {
	mkdirSync(path.join(root, "cache"), { recursive: true });
	const embedding = new Float32Array(16);
	for (let i = 0; i < embedding.length; i++) embedding[i] = (i + 1) / 100;
	writeFileSync(
		path.join(root, "cache", "voice-preset-default.bin"),
		Buffer.from(writeVoicePresetFile({ embedding, phrases: [] })),
	);
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("EngineVoiceBridge — VoiceProfileStore attribution wiring (W3-1 item 1)", () => {
	let root: string;
	let store: VoiceProfileStore;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "w3-1-attribution-"));
		writeBundlePreset(root);
		store = new VoiceProfileStore({
			rootDir: path.join(root, "profiles"),
			hotCacheSize: 10,
		});
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("start() accepts profileStore without throwing", () => {
		expect(() =>
			EngineVoiceBridge.start({
				bundleRoot: root,
				useFfiBackend: false,
				profileStore: store,
				lifecycleLoaders: lifecycleLoadersOk(),
			}),
		).not.toThrow();
	});

	it("start() with no profileStore also works (baseline)", () => {
		expect(() =>
			EngineVoiceBridge.start({
				bundleRoot: root,
				useFfiBackend: false,
				lifecycleLoaders: lifecycleLoadersOk(),
			}),
		).not.toThrow();
	});

	it("VoiceTurnEvents extends VoicePipelineEvents and exposes onAttribution", () => {
		// Type-level check: VoiceTurnEvents is a superset of VoicePipelineEvents.
		const events: VoiceTurnEvents = {
			onAsrComplete: () => {},
			onComplete: () => {},
			onAttribution: (_output) => {},
		};
		expect(typeof events.onAttribution).toBe("function");
		expect(typeof events.onAsrComplete).toBe("function");
	});

	it("attribution error does NOT propagate to runVoiceTurn caller", async () => {
		const bridge = EngineVoiceBridge.start({
			bundleRoot: root,
			useFfiBackend: false,
			profileStore: store,
			lifecycleLoaders: lifecycleLoadersOk(),
		});
		await bridge.arm();

		// Intercept buildPipeline to get a stub that resolves "done" immediately.
		// This avoids needing a live DFlash server for the text-generation side.
		vi.spyOn(bridge, "buildPipeline").mockImplementation((_runner, _cfg, evts) => {
			const stubbedPipeline = {
				run: vi.fn().mockResolvedValue("done"),
				cancel: vi.fn(),
				isRunning: vi.fn().mockReturnValue(false),
				getPartialStabilizer: vi.fn().mockReturnValue(null),
			};
			// Forward the scheduler barge-in attach if needed (no-op for tests).
			return stubbedPipeline as never;
		});

		// Even though attribution will fail (no encoder.onnx on disk in this
		// test env), the turn should still resolve normally.
		const result = await bridge.runVoiceTurn(
			{ pcm: new Float32Array(16_000), sampleRate: 16_000 },
			{} as never, // textRunner stub — not used due to buildPipeline mock
			{ maxDraftTokens: 2 },
			{ onAttribution: () => {} },
		);

		expect(result).toBe("done");
	});

	it("without profileStore, onAttribution is never invoked", async () => {
		const bridge = EngineVoiceBridge.start({
			bundleRoot: root,
			useFfiBackend: false,
			// No profileStore
			lifecycleLoaders: lifecycleLoadersOk(),
		});
		await bridge.arm();

		const onAttribution = vi.fn();

		vi.spyOn(bridge, "buildPipeline").mockImplementation((_runner, _cfg, _evts) => {
			return {
				run: vi.fn().mockResolvedValue("done"),
				cancel: vi.fn(),
				isRunning: vi.fn().mockReturnValue(false),
				getPartialStabilizer: vi.fn().mockReturnValue(null),
			} as never;
		});

		await bridge.runVoiceTurn(
			{ pcm: new Float32Array(16_000), sampleRate: 16_000 },
			{} as never,
			{ maxDraftTokens: 2 },
			{ onAttribution },
		);

		// Wait a tick for any async attribution to fire (there should be none).
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(onAttribution).not.toHaveBeenCalled();
	});

	it("attribution fires asynchronously when profileStore is wired", async () => {
		const bridge = EngineVoiceBridge.start({
			bundleRoot: root,
			useFfiBackend: false,
			profileStore: store,
			lifecycleLoaders: lifecycleLoadersOk(),
		});
		await bridge.arm();

		let attributionCalled = false;
		let attributionError: Error | null = null;

		// We can't control whether attribution succeeds (encoder not on disk)
		// but we can assert that the turn itself completes without error and
		// that attribution was at least attempted (errors go to console.warn,
		// not to the caller).
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		vi.spyOn(bridge, "buildPipeline").mockImplementation((_runner, _cfg, _evts) => {
			return {
				run: vi.fn().mockResolvedValue("done"),
				cancel: vi.fn(),
				isRunning: vi.fn().mockReturnValue(false),
				getPartialStabilizer: vi.fn().mockReturnValue(null),
			} as never;
		});

		const result = await bridge.runVoiceTurn(
			{ pcm: new Float32Array(16_000), sampleRate: 16_000 },
			{} as never,
			{ maxDraftTokens: 2 },
			{
				onAttribution: (output) => {
					attributionCalled = true;
					// Verify the output shape (W3-1: attribution must fire on every
					// transcript with diarization).
					expect(output).toHaveProperty("turnId");
					expect(output).toHaveProperty("segments");
					expect(output).toHaveProperty("turn");
					expect(output).toHaveProperty("observation");
				},
			},
		);

		expect(result).toBe("done");

		// Wait for async attribution to settle (encoder load + attribute call).
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Either attribution succeeded and onAttribution was called, OR the
		// encoder was unavailable and a warning was logged. Both are valid.
		// The turn must have completed without throwing in either case (tested above).
		// If encoder was missing, a console.warn should have been emitted.
		if (!attributionCalled) {
			// Encoder not available in test environment — expected.
			// The bridge emits a console.warn with the turn id and error message.
			expect(consoleWarnSpy.mock.calls.flat().join(" ")).toContain(
				"[voice-bridge] speaker attribution failed",
			);
		}

		consoleWarnSpy.mockRestore();
	});
});
