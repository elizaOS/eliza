/**
 * Unit tests for the mobile inference gate: which combinations of
 * `ELIZA_DEVICE_BRIDGE_ENABLED` / `ELIZA_LOCAL_LLAMA` / riscv64 arch enable the
 * on-device path, and the without-platform warning.
 */

import { describe, expect, it, vi } from "vitest";
import {
	shouldEnableMobileLocalInference,
	warnIfMobileGateActiveWithoutPlatform,
} from "./mobile-local-inference-gate";

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

	it("returns true when ELIZA_BIONIC_HOST_DELEGATED=1 (Android bionic delegation)", () => {
		// The agent delegates inference to the in-process bionic Vulkan host over
		// UDS; without this trigger ensureLocalInferenceHandler is skipped on the
		// phone, so the bionic loader + TTS/TRANSCRIPTION/IMAGE_DESCRIPTION
		// handlers never register and only the direct-reply chat path works (#8848).
		expect(
			shouldEnableMobileLocalInference(
				{ ELIZA_BIONIC_HOST_DELEGATED: "1" },
				"arm64",
			),
		).toBe(true);
	});

	it("ELIZA_DISABLE_FFI_LLAMA=1 does not block the bionic-host path (process-external UDS)", () => {
		expect(
			shouldEnableMobileLocalInference(
				{
					ELIZA_DISABLE_FFI_LLAMA: "1",
					ELIZA_BIONIC_HOST_DELEGATED: "1",
				},
				"arm64",
			),
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

describe("warnIfMobileGateActiveWithoutPlatform", () => {
	it("warns when the gate is active (ELIZA_LOCAL_LLAMA=1) but ELIZA_PLATFORM is unset", () => {
		const warn = vi.fn();
		const fired = warnIfMobileGateActiveWithoutPlatform({
			mobilePlatform: false,
			warn,
			env: { ELIZA_LOCAL_LLAMA: "1" },
			arch: "arm64",
		});
		expect(fired).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		const message = warn.mock.calls[0]?.[0] ?? "";
		expect(message).toContain("ELIZA_PLATFORM");
		expect(message).toContain("Kokoro-exclusive mobile");
	});

	it("warns when the gate is active via the device bridge and ELIZA_PLATFORM is unset", () => {
		const warn = vi.fn();
		const fired = warnIfMobileGateActiveWithoutPlatform({
			mobilePlatform: false,
			warn,
			env: { ELIZA_DEVICE_BRIDGE_ENABLED: "1" },
			arch: "arm64",
		});
		expect(fired).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("does NOT warn when ELIZA_PLATFORM=android (mobilePlatform true)", () => {
		// On a real phone the platform flag is set, so isMobilePlatform() is true
		// and the selector already pins Kokoro — no mismatch to report.
		const warn = vi.fn();
		const fired = warnIfMobileGateActiveWithoutPlatform({
			mobilePlatform: true,
			warn,
			env: { ELIZA_LOCAL_LLAMA: "1", ELIZA_PLATFORM: "android" },
			arch: "arm64",
		});
		expect(fired).toBe(false);
		expect(warn).not.toHaveBeenCalled();
	});

	it("does NOT warn when the gate is inactive (desktop x64, no flags)", () => {
		const warn = vi.fn();
		const fired = warnIfMobileGateActiveWithoutPlatform({
			mobilePlatform: false,
			warn,
			env: {},
			arch: "x64",
		});
		expect(fired).toBe(false);
		expect(warn).not.toHaveBeenCalled();
	});
});
