/**
 * Host-mockable contract tests for the multi-backend in-process FFI selector
 * seam (issue #9033 — multi-backend `libelizainference`).
 *
 * The native side picks the fastest in-process backend (llama.cpp / LiteRT /
 * MLX-CoreML) behind one FFI pipe; the TS side is the deterministic boundary
 * that decides *whether* the FFI path is used at all and which platform slot it
 * runs in. Both `backend-selector.ts` and `runtime-target.ts` are pure — every
 * input is an explicit argument so the decision replays offline with synthetic
 * values. These tests pin the three properties the seam must hold *before the
 * device kernels land*:
 *
 *   1. selection precedence  — env override beats platform heuristics;
 *   2. inert-by-default      — the seam never invents a server / sidecar / NPU
 *                              branch on its own; the only way off the default
 *                              FFI path is an explicit env override, and a
 *                              broken build throws instead of falling back;
 *   3. platform / capability — desktop / mobile / capacitor branching maps to
 *                              the correct selector slot.
 *
 * The existing `backend-selector.test.ts` / `runtime-target.test.ts` cover the
 * happy paths; this file pins the precedence edges and the cross-module
 * contract that the device-kernel work will build on.
 */

import { describe, expect, it } from "vitest";

import {
	type LocalInferenceBackend,
	readBackendEnvOverride,
	selectBackend,
} from "../backend-selector";
import {
	inferencePlatformClass,
	inferenceRuntimeMode,
	readRuntimeModeEnvOverride,
} from "../runtime-target";

describe("backend-selector precedence", () => {
	it("envOverride forces the FFI path before the platform branch is consulted", () => {
		// override is evaluated first: a missing-symbol mobile build with
		// envOverride=ffi must surface the *override* failure ("does not export"),
		// not the platform-specific "missing streaming-LLM FFI symbols" message.
		expect(() =>
			selectBackend({
				platform: "mobile",
				ffiSupported: false,
				envOverride: "ffi",
			}),
		).toThrow(/does not export the streaming-LLM symbols/);

		// And it does NOT throw the bare-platform message.
		expect(() =>
			selectBackend({
				platform: "mobile",
				ffiSupported: false,
				envOverride: "ffi",
			}),
		).not.toThrow(/Mobile build missing/);
	});

	it("envOverride is matched case-insensitively", () => {
		for (const override of ["FFI", "Ffi", "fFi"]) {
			expect(
				selectBackend({
					platform: "desktop",
					ffiSupported: true,
					envOverride: override,
				}),
			).toBe("ffi-streaming");
		}
	});

	it("a non-ffi / unknown envOverride is ignored and falls through to the platform default", () => {
		// "server", "http", "auto", "" and noise are NOT the ffi override token,
		// so the platform default rule decides. With FFI present that is always
		// ffi-streaming — the override never selects a different backend.
		for (const override of [
			"server",
			"http",
			"auto",
			"",
			"garbage",
			"native",
		]) {
			expect(
				selectBackend({
					platform: "desktop",
					ffiSupported: true,
					envOverride: override,
				}),
			).toBe("ffi-streaming");
		}
	});

	it("a null / undefined envOverride is treated as no override", () => {
		expect(
			selectBackend({
				platform: "mobile",
				ffiSupported: true,
				envOverride: null,
			}),
		).toBe("ffi-streaming");
		expect(
			selectBackend({
				platform: "mobile",
				ffiSupported: true,
				envOverride: undefined,
			}),
		).toBe("ffi-streaming");
	});
});

describe("backend-selector inert-by-default", () => {
	// The seam has exactly one shipping backend today. "Inert by default" means:
	// no platform/env input combination quietly conjures a second backend or a
	// server/sidecar fallback. The selector either returns "ffi-streaming" or
	// throws — there is no third outcome.
	const platforms = ["desktop", "mobile"] as const;
	const overrides = [
		undefined,
		null,
		"",
		"auto",
		"ffi",
		"server",
		"http",
		"native-bridge",
		"garbage",
	];

	it("only ever returns ffi-streaming or throws — never a server / sidecar backend", () => {
		const observed = new Set<LocalInferenceBackend>();
		for (const platform of platforms) {
			for (const ffiSupported of [true, false]) {
				for (const envOverride of overrides) {
					let result: LocalInferenceBackend | "threw";
					try {
						result = selectBackend({ platform, ffiSupported, envOverride });
					} catch {
						result = "threw";
					}
					if (result !== "threw") {
						observed.add(result);
					}
				}
			}
		}
		// Every non-throwing decision is the single FFI backend.
		expect([...observed]).toEqual(["ffi-streaming"]);
	});

	it("a missing FFI build is a hard failure, never a silent fallback", () => {
		// No envOverride: the platform default still demands FFI symbols. A bad
		// build throws rather than degrading to some other path.
		expect(() =>
			selectBackend({ platform: "desktop", ffiSupported: false }),
		).toThrow(/missing streaming-LLM FFI symbols/);
		expect(() =>
			selectBackend({ platform: "mobile", ffiSupported: false }),
		).toThrow(/missing streaming-LLM FFI symbols/);
	});

	it("readBackendEnvOverride does not resurrect server / sidecar aliases", () => {
		for (const value of [
			"server",
			"http",
			"http-server",
			"llama-server",
			"spawn",
			"sidecar",
			"native-bridge",
		]) {
			expect(
				readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: value }),
			).toBeNull();
		}
	});
});

describe("readBackendEnvOverride normalisation", () => {
	it("trims surrounding whitespace before matching", () => {
		expect(readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "  ffi  " })).toBe(
			"ffi",
		);
		expect(
			readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "\tauto\n" }),
		).toBe("auto");
	});

	it("treats whitespace-only / empty as unset (null)", () => {
		expect(
			readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "   " }),
		).toBeNull();
		expect(readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "" })).toBeNull();
	});

	it("collapses the ffi-streaming alias to ffi and lowercases", () => {
		expect(
			readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "FFI-STREAMING" }),
		).toBe("ffi");
	});

	it("reads from process.env by default", () => {
		const saved = process.env.ELIZA_INFERENCE_BACKEND;
		try {
			process.env.ELIZA_INFERENCE_BACKEND = "ffi";
			expect(readBackendEnvOverride()).toBe("ffi");
			delete process.env.ELIZA_INFERENCE_BACKEND;
			expect(readBackendEnvOverride()).toBeNull();
		} finally {
			if (saved === undefined) {
				delete process.env.ELIZA_INFERENCE_BACKEND;
			} else {
				process.env.ELIZA_INFERENCE_BACKEND = saved;
			}
		}
	});
});

describe("runtime-target inert-by-default + capability branching", () => {
	// native-bridge is the one off-default branch. It must be unreachable from
	// platform/capacitor heuristics alone — it is selectable ONLY by an explicit
	// ELIZA_INFERENCE_MODE override. Anything else stays on the owned FFI pipe.
	it("never auto-selects native-bridge from platform or capacitor signals", () => {
		const platforms: NodeJS.Platform[] = [
			"darwin",
			"linux",
			"win32",
			"ios" as NodeJS.Platform,
			"android" as NodeJS.Platform,
			"freebsd" as NodeJS.Platform,
			"aix" as NodeJS.Platform,
		];
		for (const platform of platforms) {
			for (const isCapacitorNative of [true, false]) {
				expect(
					inferenceRuntimeMode({ env: {}, platform, isCapacitorNative }),
				).toBe("ffi");
			}
		}
	});

	it("native-bridge is reachable only through the explicit env override", () => {
		expect(
			inferenceRuntimeMode({
				env: { ELIZA_INFERENCE_MODE: "native-bridge" },
				platform: "android" as NodeJS.Platform,
				isCapacitorNative: true,
			}),
		).toBe("native-bridge");
	});

	it("env override beats both platform and capacitor heuristics", () => {
		// ffi override on a native-bridge-shaped host stays ffi.
		expect(
			inferenceRuntimeMode({
				env: { ELIZA_INFERENCE_MODE: "ffi" },
				platform: "android" as NodeJS.Platform,
				isCapacitorNative: true,
			}),
		).toBe("ffi");
		// native-bridge override on a plain desktop host wins.
		expect(
			inferenceRuntimeMode({
				env: { ELIZA_INFERENCE_MODE: "native-bridge" },
				platform: "linux",
				isCapacitorNative: false,
			}),
		).toBe("native-bridge");
	});

	it("an unrecognised ELIZA_INFERENCE_MODE is ignored (stays on the owned pipe)", () => {
		expect(readRuntimeModeEnvOverride({ ELIZA_INFERENCE_MODE: "litert" })).toBe(
			null,
		);
		expect(
			inferenceRuntimeMode({
				env: { ELIZA_INFERENCE_MODE: "litert" },
				platform: "android" as NodeJS.Platform,
				isCapacitorNative: false,
			}),
		).toBe("ffi");
	});

	it("inferencePlatformClass with no argument resolves through the live default", () => {
		// Default param calls inferenceRuntimeMode(); with no env override and no
		// capacitor shell in a plain test process that resolves to ffi → desktop.
		const saved = process.env.ELIZA_INFERENCE_MODE;
		try {
			delete process.env.ELIZA_INFERENCE_MODE;
			expect(inferencePlatformClass()).toBe("desktop");
		} finally {
			if (saved !== undefined) process.env.ELIZA_INFERENCE_MODE = saved;
		}
	});
});

describe("runtime-target → backend-selector cross-module contract", () => {
	// The two pure modules compose: runtime-target picks the mode and maps it to
	// the selector's platform slot; backend-selector then makes the FFI decision.
	// This pins the end-to-end shape the device-kernel work plugs into.
	it("ffi mode → desktop slot → ffi-streaming when symbols are present", () => {
		const mode = inferenceRuntimeMode({
			env: {},
			platform: "linux",
			isCapacitorNative: false,
		});
		const platform = inferencePlatformClass(mode);
		expect(platform).toBe("desktop");
		expect(selectBackend({ platform, ffiSupported: true })).toBe(
			"ffi-streaming",
		);
	});

	it("native-bridge override → mobile slot → still demands FFI symbols", () => {
		const mode = inferenceRuntimeMode({
			env: { ELIZA_INFERENCE_MODE: "native-bridge" },
			platform: "android" as NodeJS.Platform,
			isCapacitorNative: true,
		});
		const platform = inferencePlatformClass(mode);
		expect(platform).toBe("mobile");
		// The selector is mode-agnostic: it only knows the platform slot. A
		// mobile slot without FFI symbols throws — no second backend exists.
		expect(() => selectBackend({ platform, ffiSupported: false })).toThrow(
			/Mobile build missing streaming-LLM FFI symbols/,
		);
		expect(selectBackend({ platform, ffiSupported: true })).toBe(
			"ffi-streaming",
		);
	});
});
