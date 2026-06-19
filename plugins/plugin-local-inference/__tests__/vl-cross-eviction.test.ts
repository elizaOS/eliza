/**
 * WS2 vision cross-modality eviction invariants.
 *
 * Two-part invariant the arbiter must satisfy:
 *
 *   1. Text and vision-describe live in DIFFERENT resident-role slots
 *      (`text-target` vs `vision`). They coexist by design — loading
 *      vision does not evict text, and loading text does not evict
 *      vision. The audit prompt's "text↔vision cross-eviction" framing
 *      is incorrect for this arbiter: text+vision share GPU memory but
 *      have independent slots and pressure rules.
 *
 *   2. Vision-describe and image-gen share the SAME `vision` resident-
 *      role slot intentionally (memory-arbiter.ts CAPABILITY_ROLE map).
 *      They cross-evict on the same slot:
 *
 *        load vision → request image-gen → vision evicted, image-gen resident
 *        request vision again → image-gen evicted, vision reloaded
 *
 *      This is the actual "cross-modality" swap users see on a flagship
 *      phone trying to do screen analysis after a diffusion run.
 *
 * The existing `imagegen-vision-coexist.test.ts` covers one direction;
 * this file asserts the full round-trip and the text+vision coexistence
 * separately.
 */

import { describe, expect, it } from "vitest";
import {
	type CapabilityRegistration,
	MemoryArbiter,
} from "../src/services/memory-arbiter";
import {
	createImageGenCapabilityRegistration,
	type ImageGenBackend,
	type ImageGenRequest,
	type ImageGenResult,
} from "../src/services/imagegen";
import {
	createVisionCapabilityRegistration,
	type VisionDescribeBackend,
	type VisionDescribeRequest,
	type VisionDescribeResult,
} from "../src/services/vision";
import { VisionEmbeddingCache } from "../src/services/vision-embedding-cache";
import { SharedResourceRegistry } from "../src/services/voice/shared-resources";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const FAKE_PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
	0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
	0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
	0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
	0x60, 0x82,
]);

function tinyPngBytes(): Uint8Array {
	const base64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
	return Uint8Array.from(Buffer.from(base64, "base64"));
}

interface VisionCounters {
	loaded: number;
	disposed: number;
	described: number;
}

function makeVisionBackend(c: VisionCounters): VisionDescribeBackend {
	return {
		id: "fake",
		async describe(req) {
			c.described += 1;
			return {
				title: "x",
				description: `[vision] ${req.prompt ?? "image"}`,
				cacheHit: false,
			};
		},
		async dispose() {
			c.disposed += 1;
		},
	};
}

interface ImageGenCounters {
	loaded: number;
	disposed: number;
	generated: number;
}

function makeImageGenBackend(c: ImageGenCounters): ImageGenBackend {
	return {
		id: "fake",
		supports() {
			return true;
		},
		async generate(req): Promise<ImageGenResult> {
			c.generated += 1;
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
			c.disposed += 1;
		},
	};
}

interface TextCounters {
	loaded: string[];
	unloaded: string[];
}

function makeTextRegistration(
	c: TextCounters,
): CapabilityRegistration<{ id: string }, { x: string }, string> {
	return {
		capability: "text",
		residentRole: "text-target",
		estimatedMb: 1200,
		load: async (key) => {
			c.loaded.push(key);
			return { id: key };
		},
		unload: async (b) => {
			c.unloaded.push(b.id);
		},
		run: async (b, r) => `${b.id}:${r.x}`,
	};
}

function newArbiter(): MemoryArbiter {
	return new MemoryArbiter({
		registry: new SharedResourceRegistry(),
		visionCache: new VisionEmbeddingCache(),
	});
}

describe("WS2 cross-modality eviction — vision-describe ↔ image-gen (same `vision` slot)", () => {
	it("vision→image-gen→vision round-trip evicts the previous backend each swap", async () => {
		const arbiter = newArbiter();
		arbiter.start();

		const vis: VisionCounters = { loaded: 0, disposed: 0, described: 0 };
		const img: ImageGenCounters = { loaded: 0, disposed: 0, generated: 0 };

		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				arbiterCache: arbiter,
				loader: async () => {
					vis.loaded += 1;
					return makeVisionBackend(vis);
				},
			}),
		);
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				loader: async () => {
					img.loaded += 1;
					return makeImageGenBackend(img);
				},
			}),
		);

		// 1. Load vision first — it sits on the `vision` slot.
		await arbiter.requestVisionDescribe<
			VisionDescribeRequest,
			VisionDescribeResult
		>({
			modelKey: "qwen3-vl-2b",
			payload: {
				image: { kind: "bytes", bytes: tinyPngBytes() },
				prompt: "describe",
			},
		});
		expect(vis.loaded).toBe(1);
		expect(vis.disposed).toBe(0);
		expect(
			arbiter
				.residentSnapshot()
				.find((e) => e.residentRole === "vision")?.capability,
		).toBe("vision-describe");

		// 2. Request image-gen — same `vision` slot → vision evicted.
		const r = await arbiter.requestImageGen<ImageGenRequest, ImageGenResult>({
			modelKey: "imagegen-sd-1_5-q5_0",
			payload: { prompt: "a sunset", width: 64, height: 64, steps: 1 },
		});
		expect(r.mime).toBe("image/png");
		expect(vis.disposed).toBe(1);
		expect(img.loaded).toBe(1);
		expect(
			arbiter
				.residentSnapshot()
				.find((e) => e.residentRole === "vision")?.capability,
		).toBe("image-gen");

		// 3. Request vision again — same `vision` slot → image-gen evicted,
		//    vision reloaded fresh.
		await arbiter.requestVisionDescribe<
			VisionDescribeRequest,
			VisionDescribeResult
		>({
			modelKey: "qwen3-vl-2b",
			payload: {
				image: { kind: "bytes", bytes: tinyPngBytes() },
				prompt: "describe-again",
			},
		});
		expect(img.disposed).toBe(1);
		expect(vis.loaded).toBe(2);
		expect(
			arbiter
				.residentSnapshot()
				.find((e) => e.residentRole === "vision")?.capability,
		).toBe("vision-describe");

		await arbiter.shutdown();
	});

	it("vision keyed by different modelKey on the same slot still evicts and reloads", async () => {
		// 0_8b → 2b within the vision-describe capability is the on-device
		// scenario of a user switching tiers mid-session.
		const arbiter = newArbiter();
		arbiter.start();
		const vis: VisionCounters = { loaded: 0, disposed: 0, described: 0 };
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				arbiterCache: arbiter,
				loader: async () => {
					vis.loaded += 1;
					return makeVisionBackend(vis);
				},
			}),
		);

		await arbiter.requestVisionDescribe<
			VisionDescribeRequest,
			VisionDescribeResult
		>({
			modelKey: "qwen3-vl-0_8b",
			payload: { image: { kind: "bytes", bytes: tinyPngBytes() } },
		});
		await arbiter.requestVisionDescribe<
			VisionDescribeRequest,
			VisionDescribeResult
		>({
			modelKey: "qwen3-vl-2b",
			payload: { image: { kind: "bytes", bytes: tinyPngBytes() } },
		});

		expect(vis.loaded).toBe(2);
		expect(vis.disposed).toBe(1);
		expect(arbiter.residentSnapshot()).toHaveLength(1);
		expect(
			arbiter.residentSnapshot()[0].modelKey,
		).toBe("qwen3-vl-2b");

		await arbiter.shutdown();
	});
});

describe("WS2 text+vision coexistence — different resident-role slots", () => {
	it("loading vision-describe does NOT evict text (different roles coexist)", async () => {
		const arbiter = newArbiter();
		arbiter.start();
		const vis: VisionCounters = { loaded: 0, disposed: 0, described: 0 };
		const txt: TextCounters = { loaded: [], unloaded: [] };

		arbiter.registerCapability(makeTextRegistration(txt));
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				arbiterCache: arbiter,
				loader: async () => {
					vis.loaded += 1;
					return makeVisionBackend(vis);
				},
			}),
		);

		// Load text first.
		const tHandle = await arbiter.acquire("text", "eliza-1-2b");
		await tHandle.release();
		expect(txt.loaded).toEqual(["eliza-1-2b"]);
		expect(txt.unloaded).toEqual([]);

		// Now load vision — text MUST stay resident.
		await arbiter.requestVisionDescribe<
			VisionDescribeRequest,
			VisionDescribeResult
		>({
			modelKey: "qwen3-vl-2b",
			payload: { image: { kind: "bytes", bytes: tinyPngBytes() } },
		});
		expect(vis.loaded).toBe(1);
		expect(txt.unloaded).toEqual([]);

		// Snapshot must contain both roles.
		const roles = arbiter.residentSnapshot().map((e) => e.residentRole);
		expect(roles).toContain("text-target");
		expect(roles).toContain("vision");

		await arbiter.shutdown();
	});

	it("loading text does NOT evict an already-resident vision-describe", async () => {
		const arbiter = newArbiter();
		arbiter.start();
		const vis: VisionCounters = { loaded: 0, disposed: 0, described: 0 };
		const txt: TextCounters = { loaded: [], unloaded: [] };

		arbiter.registerCapability(makeTextRegistration(txt));
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				arbiterCache: arbiter,
				loader: async () => {
					vis.loaded += 1;
					return makeVisionBackend(vis);
				},
			}),
		);

		// Vision first.
		await arbiter.requestVisionDescribe<
			VisionDescribeRequest,
			VisionDescribeResult
		>({
			modelKey: "qwen3-vl-2b",
			payload: { image: { kind: "bytes", bytes: tinyPngBytes() } },
		});
		expect(vis.loaded).toBe(1);
		expect(vis.disposed).toBe(0);

		// Text after.
		const h = await arbiter.acquire("text", "eliza-1-2b");
		await h.release();
		expect(vis.disposed).toBe(0);
		expect(txt.loaded).toEqual(["eliza-1-2b"]);

		await arbiter.shutdown();
	});
});
