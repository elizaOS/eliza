/**
 * Unit tests for `EngineVoiceBridge.startKokoroOnly` option validation — the
 * mutually-exclusive backend-path checks that throw before any FFI work, so
 * they need no library.
 *
 * Real FFI construction (loading `libelizainference` + `create` + Kokoro
 * support) is exercised against the ACTUAL library — never a stub — in
 * `kokoro-engine-bridge.real.test.ts`, gated on the fused lib being built.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";

import { EngineVoiceBridge, VoiceStartupError } from "../../engine-bridge";
import type { KokoroEngineDiscoveryResult } from "../kokoro-engine-discovery";

function makeKokoroConfig(): KokoroEngineDiscoveryResult {
	return {
		layout: {
			root: "/tmp/fake-kokoro",
			modelFile: "kokoro-82m-v1_0-Q4_K_M.gguf",
			voicesDir: path.join("/tmp/fake-kokoro", "voices"),
			sampleRate: 24_000,
		},
		defaultVoiceId: "af_bella",
	};
}

describe("EngineVoiceBridge — kokoroOnly option validation", () => {
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
});
