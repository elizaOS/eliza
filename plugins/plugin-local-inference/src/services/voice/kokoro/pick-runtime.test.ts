/** Covers `pickKokoroRuntimeBackend` runtime selection against the FFI bindings. Deterministic. */
import { describe, expect, it } from "vitest";

import type { ElizaInferenceFfi } from "../ffi-bindings";
import { pickKokoroRuntimeBackend } from "./pick-runtime";
import type { KokoroModelLayout } from "./types";

const LAYOUT: KokoroModelLayout = {
	root: "/tmp/kokoro",
	modelFile: "kokoro-82m-v1_0.gguf",
	voicesDir: "/tmp/kokoro/voices",
	sampleRate: 24_000,
};

/**
 * Minimal FFI stand-in for the in-process Kokoro path: only the symbols
 * `KokoroFfiRuntime`'s constructor touches (`kokoroSupported`, `create`) are
 * non-trivial. Synthesis itself is exercised in the runtime test; here we only
 * need a handle that constructs.
 */
function fakeKokoroFfi(supported = true): ElizaInferenceFfi {
	return {
		libraryPath: "/fake/libelizainference.so",
		libraryAbiVersion: "10",
		create: () => 1n,
		destroy: () => {},
		kokoroSupported: () => supported,
		kokoroLoad: () => {},
		kokoroSynthesize: () => new Float32Array(0),
		kokoroSampleRate: () => 24_000,
	} as unknown as ElizaInferenceFfi;
}

describe("pickKokoroRuntimeBackend", () => {
	it("defaults to the in-process ffi runtime when no backend or env override is set", () => {
		const decision = pickKokoroRuntimeBackend({
			env: {},
			ffi: { layout: LAYOUT, ffi: fakeKokoroFfi(), ctx: 1n },
		});

		expect(decision.backend).toBe("ffi");
		expect(decision.runtime.id).toBe("gguf");
		expect(decision.reason).toMatch(/default/);
		expect(decision.reason).toMatch(/in-process/);
	});

	it("uses ffi when KOKORO_BACKEND=ffi is set via env", () => {
		const decision = pickKokoroRuntimeBackend({
			env: { KOKORO_BACKEND: "ffi" },
			ffi: { layout: LAYOUT, ffi: fakeKokoroFfi(), ctx: 1n },
		});

		expect(decision.backend).toBe("ffi");
		expect(decision.reason).toMatch(/KOKORO_BACKEND=ffi/);
	});

	it("rejects the removed HTTP fork/server backend with an actionable error", () => {
		for (const value of ["fork", "server"]) {
			expect(() =>
				pickKokoroRuntimeBackend({
					env: { KOKORO_BACKEND: value },
					ffi: { layout: LAYOUT, ffi: fakeKokoroFfi(), ctx: 1n },
				}),
			).toThrow(/llama-server HTTP\) was removed/);
		}
	});

	it("uses mock when KOKORO_BACKEND=mock is set via env", () => {
		const decision = pickKokoroRuntimeBackend({
			env: { KOKORO_BACKEND: "mock" },
			mock: { sampleRate: 24_000 },
		});

		expect(decision.backend).toBe("mock");
		expect(decision.runtime.id).toBe("mock");
	});

	it("throws on unrecognized KOKORO_BACKEND value", () => {
		expect(() =>
			pickKokoroRuntimeBackend({
				env: { KOKORO_BACKEND: "bogus" },
				ffi: { layout: LAYOUT, ffi: fakeKokoroFfi(), ctx: 1n },
			}),
		).toThrow(/KOKORO_BACKEND must be one of/);
	});

	it("throws when the ffi backend is selected without its options block", () => {
		expect(() =>
			pickKokoroRuntimeBackend({ env: { KOKORO_BACKEND: "ffi" } }),
		).toThrow(/requires `inputs.ffi`/);
	});
});
