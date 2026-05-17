import { describe, expect, it } from "vitest";

import { pickKokoroRuntimeBackend } from "./pick-runtime";
import type { KokoroModelLayout } from "./types";

function onnxLayout(): KokoroModelLayout {
	return {
		root: "/tmp/kokoro-test",
		modelFile: "model_q4.onnx",
		voicesDir: "/tmp/kokoro-test/voices",
		sampleRate: 24_000,
	};
}

describe("pickKokoroRuntimeBackend", () => {
	it("uses the discovered ONNX model layout as the default when no env override is set", () => {
		const decision = pickKokoroRuntimeBackend({
			defaultBackend: "onnx",
			env: {},
			onnx: {
				layout: onnxLayout(),
				expectedSha256: null,
			},
			fork: {
				serverUrl: "http://127.0.0.1:18789",
				modelId: "kokoro-v1.0",
				sampleRate: 24_000,
			},
		});

		expect(decision.backend).toBe("onnx");
		expect(decision.runtime.id).toBe("onnx");
		expect(decision.reason).toMatch(/model layout default/);
	});

	it("keeps KOKORO_BACKEND as an explicit operator override", () => {
		const decision = pickKokoroRuntimeBackend({
			defaultBackend: "onnx",
			env: { KOKORO_BACKEND: "fork" },
			onnx: {
				layout: onnxLayout(),
				expectedSha256: null,
			},
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
});
