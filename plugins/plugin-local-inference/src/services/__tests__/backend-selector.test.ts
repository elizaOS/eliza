/** Unit tests for `selectBackend` / `readBackendEnvOverride`: platform + FFI-support → backend id, and env-override parsing. Deterministic, no model. */
import { describe, expect, it } from "vitest";

import { readBackendEnvOverride, selectBackend } from "../backend-selector";

describe("selectBackend", () => {
	it("forces ffi-streaming on mobile when FFI is supported", () => {
		expect(
			selectBackend({
				platform: "mobile",
				ffiSupported: true,
			}),
		).toBe("ffi-streaming");
	});

	it("throws on mobile when FFI is missing", () => {
		expect(() =>
			selectBackend({
				platform: "mobile",
				ffiSupported: false,
			}),
		).toThrow(/streaming-LLM FFI symbols/);
	});

	it("desktop defaults to ffi-streaming when FFI is supported", () => {
		expect(
			selectBackend({
				platform: "desktop",
				ffiSupported: true,
			}),
		).toBe("ffi-streaming");
	});

	it("throws on desktop when FFI symbols are absent", () => {
		expect(() =>
			selectBackend({
				platform: "desktop",
				ffiSupported: false,
			}),
		).toThrow(/streaming-LLM FFI symbols/);
	});

	it("envOverride=ffi wins on desktop when supported", () => {
		expect(
			selectBackend({
				platform: "desktop",
				ffiSupported: true,
				envOverride: "ffi",
			}),
		).toBe("ffi-streaming");
	});

	it("envOverride=ffi without ffiSupported throws", () => {
		expect(() =>
			selectBackend({
				platform: "desktop",
				ffiSupported: false,
				envOverride: "ffi",
			}),
		).toThrow(/does not export the streaming-LLM symbols/);
	});

	it("envOverride=auto on desktop with FFI keeps the new default (ffi-streaming)", () => {
		expect(
			selectBackend({
				platform: "desktop",
				ffiSupported: true,
				envOverride: "auto",
			}),
		).toBe("ffi-streaming");
	});
});

describe("readBackendEnvOverride", () => {
	it("returns auto for explicit auto", () => {
		expect(readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "auto" })).toBe(
			"auto",
		);
	});

	it("normalizes ffi aliases and ignores server aliases", () => {
		expect(readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "FFI" })).toBe(
			"ffi",
		);
		expect(
			readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "ffi-streaming" }),
		).toBe("ffi");
		expect(
			readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "http-server" }),
		).toBeNull();
		expect(readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "server" })).toBe(
			null,
		);
	});

	it("returns null for unset / unknown", () => {
		expect(readBackendEnvOverride({})).toBeNull();
		expect(
			readBackendEnvOverride({ ELIZA_INFERENCE_BACKEND: "foo" }),
		).toBeNull();
	});
});
