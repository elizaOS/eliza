/**
 * Production-boundary coverage for the Core ML image-gen backend
 * (`loadCoreMlImageGenBackend`): unavailability gating, input validation
 * (empty / missing prompt), PNG payload trust boundary (signature + length),
 * dimension gates, seed fallback, and the dispose state machine.
 */
import { describe, expect, it } from "vitest";

import { loadCoreMlImageGenBackend } from "./coreml-unavailable";
import { ImageGenBackendUnavailableError } from "./errors";
import { PNG_SIGNATURE } from "./sd-cpp";

const VALID_PNG_B64 = Buffer.from(PNG_SIGNATURE).toString("base64");

function fakeBridge(overrides: Record<string, unknown> = {}) {
	return {
		isAvailable: () => true,
		generateImage: async (args: unknown) => ({
			png: VALID_PNG_B64,
			seed: 3,
			inferenceTimeMs: 12,
			...(args as Record<string, unknown>),
		}),
		...overrides,
	};
}

function loadWith(bridge: unknown) {
	return loadCoreMlImageGenBackend({
		loadArgs: {} as never,
		modelKey: "imagegen-coreml-sd-1_5",
		bridge: bridge as never,
	});
}

describe("loadCoreMlImageGenBackend", () => {
	it("throws binding_unavailable when the Capacitor bridge is missing", async () => {
		await expect(loadWith(undefined)).rejects.toThrow(
			ImageGenBackendUnavailableError,
		);
		await expect(loadWith(undefined)).rejects.toMatchObject({
			code: "IMAGE_GEN_BACKEND_UNAVAILABLE",
			reason: "binding_unavailable",
		});
	});

	it("throws binding_unavailable when the bridge reports unavailable", async () => {
		await expect(loadWith({ isAvailable: () => false })).rejects.toMatchObject({
			reason: "binding_unavailable",
		});
	});

	it("rejects requests outside the compiled .mlpackage shapes", async () => {
		const backend = await loadWith(fakeBridge());
		expect(backend.supports({ width: 512, height: 512 } as never)).toBe(true);
		expect(backend.supports({ width: 1024, height: 1024 } as never)).toBe(true);
		expect(backend.supports({} as never)).toBe(true); // defaults to 512
		expect(backend.supports({ width: 256, height: 512 } as never)).toBe(false);
		expect(backend.supports({ width: 512, height: 2048 } as never)).toBe(false);
		expect(backend.supports({ width: 0, height: 0 } as never)).toBe(false);
	});

	it("rejects an empty prompt with a structured error instead of a TypeError", async () => {
		const backend = await loadWith(fakeBridge());
		await expect(
			backend.generate({ prompt: "   " } as never),
		).rejects.toMatchObject({ reason: "unsupported_request" });
	});

	it("rejects a missing prompt with a structured error instead of a raw TypeError", async () => {
		// Regression: `req.prompt.trim()` threw `TypeError: Cannot read
		// properties of undefined` for a prompt-less request, breaking the
		// backend's contract that every failure is a structured
		// ImageGenBackendUnavailableError the selector can classify.
		const backend = await loadWith(fakeBridge());
		await expect(backend.generate({} as never)).rejects.toMatchObject({
			code: "IMAGE_GEN_BACKEND_UNAVAILABLE",
			reason: "unsupported_request",
		});
	});

	it("throws binding_unavailable when generate is called after dispose", async () => {
		const backend = await loadWith(fakeBridge());
		await backend.dispose();
		await expect(
			backend.generate({ prompt: "hello" } as never),
		).rejects.toMatchObject({ reason: "binding_unavailable" });
		expect(backend.supports({ width: 512, height: 512 } as never)).toBe(false);
		// dispose is idempotent
		await expect(backend.dispose()).resolves.toBeUndefined();
	});

	it("returns decoded PNG bytes and metadata for a valid bridge result", async () => {
		const backend = await loadWith(fakeBridge());
		const result = await backend.generate({
			prompt: "a red cube",
			seed: 5,
			steps: 10,
			guidanceScale: 3.5,
		} as never);
		expect(result.mime).toBe("image/png");
		expect([...result.image]).toEqual([...PNG_SIGNATURE]);
		expect(result.seed).toBe(5); // explicit request seed flows through
		expect(result.metadata).toMatchObject({
			model: "imagegen-coreml-sd-1_5",
			steps: 10,
			guidanceScale: 3.5,
			inferenceTimeMs: 12,
		});
	});

	it("falls back to the resolved seed when the bridge omits it", async () => {
		const bridge = fakeBridge({
			generateImage: async () => ({
				png: VALID_PNG_B64,
				seed: undefined,
				inferenceTimeMs: 5,
			}),
		});
		const backend = await loadWith(bridge);
		const result = await backend.generate({ prompt: "x", seed: -1 } as never);
		expect(result.seed).toBe(7); // resolveSeed(-1) → deterministic stub pick
	});

	it("rejects an empty base64 payload", async () => {
		const backend = await loadWith(
			fakeBridge({
				generateImage: async () => ({ png: "", seed: 1, inferenceTimeMs: 1 }),
			}),
		);
		await expect(
			backend.generate({ prompt: "x" } as never),
		).rejects.toMatchObject({ reason: "unsupported_request" });
	});

	it("rejects a payload shorter than the PNG signature", async () => {
		const backend = await loadWith(
			fakeBridge({
				generateImage: async () => ({
					png: Buffer.from([0x89, 0x50]).toString("base64"),
					seed: 1,
					inferenceTimeMs: 1,
				}),
			}),
		);
		await expect(
			backend.generate({ prompt: "x" } as never),
		).rejects.toMatchObject({ reason: "unsupported_request" });
	});

	it("rejects a payload whose bytes are not the PNG signature", async () => {
		const backend = await loadWith(
			fakeBridge({
				generateImage: async () => ({
					png: Buffer.from("not-a-png-bytes").toString("base64"),
					seed: 1,
					inferenceTimeMs: 1,
				}),
			}),
		);
		await expect(
			backend.generate({ prompt: "x" } as never),
		).rejects.toMatchObject({ reason: "unsupported_request" });
	});

	it("falls back to wall-clock elapsed time when inferenceTimeMs is not positive", async () => {
		let calls = 0;
		const backend = await loadCoreMlImageGenBackend({
			loadArgs: {} as never,
			modelKey: "imagegen-coreml-sd-1_5",
			bridge: fakeBridge({
				generateImage: async () => ({
					png: VALID_PNG_B64,
					seed: 1,
					inferenceTimeMs: 0,
				}),
			}) as never,
			// First now() read is startMs; the second is the elapsed fallback.
			now: () => {
				calls += 1;
				return calls === 1 ? 1_000 : 1_250;
			},
		});
		const result = await backend.generate({ prompt: "x" } as never);
		expect(result.metadata.inferenceTimeMs).toBe(250);
	});
});
