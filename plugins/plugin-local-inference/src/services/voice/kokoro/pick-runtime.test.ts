import { describe, expect, it } from "vitest";

import { pickKokoroRuntimeBackend } from "./pick-runtime";

describe("pickKokoroRuntimeBackend", () => {
	it("defaults to fork when no backend or env override is set", () => {
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
		expect(decision.reason).toMatch(/default/);
	});

	it("uses fork when KOKORO_BACKEND=fork is set via env", () => {
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
				fork: {
					serverUrl: "http://127.0.0.1:18789",
					modelId: "kokoro-v1.0",
					sampleRate: 24_000,
				},
			}),
		).toThrow(/KOKORO_BACKEND must be one of/);
	});
});
