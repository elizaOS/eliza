/**
 * WS2 vision-describe tests.
 *
 * Coverage:
 *   - Capability registration through the WS1 MemoryArbiter (load,
 *     describe, dispose).
 *   - Cache miss path: first call invokes the backend's projector +
 *     decoder; `cacheHit === false` in the result.
 *   - Cache hit path: a synthetic cache pre-population makes the
 *     second call short-circuit to a backend that records whether it
 *     received `projectedTokens` in its options.
 *   - Hash determinism across encodings (bytes vs base64 vs data URL
 *     of the same payload should produce the same key).
 *   - Error propagation: a backend that throws on describe surfaces a
 *     real error through `arbiter.requestVisionDescribe`.
 *   - llama-server backend: a stubbed fetch returns the expected
 *     `/completion` payload shape.
 *
 * On-device GPU validation notes (not exercised here; no GPU on this host):
 *   - Metal:  load qwen3-vl-2b on M-series mac; the encode path goes
 *     through `mtmd_encode_chunks` and lands on the Metal compute
 *     encoder. Validate: a 1024×1024 frame describes in <1.5s end-to-end.
 *   - CUDA:   load qwen3-vl-9b on RTX 3090; same path through cuBLAS.
 *     Validate: a 1024×1024 frame describes in <0.8s end-to-end.
 *   - QNN:    on Snapdragon 8 Gen 3, validate that
 *     `eliza_llama_mtmd_describe` succeeds with the Q4_K_M 0.8B mmproj,
 *     and that text+vision co-resident memory stays under 3.5 GB.
 */

import { describe, expect, it, vi } from "vitest";
import {
	MemoryArbiter,
	type CapabilityRegistration,
} from "../src/services/memory-arbiter";
import { SharedResourceRegistry } from "../src/services/voice/shared-resources";
import { VisionEmbeddingCache } from "../src/services/vision-embedding-cache";
import {
	createVisionCapabilityRegistration,
	hashImageBytes,
	hashVisionInput,
	resolveImageBytes,
	createLlamaServerVisionBackend,
	type VisionDescribeBackend,
	type VisionDescribeRequest,
	type VisionDescribeResult,
} from "../src/services/vision";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tinyPngBytes(): Uint8Array {
	// 1×1 transparent PNG. Tiny + valid header; the WS2 backends don't
	// decode the payload themselves so we don't need a real image.
	const base64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
	return Uint8Array.from(Buffer.from(base64, "base64"));
}

interface FakeBackendState {
	loaded: string[];
	described: number;
	receivedProjected: boolean[];
	disposed: boolean[];
}

function makeFakeBackend(
	state: FakeBackendState,
	options: {
		failOn?: string;
		text?: string;
		expectedProjector?: boolean;
	} = {},
): VisionDescribeBackend {
	return {
		id: "fake",
		async describe(req, args) {
			state.described += 1;
			state.receivedProjected.push(Boolean(args?.projectedTokens));
			if (options.failOn && req.prompt === options.failOn) {
				throw new Error(`fake backend failure for prompt=${req.prompt}`);
			}
			const text = options.text ?? `described ${req.prompt ?? "image"}`;
			return {
				title: text.split(/[.!?]/, 1)[0]?.trim() || "Image",
				description: text,
				projectorMs: 10,
				decodeMs: 20,
				cacheHit: Boolean(args?.projectedTokens),
			};
		},
		async dispose() {
			state.disposed.push("fake");
		},
	};
}

function newArbiter(): MemoryArbiter {
	return new MemoryArbiter({
		registry: new SharedResourceRegistry(),
		visionCache: new VisionEmbeddingCache(),
	});
}

// ---------------------------------------------------------------------------
// hashImageBytes / resolveImageBytes — input normalization
// ---------------------------------------------------------------------------

describe("vision/hash", () => {
	it("hashes the same bytes deterministically", () => {
		const bytes = tinyPngBytes();
		const a = hashImageBytes(bytes, "qwen3-vl");
		const b = hashImageBytes(bytes, "qwen3-vl");
		expect(a).toBe(b);
	});

	it("namespaces by model family", () => {
		const bytes = tinyPngBytes();
		const a = hashImageBytes(bytes, "qwen3-vl");
		const b = hashImageBytes(bytes, "florence-2");
		expect(a).not.toBe(b);
	});

	it("produces the same key for bytes / base64 / dataUrl of the same payload", () => {
		const bytes = tinyPngBytes();
		const base64 = Buffer.from(bytes).toString("base64");
		const dataUrl = `data:image/png;base64,${base64}`;
		const fromBytes = hashVisionInput({ kind: "bytes", bytes }, "qwen3-vl");
		const fromBase64 = hashVisionInput(
			{ kind: "base64", base64 },
			"qwen3-vl",
		);
		const fromDataUrl = hashVisionInput(
			{ kind: "dataUrl", dataUrl },
			"qwen3-vl",
		);
		expect(fromBase64).toBe(fromBytes);
		expect(fromDataUrl).toBe(fromBytes);
	});

	it("throws on url inputs (caller must fetch)", () => {
		expect(() =>
			hashVisionInput({ kind: "url", url: "https://example.com/x.png" }),
		).toThrow(/url inputs must be fetched/);
	});

	it("resolveImageBytes accepts a data URL with no ;base64 token (utf8 fallback)", () => {
		const dataUrl = "data:text/plain,hello";
		const { bytes, mimeType } = resolveImageBytes({ kind: "dataUrl", dataUrl });
		expect(Buffer.from(bytes).toString("utf8")).toBe("hello");
		expect(mimeType).toBe("text/plain");
	});
});

// ---------------------------------------------------------------------------
// createVisionCapabilityRegistration — happy path
// ---------------------------------------------------------------------------

describe("vision/capability registration", () => {
	it("registers and dispatches describe requests through the arbiter", async () => {
		const state: FakeBackendState = {
			loaded: [],
			described: 0,
			receivedProjected: [],
			disposed: [],
		};
		const arbiter = newArbiter();
		const registration = createVisionCapabilityRegistration({
			arbiterCache: arbiter,
			loader: async (modelKey) => {
				state.loaded.push(modelKey);
				return makeFakeBackend(state);
			},
		});
		arbiter.registerCapability(
			registration as unknown as CapabilityRegistration<
				unknown,
				unknown,
				unknown
			>,
		);
		const result = await arbiter.requestVisionDescribe<
			VisionDescribeRequest,
			VisionDescribeResult
		>({
			modelKey: "qwen3-vl",
			payload: {
				image: { kind: "bytes", bytes: tinyPngBytes() },
				prompt: "what",
			},
		});
		expect(state.loaded).toEqual(["qwen3-vl"]);
		expect(state.described).toBe(1);
		expect(state.receivedProjected[0]).toBe(false);
		expect(result.description).toBe("described what");
		expect(result.cacheHit).toBe(false);
	});

	it("short-circuits the projector on a cache hit", async () => {
		const state: FakeBackendState = {
			loaded: [],
			described: 0,
			receivedProjected: [],
			disposed: [],
		};
		const arbiter = newArbiter();
		const bytes = tinyPngBytes();
		// Synthesize a pre-projected token tensor and stash it under the
		// hash the wrapper will compute. The backend's `describe` should
		// receive `projectedTokens` in its options on the next call.
		const hash = hashImageBytes(bytes, "qwen3-vl");
		arbiter.setCachedVisionEmbedding(hash, {
			tokens: new Float32Array(8),
			tokenCount: 4,
			hiddenSize: 2,
		});
		const registration = createVisionCapabilityRegistration({
			arbiterCache: arbiter,
			loader: async () => makeFakeBackend(state),
		});
		arbiter.registerCapability(
			registration as unknown as CapabilityRegistration<
				unknown,
				unknown,
				unknown
			>,
		);
		const result = await arbiter.requestVisionDescribe<
			VisionDescribeRequest,
			VisionDescribeResult
		>({
			modelKey: "qwen3-vl",
			payload: {
				image: { kind: "bytes", bytes },
				prompt: "what",
			},
		});
		expect(state.receivedProjected[0]).toBe(true);
		expect(result.cacheHit).toBe(true);
	});

	it("propagates backend errors back through the arbiter", async () => {
		const state: FakeBackendState = {
			loaded: [],
			described: 0,
			receivedProjected: [],
			disposed: [],
		};
		const arbiter = newArbiter();
		const registration = createVisionCapabilityRegistration({
			arbiterCache: arbiter,
			loader: async () => makeFakeBackend(state, { failOn: "boom" }),
		});
		arbiter.registerCapability(
			registration as unknown as CapabilityRegistration<
				unknown,
				unknown,
				unknown
			>,
		);
		await expect(
			arbiter.requestVisionDescribe<VisionDescribeRequest, VisionDescribeResult>({
				modelKey: "qwen3-vl",
				payload: {
					image: { kind: "bytes", bytes: tinyPngBytes() },
					prompt: "boom",
				},
			}),
		).rejects.toThrow(/fake backend failure/);
	});

	it("unloads the backend on shutdown", async () => {
		const state: FakeBackendState = {
			loaded: [],
			described: 0,
			receivedProjected: [],
			disposed: [],
		};
		const arbiter = newArbiter();
		const registration = createVisionCapabilityRegistration({
			arbiterCache: arbiter,
			loader: async () => makeFakeBackend(state),
		});
		arbiter.registerCapability(
			registration as unknown as CapabilityRegistration<
				unknown,
				unknown,
				unknown
			>,
		);
		await arbiter.requestVisionDescribe<VisionDescribeRequest, VisionDescribeResult>({
			modelKey: "qwen3-vl",
			payload: {
				image: { kind: "bytes", bytes: tinyPngBytes() },
			},
		});
		await arbiter.shutdown();
		expect(state.disposed).toContain("fake");
	});

	it("end-to-end: second call against same input hits the synthesized cache", async () => {
		// Smoke test of the WS1 → WS2 contract: the test simulates a
		// computer-use frame loop where the same screenshot arrives twice.
		// First call populates the cache by hand (we don't have a real
		// projector to extract tokens from, so we pretend the backend
		// stashed them). Second call must see `cacheHit: true`.
		const state: FakeBackendState = {
			loaded: [],
			described: 0,
			receivedProjected: [],
			disposed: [],
		};
		const arbiter = newArbiter();
		const bytes = tinyPngBytes();
		const registration = createVisionCapabilityRegistration({
			arbiterCache: arbiter,
			loader: async () => makeFakeBackend(state),
		});
		arbiter.registerCapability(
			registration as unknown as CapabilityRegistration<
				unknown,
				unknown,
				unknown
			>,
		);

		// First call — no cache.
		const r1 = await arbiter.requestVisionDescribe<
			VisionDescribeRequest,
			VisionDescribeResult
		>({
			modelKey: "qwen3-vl",
			payload: { image: { kind: "bytes", bytes }, prompt: "frame" },
		});
		expect(r1.cacheHit).toBe(false);

		// Simulate the projector stashing tokens. In production this
		// happens inside the backend (after the real mtmd encode); the
		// test simulates it because we have no real projector.
		const hash = hashImageBytes(bytes, "qwen3-vl");
		arbiter.setCachedVisionEmbedding(hash, {
			tokens: new Float32Array(8),
			tokenCount: 4,
			hiddenSize: 2,
		});

		// Second call — cache hit.
		const r2 = await arbiter.requestVisionDescribe<
			VisionDescribeRequest,
			VisionDescribeResult
		>({
			modelKey: "qwen3-vl",
			payload: { image: { kind: "bytes", bytes }, prompt: "frame" },
		});
		expect(r2.cacheHit).toBe(true);
		expect(state.receivedProjected).toEqual([false, true]);
	});
});

// ---------------------------------------------------------------------------
// llama-server backend — stubbed fetch
// ---------------------------------------------------------------------------

describe("vision/llama-server backend", () => {
	it("posts /completion with image_data and returns shaped result", async () => {
		const fakeFetch = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						content: "A small image of nothing in particular.",
						timings: { prompt_ms: 12, predicted_ms: 30 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://127.0.0.1:18000",
			fetch: fakeFetch as unknown as typeof fetch,
		});
		const result = await backend.describe({
			image: { kind: "bytes", bytes: tinyPngBytes() },
			prompt: "describe please",
		});
		expect(fakeFetch).toHaveBeenCalledOnce();
		const [url, init] = fakeFetch.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:18000/completion");
		const body = JSON.parse(String((init as RequestInit).body));
		expect(body.image_data).toHaveLength(1);
		expect(body.image_data[0].id).toBe(12);
		expect(typeof body.image_data[0].data).toBe("string");
		expect(body.cache_prompt).toBe(false);
		expect(result.description).toMatch(/small image/);
		expect(result.projectorMs).toBe(12);
		expect(result.decodeMs).toBe(30);
	});

	it("throws on non-OK response", async () => {
		const fakeFetch = vi
			.fn()
			.mockResolvedValue(
				new Response("bad request body", { status: 400 }),
			);
		const backend = createLlamaServerVisionBackend({
			baseUrl: "http://127.0.0.1:18000",
			fetch: fakeFetch as unknown as typeof fetch,
		});
		await expect(
			backend.describe({
				image: { kind: "bytes", bytes: tinyPngBytes() },
			}),
		).rejects.toThrow(/returned 400/);
	});

	it("rejects an empty baseUrl at construction", () => {
		expect(() =>
			createLlamaServerVisionBackend({ baseUrl: "" }),
		).toThrow(/baseUrl is required/);
	});
});
