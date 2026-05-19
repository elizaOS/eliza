import { describe, expect, it } from "vitest";

import {
	pickKokoroRuntimeBackend,
	readKokoroBackendFromEnv,
} from "./pick-runtime";

describe("pickKokoroRuntimeBackend", () => {
	it("defaults to the fork (GGUF) backend when no env override is set", () => {
		const decision = pickKokoroRuntimeBackend({
			env: {},
			fork: {
				serverUrl: "http://127.0.0.1:18789",
				modelId: "kokoro-v1.0",
				sampleRate: 24_000,
			},
		});

		expect(decision.backend).toBe("fork");
		expect(decision.runtime.id).toBe("gguf");
		expect(decision.reason).toMatch(/fork/);
	});

	it("honours an explicit KOKORO_BACKEND=fork operator override", () => {
		const decision = pickKokoroRuntimeBackend({
			env: { KOKORO_BACKEND: "fork" },
			fork: {
				serverUrl: "http://127.0.0.1:18789",
				modelId: "kokoro-v1.0",
				sampleRate: 24_000,
			},
		});

		expect(decision.backend).toBe("fork");
		expect(decision.runtime.id).toBe("gguf");
		expect(decision.reason).toMatch(/KOKORO_BACKEND=fork/);
	});

	it("throws on the retired KOKORO_BACKEND=onnx value (no silent downgrade)", () => {
		expect(() => readKokoroBackendFromEnv({ KOKORO_BACKEND: "onnx" })).toThrow(
			/no longer supported/,
		);
	});

	it("throws on an unrecognized KOKORO_BACKEND value", () => {
		expect(() => readKokoroBackendFromEnv({ KOKORO_BACKEND: "wat" })).toThrow(
			/must be one of/,
		);
	});
});
