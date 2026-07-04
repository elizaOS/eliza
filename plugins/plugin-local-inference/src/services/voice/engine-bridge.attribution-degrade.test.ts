/**
 * Degradation-contract tests for the engine-bridge attribution gate (#12257).
 * When a profileStore is wired but the fused speaker runtime is absent (here:
 * `useFfiBackend: false`, so no fused handle), voice must still start WITHOUT
 * attribution and warn exactly once — never throw. Real EngineVoiceBridge +
 * real VoiceProfileStore; only the fused native build is absent (the point).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineVoiceBridge } from "./engine-bridge";
import type { VoiceLifecycleLoaders } from "./lifecycle";
import { VoiceProfileStore } from "./profile-store";
import type { MmapRegionHandle, RefCountedResource } from "./shared-resources";
import { writeVoicePresetFile } from "./voice-preset-format";

function writePresetBundle(root: string): void {
	mkdirSync(path.join(root, "cache"), { recursive: true });
	const embedding = new Float32Array(16);
	for (let i = 0; i < embedding.length; i += 1) embedding[i] = (i + 1) / 100;
	writeFileSync(
		path.join(root, "cache", "voice-preset-default.bin"),
		Buffer.from(writeVoicePresetFile({ embedding, phrases: [] })),
	);
}

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

let bundleRoot: string;
let store: VoiceProfileStore;

beforeEach(async () => {
	bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-degrade-"));
	writePresetBundle(bundleRoot);
	store = new VoiceProfileStore({
		rootDir: mkdtempSync(path.join(tmpdir(), "vp-degrade-")),
	});
	await store.init();
});

afterEach(() => {
	rmSync(bundleRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("engine-bridge attribution degradation (#12257)", () => {
	// The warn-once guard is module-global, so both starts live in one test:
	// the first degrades + warns, the second degrades silently.
	it("starts voice WITHOUT attribution, warns exactly once, never throws", async () => {
		const warn = vi.spyOn(logger, "warn");

		// profileStore wired, but useFfiBackend:false → no fused handle, so start()
		// degrades instead of throwing VoiceStartupError.
		const first = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
			lifecycleLoaders: lifecycleLoadersOk(),
			profileStore: store,
		});
		// Voice is functional: no throw, and the lifecycle arms.
		await expect(first.arm()).resolves.toBeUndefined();
		await first.disarm();

		// A second degraded start must not re-warn (no per-session spam).
		const second = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
			lifecycleLoaders: lifecycleLoadersOk(),
			profileStore: store,
		});
		expect(second).toBeInstanceOf(EngineVoiceBridge);

		const attributionWarnings = warn.mock.calls.filter((c) =>
			String(c[0]).includes("Speaker attribution requested but"),
		);
		expect(attributionWarnings).toHaveLength(1);
		expect(String(attributionWarnings[0][0])).toContain(
			"fused libelizainference handle is absent",
		);
	});
});
