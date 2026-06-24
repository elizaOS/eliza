/**
 * Unit coverage for the ASR-backend preference resolvers (#9147 voice).
 *
 * normalizeAsrBackendPreference / readAsrBackendPreferenceFromEnv /
 * ffiSupportsStreamingAsr are the pure selection helpers that decide whether
 * transcription runs on the fused streaming ASR, the FFI batch path, or auto.
 * They were untested. No GGUF / FFI loaded (the module has only type imports).
 */

import { describe, expect, it } from "vitest";
import {
	ffiSupportsStreamingAsr,
	normalizeAsrBackendPreference,
	readAsrBackendPreferenceFromEnv,
} from "./transcriber";

type FfiArg = Parameters<typeof ffiSupportsStreamingAsr>[0];
const fakeFfi = (supported: boolean): FfiArg =>
	({ asrStreamSupported: () => supported }) as unknown as FfiArg;

describe("normalizeAsrBackendPreference", () => {
	it("maps the canonical names and their aliases", () => {
		expect(normalizeAsrBackendPreference("auto")).toBe("auto");
		expect(normalizeAsrBackendPreference("fused")).toBe("fused");
		expect(normalizeAsrBackendPreference("streaming")).toBe("fused");
		expect(normalizeAsrBackendPreference("fused-streaming")).toBe("fused");
		expect(normalizeAsrBackendPreference("batch")).toBe("ffi-batch");
		expect(normalizeAsrBackendPreference("ffi-batch")).toBe("ffi-batch");
		expect(normalizeAsrBackendPreference("fused-batch")).toBe("ffi-batch");
	});

	it("normalizes case, whitespace and underscores", () => {
		expect(normalizeAsrBackendPreference("  FUSED_STREAMING ")).toBe("fused");
		expect(normalizeAsrBackendPreference("FFI_BATCH")).toBe("ffi-batch");
	});

	it("returns null for empty / unknown input", () => {
		expect(normalizeAsrBackendPreference(null)).toBeNull();
		expect(normalizeAsrBackendPreference(undefined)).toBeNull();
		expect(normalizeAsrBackendPreference("   ")).toBeNull();
		expect(normalizeAsrBackendPreference("nonsense")).toBeNull();
	});
});

describe("readAsrBackendPreferenceFromEnv", () => {
	it("reads ELIZA_LOCAL_ASR_BACKEND from the provided env", () => {
		expect(
			readAsrBackendPreferenceFromEnv({ ELIZA_LOCAL_ASR_BACKEND: "streaming" }),
		).toBe("fused");
		expect(
			readAsrBackendPreferenceFromEnv({
				ELIZA_LOCAL_ASR_BACKEND: "fused-batch",
			}),
		).toBe("ffi-batch");
	});

	it("returns null when the env var is unset or unknown", () => {
		expect(readAsrBackendPreferenceFromEnv({})).toBeNull();
		expect(
			readAsrBackendPreferenceFromEnv({ ELIZA_LOCAL_ASR_BACKEND: "xyz" }),
		).toBeNull();
	});
});

describe("ffiSupportsStreamingAsr", () => {
	it("is false for null/undefined or an ffi missing the probe", () => {
		expect(ffiSupportsStreamingAsr(null)).toBe(false);
		expect(ffiSupportsStreamingAsr(undefined)).toBe(false);
		expect(ffiSupportsStreamingAsr({} as unknown as FfiArg)).toBe(false);
	});

	it("delegates to ffi.asrStreamSupported() when present", () => {
		expect(ffiSupportsStreamingAsr(fakeFfi(true))).toBe(true);
		expect(ffiSupportsStreamingAsr(fakeFfi(false))).toBe(false);
	});
});
