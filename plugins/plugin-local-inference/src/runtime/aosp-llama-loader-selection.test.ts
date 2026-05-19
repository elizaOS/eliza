/**
 * Riscv64 strategy: `capacitor-llama` ships native prebuilts for
 * linux-{x64,arm64}, darwin-arm64, win-x64. No riscv64 prebuild exists; we
 * also can't realistically NAPI-build it on-device. Instead the
 * `plugin-aosp-local-inference` FFI loader (which dlopens `libllama.so` +
 * the eliza-llama-shim via `bun:ffi`) is registered as the
 * `localInferenceLoader` service on riscv64 hosts, satisfying the same
 * contract `capacitor-llama` would otherwise satisfy on x64/arm64. The
 * vendored `libllama.so` cross-compiled for `linux-riscv64` /
 * `android-riscv64` by Wave 2 is what the FFI loader dlopens at runtime.
 *
 * This test covers the *selection* logic — i.e. the predicate that decides
 * whether to attempt registering the AOSP/FFI loader. The actual loader
 * registration is exercised by the integration tests in
 * `plugin-aosp-local-inference/__tests__/`.
 */
import { describe, expect, it } from "vitest";
import { shouldAttemptAospLlamaLoader } from "./ensure-local-inference-handler";

describe("shouldAttemptAospLlamaLoader", () => {
	it("returns false on x64 with no env flags", () => {
		expect(shouldAttemptAospLlamaLoader({}, "x64")).toBe(false);
	});

	it("returns false on arm64 (desktop) with no env flags", () => {
		// arm64 has a node-llama-cpp prebuild, so the FFI path is not the
		// only viable in-process option — we keep the stock binding as the
		// default and only flip to FFI on explicit opt-in.
		expect(shouldAttemptAospLlamaLoader({}, "arm64")).toBe(false);
	});

	it("returns true when ELIZA_LOCAL_LLAMA=1 (AOSP / explicit opt-in)", () => {
		expect(
			shouldAttemptAospLlamaLoader({ ELIZA_LOCAL_LLAMA: "1" }, "arm64"),
		).toBe(true);
	});

	it("auto-fires on riscv64 with no env flags", () => {
		expect(shouldAttemptAospLlamaLoader({}, "riscv64")).toBe(true);
	});

	it("ELIZA_DISABLE_FFI_LLAMA=1 hard-disables the riscv64 auto-fire", () => {
		expect(
			shouldAttemptAospLlamaLoader({ ELIZA_DISABLE_FFI_LLAMA: "1" }, "riscv64"),
		).toBe(false);
	});

	it("ELIZA_DISABLE_FFI_LLAMA=1 overrides explicit ELIZA_LOCAL_LLAMA=1", () => {
		// Disable wins — useful when an operator wants to route a riscv64
		// host's inference to Cloud despite an AOSP build defaulting the
		// in-process flag on.
		expect(
			shouldAttemptAospLlamaLoader(
				{
					ELIZA_DISABLE_FFI_LLAMA: "1",
					ELIZA_LOCAL_LLAMA: "1",
				},
				"riscv64",
			),
		).toBe(false);
	});

	it("ignores ELIZA_LOCAL_LLAMA values other than '1'", () => {
		expect(
			shouldAttemptAospLlamaLoader({ ELIZA_LOCAL_LLAMA: "0" }, "x64"),
		).toBe(false);
		expect(
			shouldAttemptAospLlamaLoader({ ELIZA_LOCAL_LLAMA: "true" }, "x64"),
		).toBe(false);
		expect(shouldAttemptAospLlamaLoader({ ELIZA_LOCAL_LLAMA: "" }, "x64")).toBe(
			false,
		);
	});

	it("trims whitespace around ELIZA_LOCAL_LLAMA before matching '1'", () => {
		expect(
			shouldAttemptAospLlamaLoader({ ELIZA_LOCAL_LLAMA: " 1 " }, "x64"),
		).toBe(true);
	});
});
