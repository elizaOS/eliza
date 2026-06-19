import { describe, expect, it } from "vitest";
import { shouldEnableMobileLocalInference } from "./mobile-local-inference-gate";

describe("shouldEnableMobileLocalInference", () => {
	it("returns false when no env flags and arch is not riscv64", () => {
		expect(shouldEnableMobileLocalInference({}, "x64")).toBe(false);
		expect(shouldEnableMobileLocalInference({}, "arm64")).toBe(false);
	});

	it("returns true when ELIZA_DEVICE_BRIDGE_ENABLED=1", () => {
		expect(
			shouldEnableMobileLocalInference(
				{ ELIZA_DEVICE_BRIDGE_ENABLED: "1" },
				"x64",
			),
		).toBe(true);
	});

	it("returns true when ELIZA_LOCAL_LLAMA=1", () => {
		expect(
			shouldEnableMobileLocalInference({ ELIZA_LOCAL_LLAMA: "1" }, "x64"),
		).toBe(true);
	});

	it("auto-fires on riscv64 with no env flags", () => {
		// node-llama-cpp has no riscv64 prebuild; the FFI loader (which dlopens
		// the cross-built libllama.so) is the only in-process llama.cpp path
		// available on riscv64, so the gate auto-fires there.
		expect(shouldEnableMobileLocalInference({}, "riscv64")).toBe(true);
	});

	it("ELIZA_DISABLE_FFI_LLAMA=1 hard-disables the riscv64 auto-fire", () => {
		// Operator opt-out: route inference to Cloud instead of the on-device
		// FFI path. The device-bridge is process-external and unaffected.
		expect(
			shouldEnableMobileLocalInference(
				{ ELIZA_DISABLE_FFI_LLAMA: "1" },
				"riscv64",
			),
		).toBe(false);
	});

	it("ELIZA_DISABLE_FFI_LLAMA=1 does not block the device-bridge path", () => {
		expect(
			shouldEnableMobileLocalInference(
				{
					ELIZA_DISABLE_FFI_LLAMA: "1",
					ELIZA_DEVICE_BRIDGE_ENABLED: "1",
				},
				"riscv64",
			),
		).toBe(true);
	});

	it("ELIZA_DISABLE_FFI_LLAMA=1 suppresses ELIZA_LOCAL_LLAMA=1 too", () => {
		// `ELIZA_LOCAL_LLAMA` is the AOSP/FFI in-process trigger, so the
		// disable flag must override it. Otherwise a riscv64 operator who set
		// disable would still be forced into the FFI path on an AOSP build.
		expect(
			shouldEnableMobileLocalInference(
				{
					ELIZA_DISABLE_FFI_LLAMA: "1",
					ELIZA_LOCAL_LLAMA: "1",
				},
				"riscv64",
			),
		).toBe(false);
	});
});
