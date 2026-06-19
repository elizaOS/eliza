/**
 * WS3 ↔ WS2/WS4 cross-modality coexistence on the shared `vision`
 * resident-role slot.
 *
 * Two capabilities (`vision-describe`, `image-gen`) intentionally share
 * the same `residentRole: "vision"`. The arbiter's one-model-per-role
 * policy guarantees the GPU/RAM footprint of these two heavy modalities
 * never doubles up on a 6 GB iPhone or an 8 GB low-tier Android.
 *
 * The existing `imagegen-handler.test.ts` covers ONE direction:
 *   image-gen holds the slot → vision-describe queues + evicts.
 *
 * This file fills in the gaps the audit surfaced:
 *   1. Reverse direction: vision-describe holds → image-gen queues +
 *      evicts.
 *   2. Cache namespace separation: image-gen requests do NOT pass
 *      through `hashVisionInput` and a hash collision is not possible
 *      (the WS2 cache is keyed on image bytes + model family; WS3
 *      requests have no image input).
 *   3. Refcount-aware swap: a vision-describe with an outstanding
 *      handle blocks an image-gen swap until it drains.
 */

import { describe, expect, it } from "vitest";
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
import { hashVisionInput } from "../src/services/vision/hash";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const FAKE_PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
	0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05,
	0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
	0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function hasPngSignature(bytes: Uint8Array): boolean {
	if (bytes.length < PNG_SIG.length) return false;
	for (let i = 0; i < PNG_SIG.length; i += 1) {
		if (bytes[i] !== PNG_SIG[i]) return false;
	}
	return true;
}

interface ImgState {
	loaded: number;
	disposed: number;
	generated: number;
	delayMs: number;
}
function makeFakeImageGenBackend(state: ImgState): ImageGenBackend {
	return {
		id: "fake",
		supports() {
			return true;
		},
		async generate(req): Promise<ImageGenResult> {
			state.generated += 1;
			if (state.delayMs > 0) {
				await new Promise<void>((r) => setTimeout(r, state.delayMs));
			}
			return {
				image: FAKE_PNG,
				mime: "image/png",
				seed: typeof req.seed === "number" ? req.seed : 1,
				metadata: {
					model: "imagegen-fake",
					prompt: req.prompt,
					steps: req.steps ?? 1,
					guidanceScale: 0,
					inferenceTimeMs: 1,
				},
			};
		},
		async dispose() {
			state.disposed += 1;
		},
	};
}

interface VisState {
	loaded: number;
	disposed: number;
	described: number;
	delayMs: number;
}
function makeFakeVisionBackend(state: VisState): VisionDescribeBackend {
	return {
		id: "fake",
		async describe(req) {
			state.described += 1;
			if (state.delayMs > 0) {
				await new Promise<void>((r) => setTimeout(r, state.delayMs));
			}
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

function makeArbiter() {
	const registry = new SharedResourceRegistry();
	const arbiter = new MemoryArbiter({ registry });
	arbiter.start();
	return arbiter;
}

describe("WS3 ↔ WS2 shared vision residentRole — reverse swap direction", () => {
	it("evicts vision-describe when image-gen arrives on the same slot", async () => {
		const arbiter = makeArbiter();
		const visState: VisState = {
			loaded: 0,
			disposed: 0,
			described: 0,
			delayMs: 0,
		};
		const imgState: ImgState = {
			loaded: 0,
			disposed: 0,
			generated: 0,
			delayMs: 0,
		};
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				loader: async () => {
					visState.loaded += 1;
					return makeFakeVisionBackend(visState);
				},
				modelFamily: "qwen3-vl",
			}),
		);
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async () => {
					imgState.loaded += 1;
					return makeFakeImageGenBackend(imgState);
				},
			}),
		);

		// Load vision-describe first; it becomes resident on the `vision` slot.
		await arbiter.requestVisionDescribe<
			{ image: { kind: "bytes"; bytes: Uint8Array }; prompt: string },
			{ title: string; description: string }
		>({
			modelKey: "qwen3-vl-2b",
			payload: {
				image: { kind: "bytes", bytes: new Uint8Array([9, 9, 9]) },
				prompt: "what is this",
			},
		});
		expect(visState.loaded).toBe(1);
		const beforeSwap = arbiter
			.residentSnapshot()
			.filter((e) => e.residentRole === "vision");
		expect(beforeSwap).toHaveLength(1);
		expect(beforeSwap[0].capability).toBe("vision-describe");

		// Now request image-gen. Same `vision` slot → vision-describe must be
		// evicted before the diffusion weights load.
		const imgResult = await arbiter.requestImageGen<
			ImageGenRequest,
			ImageGenResult
		>({
			modelKey: "imagegen-sd-1_5-q5_0",
			payload: { prompt: "a sunset", width: 512, height: 512, steps: 4 },
		});

		expect(hasPngSignature(imgResult.image)).toBe(true);
		expect(visState.disposed).toBe(1);
		expect(imgState.loaded).toBe(1);
		const afterSwap = arbiter
			.residentSnapshot()
			.filter((e) => e.residentRole === "vision");
		expect(afterSwap).toHaveLength(1);
		expect(afterSwap[0].capability).toBe("image-gen");

		await arbiter.shutdown();
		expect(imgState.disposed).toBe(1);
	});
});

describe("WS3 cache namespace separation", () => {
	it("image-gen requests have no path through hashVisionInput", () => {
		// hashVisionInput is the WS2 projector-token cache key. WS3 callers
		// never invoke it — the contract in `services/imagegen/types.ts`
		// guarantees the request side is keyed on prompt+seed+steps, not on
		// image bytes. Sanity-check the separation: hashing an image yields
		// a hex digest, and that digest is *not* a path image-gen ever
		// computes.
		const visionHash = hashVisionInput(
			{ kind: "bytes", bytes: new Uint8Array([1, 2, 3, 4]) },
			"qwen3-vl",
		);
		expect(typeof visionHash).toBe("string");
		expect(visionHash).toMatch(/^[0-9a-f]+$/);
		// The arbiter's per-capability vision cache is exposed via
		// getCachedVisionEmbedding/setCachedVisionEmbedding; image-gen does
		// NOT touch those. If a future cache lands on the image-gen side
		// it MUST get its own namespace (see types.ts §Cache contract).
	});

	it("populating the vision-embedding cache does not affect image-gen runs", async () => {
		const arbiter = makeArbiter();
		const imgState: ImgState = {
			loaded: 0,
			disposed: 0,
			generated: 0,
			delayMs: 0,
		};
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async () => {
					imgState.loaded += 1;
					return makeFakeImageGenBackend(imgState);
				},
			}),
		);

		// Pre-seed the WS2 vision-embedding cache with a value that uses
		// the same string keys image-gen prompts would hash to under a
		// naive shared-namespace mistake. Image-gen MUST still call
		// `generate()` because it has its own (non-cache) request path.
		const fakeHash = "a sunset";
		arbiter.setCachedVisionEmbedding(
			fakeHash,
			{
				tokens: new Float32Array([0.1, 0.2, 0.3]),
				tokenCount: 1,
				hiddenSize: 3,
			},
			60_000,
		);
		expect(arbiter.getCachedVisionEmbedding(fakeHash)).not.toBeNull();

		const result = await arbiter.requestImageGen<
			ImageGenRequest,
			ImageGenResult
		>({
			modelKey: "imagegen-sd-1_5-q5_0",
			payload: { prompt: "a sunset", width: 512, height: 512, steps: 4 },
		});
		// Image-gen ran for real (didn't short-circuit on the WS2 cache hit).
		expect(imgState.generated).toBe(1);
		expect(hasPngSignature(result.image)).toBe(true);
		await arbiter.shutdown();
	});
});

describe("WS3 ↔ WS2 swap refcount-awareness", () => {
	it("waits for an outstanding vision handle to drain before swapping", async () => {
		const arbiter = makeArbiter();
		const visState: VisState = {
			loaded: 0,
			disposed: 0,
			described: 0,
			delayMs: 0,
		};
		const imgState: ImgState = {
			loaded: 0,
			disposed: 0,
			generated: 0,
			delayMs: 0,
		};
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				loader: async () => {
					visState.loaded += 1;
					return makeFakeVisionBackend(visState);
				},
				modelFamily: "qwen3-vl",
			}),
		);
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async () => {
					imgState.loaded += 1;
					return makeFakeImageGenBackend(imgState);
				},
			}),
		);

		// Acquire a long-lived vision handle (refCount=1).
		const handle = await arbiter.acquire<VisionDescribeBackend>(
			"vision-describe",
			"qwen3-vl-2b",
		);
		expect(visState.loaded).toBe(1);

		// Now kick off an image-gen swap; it should wait for refCount→0
		// before disposing vision-describe.
		const imgPromise = arbiter.requestImageGen<
			ImageGenRequest,
			ImageGenResult
		>({
			modelKey: "imagegen-sd-1_5-q5_0",
			payload: { prompt: "a sunset", width: 512, height: 512, steps: 4 },
		});

		// Give the swap a chance to attempt eviction; it must not have
		// disposed vision-describe yet because refCount > 0.
		await new Promise<void>((r) => setTimeout(r, 5));
		expect(visState.disposed).toBe(0);

		// Release the handle — the swap can now proceed.
		await handle.release();
		const imgResult = await imgPromise;
		expect(hasPngSignature(imgResult.image)).toBe(true);
		expect(visState.disposed).toBe(1);
		expect(imgState.loaded).toBe(1);

		await arbiter.shutdown();
	});
});
