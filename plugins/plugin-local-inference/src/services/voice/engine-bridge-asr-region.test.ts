/**
 * `asr/` region readability at engine-bridge startup.
 *
 * A bundle that ships no `asr/` directory is a legitimate "this build has
 * no local ASR" — the bridge must start and route ASR to the batch path /
 * report it absent. A bundle whose `asr/` directory exists but cannot be
 * listed (EACCES from a broken mount, wrong owner after a partial extract)
 * is a broken bundle: reporting it as "no ASR model" hides the real fault
 * behind an `AsrUnavailableError("no bundled ASR model")` later in the
 * session. These tests pin both sides of that split.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFfi } from "./__test-helpers__/fake-ffi";
import { EngineVoiceBridge } from "./engine-bridge";
import { VoiceStartupError } from "./errors";
import type { VoiceLifecycleLoaders } from "./lifecycle";
import type { MmapRegionHandle, RefCountedResource } from "./shared-resources";
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

describe("EngineVoiceBridge asr/ region readability", () => {
	let bundleRoot: string;
	let asrDir: string;
	let savedMode: number | null;

	beforeEach(() => {
		bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-asr-region-"));
		mkdirSync(path.join(bundleRoot, "cache"), { recursive: true });
		const embedding = new Float32Array(16);
		for (let i = 0; i < embedding.length; i++) embedding[i] = (i + 1) / 100;
		writeFileSync(
			path.join(bundleRoot, "cache", "voice-preset-default.bin"),
			Buffer.from(writeVoicePresetFile({ embedding, phrases: [] })),
		);
		mkdirSync(path.join(bundleRoot, "lib"), { recursive: true });
		for (const name of [
			"libelizainference.dylib",
			"libelizainference.so",
			"elizainference.dll",
		]) {
			writeFileSync(path.join(bundleRoot, "lib", name), "fake");
		}
		asrDir = path.join(bundleRoot, "asr");
		mkdirSync(asrDir, { recursive: true });
		writeFileSync(path.join(asrDir, "asr-model.gguf"), "fake");
		savedMode = null;
	});

	afterEach(() => {
		if (savedMode !== null) chmodSync(asrDir, savedMode);
		rmSync(bundleRoot, { recursive: true, force: true });
	});

	function startBridge(): EngineVoiceBridge {
		ffiHolder.current = fakeFfi("hello", { asrStreamSupported: true });
		return EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: true,
			lifecycleLoaders: lifecycleLoadersOk(),
		});
	}

	it("refuses to start when an existing asr/ region cannot be listed", () => {
		// root bypasses mode bits, so the EACCES case is unobservable there.
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			return;
		}
		savedMode = 0o755;
		chmodSync(asrDir, 0o000);

		let error: unknown;
		try {
			startBridge();
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(VoiceStartupError);
		expect((error as VoiceStartupError).code).toBe("unreadable-asr-region");
		expect((error as Error).message).toContain(asrDir);
	});

	it("still starts when the bundle ships no asr/ region at all", () => {
		rmSync(asrDir, { recursive: true, force: true });
		savedMode = null;

		const bridge = startBridge();
		// Absent ASR is legitimate: the bridge comes up and reports no local
		// ASR instead of failing startup.
		expect(bridge.asrAvailable).toBe(false);
	});
});
