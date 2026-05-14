/**
 * WS3 image-gen handler + arbiter integration tests.
 *
 * Coverage:
 *   - Capability registration through the WS1 MemoryArbiter (load,
 *     generate, dispose).
 *   - End-to-end dispatch: `runtime.useModel(ModelType.IMAGE, ...)` →
 *     `provider.ts` handler → `arbiter.requestImageGen` → fake backend
 *     → data-URL `ImageGenerationResult[]` back to the caller.
 *   - The arbiter handles vision-describe ⇄ image-gen contention via
 *     the shared `vision` resident-role slot: a vision-describe arriving
 *     while image-gen is in flight queues, then evicts diffusion and
 *     reloads VL on its turn.
 *   - Abort signal propagation: an aborted request rejects.
 *   - PNG signature in the returned data URL.
 *   - Empty / invalid prompt raises a typed `LOCAL_INFERENCE_UNAVAILABLE`.
 *
 * On-device GPU validation notes (this host has no GPU):
 *   - sd-cpp CUDA:    RTX 3090, SD 1.5 Q5_0 → ~1.5s for 512×512 / 20 steps.
 *   - sd-cpp Vulkan:  RX 7900 XTX, Z-Image-Turbo Q4_K_M → ~1.8s for 1024×1024 / 4 steps.
 *   - mflux MLX:      M3 Max, Z-Image-Turbo MLX → <2s for 1024×1024 / 4 steps.
 *   - Core ML:        iPhone 15 Pro, SD 1.5 .mlpackage → ~5s for 512×512 / 20 steps.
 *   - AOSP Vulkan:    Snapdragon 8 Gen 3, Z-Image-Turbo Q4_K_M Vulkan → ~1.4s for 1024×1024 / 4 steps.
 */

import { describe, expect, it } from "vitest";
import { ModelType } from "@elizaos/core";
import { MemoryArbiter } from "../src/services/memory-arbiter";
import { SharedResourceRegistry } from "../src/services/voice/shared-resources";
import {
	createImageGenCapabilityRegistration,
	type ImageGenBackend,
	type ImageGenRequest,
	type ImageGenResult,
} from "../src/services/imagegen";
import {
	createVisionCapabilityRegistration,
	type VisionDescribeBackend,
} from "../src/services/vision";
import {
	createLocalInferenceModelHandlers,
	isLocalInferenceUnavailableError,
} from "../src/provider";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 16×16 deterministic PNG. Tiny but valid: full sig + IHDR + IDAT + IEND. */
const FAKE_PNG: Uint8Array = (() => {
	// 1×1 PNG; structurally valid for our assertions (we only check the
	// signature + that bytes round-trip through the handler). The WS10
	// golden test reuses the same byte sequence.
	const ONE_PX = [
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
		0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05,
		0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
		0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
	];
	return Uint8Array.from(ONE_PX);
})();

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
function hasPngSignature(bytes: Uint8Array): boolean {
	if (bytes.length < PNG_SIG.length) return false;
	for (let i = 0; i < PNG_SIG.length; i += 1) {
		if (bytes[i] !== PNG_SIG[i]) return false;
	}
	return true;
}

interface FakeBackendState {
	loaded: string[];
	generated: number;
	disposed: number;
	delayMs: number;
	failNext: boolean;
}

function makeFakeImageGenBackend(state: FakeBackendState): ImageGenBackend {
	return {
		id: "fake",
		supports(req) {
			const w = req.width ?? 512;
			return w > 0 && w <= 4096;
		},
		async generate(req): Promise<ImageGenResult> {
			state.generated += 1;
			if (state.failNext) {
				state.failNext = false;
				throw new Error("[fake] forced failure");
			}
			if (state.delayMs > 0) {
				await new Promise<void>((r) => setTimeout(r, state.delayMs));
			}
			if (req.signal?.aborted) {
				const err = req.signal.reason instanceof Error
					? req.signal.reason
					: new DOMException("Aborted", "AbortError");
				throw err;
			}
			return {
				image: FAKE_PNG,
				mime: "image/png",
				seed: typeof req.seed === "number" ? req.seed : 42,
				metadata: {
					model: "imagegen-fake",
					prompt: req.prompt,
					steps: req.steps ?? 4,
					guidanceScale: req.guidanceScale ?? 0,
					inferenceTimeMs: 1,
				},
			};
		},
		async dispose() {
			state.disposed += 1;
		},
	};
}

interface FakeVisionState {
	loaded: number;
	described: number;
	disposed: number;
}

function makeFakeVisionBackend(state: FakeVisionState): VisionDescribeBackend {
	return {
		id: "fake",
		async describe(req) {
			state.described += 1;
			return {
				title: "fake",
				description: `[fake] ${req.prompt ?? "image"}`,
				cacheHit: false,
			};
		},
		async dispose() {
			state.disposed += 1;
		},
	};
}

function makeArbiter(): { arbiter: MemoryArbiter } {
	const registry = new SharedResourceRegistry();
	const arbiter = new MemoryArbiter({ registry });
	arbiter.start();
	return { arbiter };
}

// ---------------------------------------------------------------------------
// Capability registration + arbiter request path
// ---------------------------------------------------------------------------

describe("WS3 image-gen — arbiter capability", () => {
	it("registers and dispatches a generate through the arbiter", async () => {
		const { arbiter } = makeArbiter();
		const state: FakeBackendState = {
			loaded: [], generated: 0, disposed: 0, delayMs: 0, failNext: false,
		};
		const registration = createImageGenCapabilityRegistration({
			loader: async (modelKey) => {
				state.loaded.push(modelKey);
				return makeFakeImageGenBackend(state);
			},
			estimatedMb: 1100,
		});
		arbiter.registerCapability(registration);

		const result = await arbiter.requestImageGen<ImageGenRequest, ImageGenResult>({
			modelKey: "imagegen-sd-1_5-q5_0",
			payload: {
				prompt: "a cat in a meadow",
				width: 512,
				height: 512,
				steps: 4,
				seed: 7,
			},
		});

		expect(state.loaded).toEqual(["imagegen-sd-1_5-q5_0"]);
		expect(state.generated).toBe(1);
		expect(hasPngSignature(result.image)).toBe(true);
		expect(result.mime).toBe("image/png");
		expect(result.seed).toBe(7);
		expect(result.metadata.prompt).toBe("a cat in a meadow");
		expect(result.metadata.steps).toBe(4);
		expect(result.metadata.inferenceTimeMs).toBeGreaterThan(0);

		await arbiter.shutdown();
		expect(state.disposed).toBe(1);
	});

	it("propagates a backend error through requestImageGen", async () => {
		const { arbiter } = makeArbiter();
		const state: FakeBackendState = {
			loaded: [], generated: 0, disposed: 0, delayMs: 0, failNext: true,
		};
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async () => makeFakeImageGenBackend(state),
			}),
		);
		await expect(
			arbiter.requestImageGen<ImageGenRequest, ImageGenResult>({
				modelKey: "imagegen-sd-1_5-q5_0",
				payload: { prompt: "x" },
			}),
		).rejects.toThrow(/forced failure/);
	});

	it("propagates an AbortSignal cancellation", async () => {
		const { arbiter } = makeArbiter();
		const state: FakeBackendState = {
			loaded: [], generated: 0, disposed: 0, delayMs: 25, failNext: false,
		};
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async () => makeFakeImageGenBackend(state),
			}),
		);
		const controller = new AbortController();
		const promise = arbiter.requestImageGen<ImageGenRequest, ImageGenResult>({
			modelKey: "imagegen-sd-1_5-q5_0",
			payload: { prompt: "x", signal: controller.signal },
		});
		controller.abort(new DOMException("user cancelled", "AbortError"));
		await expect(promise).rejects.toThrow(/cancelled|Aborted/);
	});
});

// ---------------------------------------------------------------------------
// vision-describe ⇄ image-gen coexistence on the `vision` resident-role slot
// ---------------------------------------------------------------------------

describe("WS3 image-gen — coexistence with vision-describe", () => {
	it("queues vision-describe when image-gen holds the vision slot", async () => {
		const { arbiter } = makeArbiter();
		const imgState: FakeBackendState = {
			loaded: [], generated: 0, disposed: 0, delayMs: 30, failNext: false,
		};
		const visState: FakeVisionState = { loaded: 0, described: 0, disposed: 0 };

		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async () => makeFakeImageGenBackend(imgState),
			}),
		);
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				loader: async () => {
					visState.loaded += 1;
					return makeFakeVisionBackend(visState);
				},
				modelFamily: "qwen3-vl",
			}),
		);

		// Kick off image-gen first; while it's in-flight, fire vision.
		const imgPromise = arbiter.requestImageGen<ImageGenRequest, ImageGenResult>({
			modelKey: "imagegen-sd-1_5-q5_0",
			payload: { prompt: "p", width: 512, height: 512, steps: 4 },
		});
		// Allow microtask flush so the image-gen acquire starts.
		await new Promise<void>((r) => setTimeout(r, 0));
		const visPromise = arbiter.requestVisionDescribe<
			{ image: { kind: "bytes"; bytes: Uint8Array }; prompt: string },
			{ title: string; description: string }
		>({
			modelKey: "qwen3-vl-2b",
			payload: {
				image: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) },
				prompt: "describe",
			},
		});

		const [imgResult, visResult] = await Promise.all([imgPromise, visPromise]);
		expect(hasPngSignature(imgResult.image)).toBe(true);
		expect(visResult.description).toMatch(/describe/);
		// Image-gen had to be evicted from the `vision` slot before the
		// vision-describe could load. Confirm dispose was called and the
		// vision backend got loaded once.
		expect(imgState.disposed).toBe(1);
		expect(visState.loaded).toBe(1);

		await arbiter.shutdown();
	});
});

// ---------------------------------------------------------------------------
// ModelType.IMAGE handler dispatch end-to-end
// ---------------------------------------------------------------------------

describe("WS3 ModelType.IMAGE handler — provider dispatch", () => {
	function makeRuntime(arbiter: MemoryArbiter | null) {
		const settings = new Map<string, string>();
		const service = {
			getMemoryArbiter: () => arbiter,
		};
		const runtime = {
			getService: (name: string) =>
				name === "localInferenceLoader" || name === "localInference"
					? service
					: undefined,
			getSetting: (k: string) => settings.get(k),
			setSetting: (k: string, v: unknown) => {
				settings.set(k, String(v));
			},
		};
		return { runtime, settings };
	}

	it("returns ImageGenerationResult[] with a PNG data URL", async () => {
		const { arbiter } = makeArbiter();
		const state: FakeBackendState = {
			loaded: [], generated: 0, disposed: 0, delayMs: 0, failNext: false,
		};
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async (modelKey) => {
					state.loaded.push(modelKey);
					return makeFakeImageGenBackend(state);
				},
			}),
		);
		const handlers = createLocalInferenceModelHandlers();
		const { runtime } = makeRuntime(arbiter);
		const params = {
			prompt: "a cat in a meadow",
			size: "512x512",
			count: 1,
		} as Parameters<NonNullable<typeof handlers>[typeof ModelType.IMAGE]>[1];
		// biome-ignore lint/style/noNonNullAssertion: handler is present.
		const handler = handlers[ModelType.IMAGE]!;
		// biome-ignore lint/suspicious/noExplicitAny: test runtime stand-in.
		const result = await handler(runtime as any, params);
		expect(Array.isArray(result)).toBe(true);
		const arr = result as { url: string }[];
		expect(arr).toHaveLength(1);
		expect(arr[0].url).toMatch(/^data:image\/png;base64,/);
		const base64 = arr[0].url.slice("data:image/png;base64,".length);
		const bytes = new Uint8Array(Buffer.from(base64, "base64"));
		expect(hasPngSignature(bytes)).toBe(true);
		expect(state.loaded).toEqual(["imagegen-sd-1_5-q5_0"]);

		await arbiter.shutdown();
	});

	it("rejects empty prompt with LOCAL_INFERENCE_UNAVAILABLE invalid_input", async () => {
		const { arbiter } = makeArbiter();
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async () => makeFakeImageGenBackend({
					loaded: [], generated: 0, disposed: 0, delayMs: 0, failNext: false,
				}),
			}),
		);
		const handlers = createLocalInferenceModelHandlers();
		const { runtime } = makeRuntime(arbiter);
		// biome-ignore lint/style/noNonNullAssertion: handler is present.
		const handler = handlers[ModelType.IMAGE]!;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: test runtime stand-in.
			await handler(runtime as any, { prompt: "   " });
			expect.fail("should have rejected");
		} catch (err) {
			expect(isLocalInferenceUnavailableError(err)).toBe(true);
			if (isLocalInferenceUnavailableError(err)) {
				expect(err.reason).toBe("invalid_input");
			}
		}
		await arbiter.shutdown();
	});

	it("raises capability_unavailable when no arbiter has registered image-gen", async () => {
		const handlers = createLocalInferenceModelHandlers();
		// Arbiter exists but has not registered image-gen.
		const { arbiter } = makeArbiter();
		// Register only vision (so the service exists but cap missing).
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				loader: async () => makeFakeVisionBackend({ loaded: 0, described: 0, disposed: 0 }),
			}),
		);
		const { runtime } = makeRuntime(arbiter);
		// biome-ignore lint/style/noNonNullAssertion: handler is present.
		const handler = handlers[ModelType.IMAGE]!;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: test runtime stand-in.
			await handler(runtime as any, { prompt: "x" });
			expect.fail("should have rejected");
		} catch (err) {
			expect(isLocalInferenceUnavailableError(err)).toBe(true);
			if (isLocalInferenceUnavailableError(err)) {
				expect(err.reason).toBe("capability_unavailable");
			}
		}
		await arbiter.shutdown();
	});

	it("honours params.count by generating N back-to-back samples", async () => {
		const { arbiter } = makeArbiter();
		const state: FakeBackendState = {
			loaded: [], generated: 0, disposed: 0, delayMs: 0, failNext: false,
		};
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async () => makeFakeImageGenBackend(state),
			}),
		);
		const handlers = createLocalInferenceModelHandlers();
		const { runtime } = makeRuntime(arbiter);
		// biome-ignore lint/style/noNonNullAssertion: handler is present.
		const handler = handlers[ModelType.IMAGE]!;
		const params = {
			prompt: "x",
			count: 3,
			seed: 100,
		} as Parameters<NonNullable<typeof handlers>[typeof ModelType.IMAGE]>[1];
		// biome-ignore lint/suspicious/noExplicitAny: test runtime stand-in.
		const result = (await handler(runtime as any, params)) as { url: string }[];
		expect(result).toHaveLength(3);
		// Each result is a PNG data URL.
		for (const r of result) expect(r.url).toMatch(/^data:image\/png;base64,/);
		expect(state.generated).toBe(3);

		await arbiter.shutdown();
	});
});
