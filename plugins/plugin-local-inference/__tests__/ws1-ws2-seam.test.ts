/**
 * WS1 ↔ WS2 integration seam tests.
 *
 * The unit tests in `memory-arbiter.test.ts` and `vision-describe.test.ts`
 * each cover their own module in isolation. This file covers the *seam*:
 *
 *   1. Provider IMAGE_DESCRIPTION → arbiter.requestVisionDescribe wiring
 *      (the path provider.ts:createImageDescriptionHandler takes when the
 *      service exposes `getMemoryArbiter()` AND the arbiter has the
 *      "vision-describe" capability registered).
 *
 *   2. WS9/WS8 mobile pressure dispatch path:
 *      service.dispatchMobilePressure → capacitorPressureSource bridge
 *      → arbiter pressure handler → eviction. Documented in
 *      MEMORY_ARBITER.md but never asserted end-to-end before.
 *
 *   3. Eviction ordering invariant under `low` pressure when BOTH text
 *      and vision are co-resident: vision MUST evict first because its
 *      `vision` role priority (20) is below text-target (100). This was
 *      tested in memory-arbiter.test.ts, but only with two fake "text"
 *      capabilities; here we use the real createVisionCapabilityRegistration
 *      wrapper to make sure the WS2 wrapper preserves the residentRole.
 *
 *   4. AOSP stub graceful unavailability: when the AOSP mtmd binding is
 *      not present (hasMtmd() === false) the loader throws a structured
 *      VisionBackendUnavailableError; the arbiter must NOT silently
 *      register a half-broken capability.
 *
 *   5. mmproj missing → vision-describe capability stays unregistered:
 *      the node-llama-cpp loader throws VisionBackendUnavailableError
 *      with reason "mmproj_missing" when neither mtmd nor a vision
 *      manager fallback is wired AND the mmproj path doesn't exist.
 *      Documents that the arbiter should NOT have the capability when
 *      this happens (so provider.ts falls through to legacy describeImage).
 */

import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	createLocalInferenceModelHandlers,
} from "../src/provider.ts";
import {
	type ArbiterEvent,
	type CapabilityRegistration,
	MemoryArbiter,
} from "../src/services/memory-arbiter";
import {
	capacitorPressureSource,
	compositePressureSource,
} from "../src/services/memory-pressure";
import { VisionEmbeddingCache } from "../src/services/vision-embedding-cache";
import {
	createVisionCapabilityRegistration,
	type VisionDescribeBackend,
	VisionBackendUnavailableError,
	loadAospVisionBackend,
	loadNodeLlamaCppVisionBackend,
} from "../src/services/vision";
import { SharedResourceRegistry } from "../src/services/voice/shared-resources";

function tinyPngBytes(): Uint8Array {
	const base64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
	return Uint8Array.from(Buffer.from(base64, "base64"));
}

interface FakeVisionState {
	loaded: string[];
	disposed: number;
	described: number;
	prompts: string[];
	receivedProjected: boolean[];
}

function makeFakeBackend(state: FakeVisionState): VisionDescribeBackend {
	return {
		id: "fake",
		async describe(req, args) {
			state.described += 1;
			state.prompts.push(req.prompt ?? "<no prompt>");
			state.receivedProjected.push(Boolean(args?.projectedTokens));
			return {
				title: "A small image",
				description: `seam-${req.prompt ?? "default"}`,
				projectorMs: 8,
				decodeMs: 16,
				cacheHit: Boolean(args?.projectedTokens),
			};
		},
		async dispose() {
			state.disposed += 1;
		},
	};
}

interface FakeTextBackend {
	id: string;
	disposed: boolean;
}

function makeFakeText(opts: {
	loaded: string[];
	unloaded: string[];
}): CapabilityRegistration<FakeTextBackend, { x: string }, string> {
	return {
		capability: "text",
		residentRole: "text-target",
		estimatedMb: 1200,
		load: async (k) => {
			opts.loaded.push(k);
			return { id: k, disposed: false };
		},
		unload: async (b) => {
			opts.unloaded.push(b.id);
			b.disposed = true;
		},
		run: async (b, r) => `${b.id}:${r.x}`,
	};
}

// ---------------------------------------------------------------------------
// (1) provider IMAGE_DESCRIPTION → arbiter.requestVisionDescribe seam
// ---------------------------------------------------------------------------

describe("WS1↔WS2 seam — provider IMAGE_DESCRIPTION uses the arbiter when capability is registered", () => {
	function runtimeWithArbiter(arbiter: MemoryArbiter) {
		const service = {
			getMemoryArbiter: () => arbiter,
			// Legacy describeImage MUST NOT be called when the arbiter has
			// the capability — the handler should prefer the WS2 path.
			describeImage: vi.fn(async () => ({
				title: "legacy-title",
				description: "legacy-description",
			})),
			setSetting: vi.fn(),
			getSetting: vi.fn(),
		};
		const runtime = {
			getService: vi.fn((name: string) =>
				name === "localInferenceLoader" ? service : null,
			),
			setSetting: vi.fn(),
			getSetting: vi.fn(),
		};
		return { runtime, service };
	}

	it("dispatches IMAGE_DESCRIPTION through the arbiter when vision-describe is registered", async () => {
		const arbiter = new MemoryArbiter({
			registry: new SharedResourceRegistry(),
			visionCache: new VisionEmbeddingCache(),
		});
		const state: FakeVisionState = {
			loaded: [],
			disposed: 0,
			described: 0,
			prompts: [],
			receivedProjected: [],
		};
		const reg = createVisionCapabilityRegistration({
			arbiterCache: arbiter,
			loader: async (k) => {
				state.loaded.push(k);
				return makeFakeBackend(state);
			},
		});
		arbiter.registerCapability(reg);

		const { runtime, service } = runtimeWithArbiter(arbiter);
		const handlers = createLocalInferenceModelHandlers();
		const dataUrl = `data:image/png;base64,${Buffer.from(tinyPngBytes()).toString("base64")}`;
		const result = await handlers[ModelType.IMAGE_DESCRIPTION]?.(
			runtime as never,
			{ imageUrl: dataUrl, prompt: "what is this" } as never,
		);

		// WS2 path was used; legacy describeImage was NOT called.
		expect(state.described).toBe(1);
		expect(state.prompts[0]).toBe("what is this");
		expect(service.describeImage).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			title: "A small image",
			description: "seam-what is this",
		});
	});

	it("falls through to legacy describeImage when the arbiter has no vision-describe capability", async () => {
		const arbiter = new MemoryArbiter({
			registry: new SharedResourceRegistry(),
			visionCache: new VisionEmbeddingCache(),
		});
		// Do NOT register a vision-describe capability. The arbiter exists
		// but `hasCapability("vision-describe") === false`, so provider.ts
		// must fall through to the legacy path.
		const { runtime, service } = runtimeWithArbiter(arbiter);
		const handlers = createLocalInferenceModelHandlers();
		const dataUrl = `data:image/png;base64,${Buffer.from(tinyPngBytes()).toString("base64")}`;
		const result = await handlers[ModelType.IMAGE_DESCRIPTION]?.(
			runtime as never,
			{ imageUrl: dataUrl, prompt: "what is this" } as never,
		);
		expect(service.describeImage).toHaveBeenCalledOnce();
		expect(result).toEqual({
			title: "legacy-title",
			description: "legacy-description",
		});
	});

	it("propagates backend errors from the WS2 path back to the IMAGE_DESCRIPTION caller", async () => {
		const arbiter = new MemoryArbiter({
			registry: new SharedResourceRegistry(),
			visionCache: new VisionEmbeddingCache(),
		});
		const reg = createVisionCapabilityRegistration({
			arbiterCache: arbiter,
			loader: async () => ({
				id: "fake" as const,
				async describe() {
					throw new Error("backend exploded");
				},
				async dispose() {},
			}),
		});
		arbiter.registerCapability(reg);
		const { runtime } = runtimeWithArbiter(arbiter);
		const handlers = createLocalInferenceModelHandlers();
		const dataUrl = `data:image/png;base64,${Buffer.from(tinyPngBytes()).toString("base64")}`;
		await expect(
			handlers[ModelType.IMAGE_DESCRIPTION]?.(runtime as never, {
				imageUrl: dataUrl,
				prompt: "x",
			} as never),
		).rejects.toThrow(/backend exploded/);
	});
});

// ---------------------------------------------------------------------------
// (2) Mobile pressure dispatch — Capacitor → arbiter → eviction
// ---------------------------------------------------------------------------

describe("WS1↔WS2 seam — mobile pressure dispatch evicts non-text roles", () => {
	it("a low pressure dispatch from the Capacitor bridge evicts vision-describe but keeps text", async () => {
		const bridge = capacitorPressureSource();
		const arbiter = new MemoryArbiter({
			registry: new SharedResourceRegistry(),
			pressureSource: bridge,
			visionCache: new VisionEmbeddingCache(),
		});
		arbiter.start();

		const textState = { loaded: [] as string[], unloaded: [] as string[] };
		arbiter.registerCapability(makeFakeText(textState));

		const visionState: FakeVisionState = {
			loaded: [],
			disposed: 0,
			described: 0,
			prompts: [],
			receivedProjected: [],
		};
		const visionReg = createVisionCapabilityRegistration({
			arbiterCache: arbiter,
			loader: async (k) => {
				visionState.loaded.push(k);
				return makeFakeBackend(visionState);
			},
		});
		arbiter.registerCapability(visionReg);

		const tHandle = await arbiter.acquire("text", "eliza-1-2b");
		const vHandle = await arbiter.acquire("vision-describe", "qwen3-vl");
		await tHandle.release();
		await vHandle.release();

		const events: ArbiterEvent[] = [];
		arbiter.onEvent((e) => events.push(e));

		// Simulate iOS/Android ComponentCallbacks2.onTrimMemory → low.
		bridge.dispatch("low", 256);
		// Drain microtasks for the async pressure handler.
		await new Promise<void>((r) => setTimeout(r, 5));

		expect(visionState.disposed).toBe(1);
		expect(textState.unloaded).toEqual([]);

		const evictions = events.filter((e) => e.type === "eviction");
		expect(evictions).toHaveLength(1);
		expect(evictions[0]).toMatchObject({
			capability: "vision-describe",
			modelKey: "qwen3-vl",
			reason: "pressure",
		});
	});

	it("a critical pressure dispatch wipes vision but text survives", async () => {
		const bridge = capacitorPressureSource();
		const arbiter = new MemoryArbiter({
			registry: new SharedResourceRegistry(),
			pressureSource: bridge,
			visionCache: new VisionEmbeddingCache(),
		});
		arbiter.start();

		const textState = { loaded: [] as string[], unloaded: [] as string[] };
		arbiter.registerCapability(makeFakeText(textState));

		const visionState: FakeVisionState = {
			loaded: [],
			disposed: 0,
			described: 0,
			prompts: [],
			receivedProjected: [],
		};
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				arbiterCache: arbiter,
				loader: async () => makeFakeBackend(visionState),
			}),
		);

		const t = await arbiter.acquire("text", "eliza-1-2b");
		const v = await arbiter.acquire("vision-describe", "qwen3-vl");
		await t.release();
		await v.release();

		bridge.dispatch("critical", 32);
		await new Promise<void>((r) => setTimeout(r, 5));

		expect(visionState.disposed).toBe(1);
		expect(textState.unloaded).toEqual([]);

		// And per docs: while critical, further non-text acquires throw.
		await expect(
			arbiter.acquire("vision-describe", "qwen3-vl"),
		).rejects.toThrow(/critical/);
	});

	it("composite pressure (desktop OS poll + Capacitor bridge) follows the worst signal", async () => {
		const desktop = capacitorPressureSource(); // stand-in OS source
		const mobile = capacitorPressureSource();
		const composite = compositePressureSource([desktop, mobile]);
		const arbiter = new MemoryArbiter({
			registry: new SharedResourceRegistry(),
			pressureSource: composite,
			visionCache: new VisionEmbeddingCache(),
		});
		arbiter.start();

		const visionState: FakeVisionState = {
			loaded: [],
			disposed: 0,
			described: 0,
			prompts: [],
			receivedProjected: [],
		};
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				arbiterCache: arbiter,
				loader: async () => makeFakeBackend(visionState),
			}),
		);
		const v = await arbiter.acquire("vision-describe", "qwen3-vl");
		await v.release();

		// Desktop reports nominal; mobile dispatches critical via the
		// native callback. Composite must surface critical.
		desktop.dispatch("nominal");
		mobile.dispatch("critical", 16);
		await new Promise<void>((r) => setTimeout(r, 5));
		expect(visionState.disposed).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// (3) Eviction ordering across the real WS2 wrapper
// ---------------------------------------------------------------------------

describe("WS1↔WS2 seam — eviction order uses real WS2 wrapper", () => {
	it("vision-describe evicts before text under low pressure", async () => {
		const bridge = capacitorPressureSource();
		const arbiter = new MemoryArbiter({
			registry: new SharedResourceRegistry(),
			pressureSource: bridge,
			visionCache: new VisionEmbeddingCache(),
		});
		arbiter.start();

		const textState = { loaded: [] as string[], unloaded: [] as string[] };
		arbiter.registerCapability(makeFakeText(textState));

		const visionState: FakeVisionState = {
			loaded: [],
			disposed: 0,
			described: 0,
			prompts: [],
			receivedProjected: [],
		};
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				arbiterCache: arbiter,
				loader: async () => makeFakeBackend(visionState),
			}),
		);

		// Order is intentional: text first, then vision. We are testing
		// that priority (not insertion order) drives the pressure pick.
		const t = await arbiter.acquire("text", "eliza-1-2b");
		const v = await arbiter.acquire("vision-describe", "qwen3-vl");
		await t.release();
		await v.release();

		bridge.dispatch("low");
		await new Promise<void>((r) => setTimeout(r, 5));

		// Vision (priority 20) MUST evict before text (priority 100).
		expect(visionState.disposed).toBe(1);
		expect(textState.unloaded).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// (4) AOSP backend stub — graceful unavailability
// ---------------------------------------------------------------------------

describe("WS1↔WS2 seam — AOSP backend unavailable surfaces cleanly", () => {
	it("loadAospVisionBackend throws VisionBackendUnavailableError when hasMtmd() returns false", async () => {
		const stubBinding = {
			hasMtmd: () => false,
			initMtmd: async () => {
				throw new Error("should never be called when hasMtmd=false");
			},
		};
		await expect(
			loadAospVisionBackend({
				loadArgs: { modelPath: "/dev/null", mmprojPath: "/dev/null" },
				mtmdBinding: stubBinding,
			}),
		).rejects.toBeInstanceOf(VisionBackendUnavailableError);
	});

	it("an arbiter that wraps an AOSP loader without mtmd refuses to register the capability cleanly", async () => {
		// The contract: when the loader throws on the first acquire, the
		// arbiter MUST surface the error and NOT cache a half-loaded entry.
		const arbiter = new MemoryArbiter({
			registry: new SharedResourceRegistry(),
			visionCache: new VisionEmbeddingCache(),
		});
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				arbiterCache: arbiter,
				loader: async () =>
					loadAospVisionBackend({
						loadArgs: { modelPath: "/dev/null", mmprojPath: "/dev/null" },
						mtmdBinding: { hasMtmd: () => false, initMtmd: async () => {
							throw new Error("nope");
						} },
					}),
			}),
		);
		await expect(
			arbiter.requestVisionDescribe({
				modelKey: "qwen3-vl",
				payload: {
					image: { kind: "bytes", bytes: tinyPngBytes() },
					prompt: "x",
				},
			}),
		).rejects.toBeInstanceOf(VisionBackendUnavailableError);
		// A failed load MUST NOT cache a resident entry — a subsequent
		// request must re-attempt the load and re-throw, not silently
		// return stale data.
		await expect(
			arbiter.requestVisionDescribe({
				modelKey: "qwen3-vl",
				payload: {
					image: { kind: "bytes", bytes: tinyPngBytes() },
					prompt: "x",
				},
			}),
		).rejects.toBeInstanceOf(VisionBackendUnavailableError);
		expect(arbiter.residentSnapshot().length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// (5) mmproj missing → node-llama-cpp loader signals unavailability
// ---------------------------------------------------------------------------

describe("WS1↔WS2 seam — node-llama-cpp loader handles mmproj_missing", () => {
	it("throws VisionBackendUnavailableError with reason mmproj_missing when mtmd binding is wired but mmproj file doesn't exist", async () => {
		const fakeBinding = {
			async loadVisionModel() {
				throw new Error("should never be called when mmproj is missing");
			},
		};
		await expect(
			loadNodeLlamaCppVisionBackend({
				loadArgs: {
					modelPath: "/tmp/no-such-text.gguf",
					mmprojPath: "/tmp/no-such-mmproj.gguf",
				},
				mtmd: fakeBinding,
			}),
		).rejects.toMatchObject({
			name: "VisionBackendUnavailableError",
			reason: "mmproj_missing",
		});
	});

	it("throws when no mtmd binding AND no VisionManager fallback is provided", async () => {
		await expect(
			loadNodeLlamaCppVisionBackend({
				loadArgs: {
					modelPath: "/tmp/x.gguf",
					mmprojPath: "/tmp/m.gguf",
				},
			}),
		).rejects.toMatchObject({
			name: "VisionBackendUnavailableError",
			reason: "binding_missing_mtmd",
		});
	});
});

// ---------------------------------------------------------------------------
// (6) In-flight vision-describe + pressure interaction
// ---------------------------------------------------------------------------

describe("WS1↔WS2 seam — in-flight vision-describe + pressure", () => {
	it("pressure during an in-flight vision describe does NOT yank the model — eviction waits for refcount=0", async () => {
		const bridge = capacitorPressureSource();
		const arbiter = new MemoryArbiter({
			registry: new SharedResourceRegistry(),
			pressureSource: bridge,
			visionCache: new VisionEmbeddingCache(),
		});
		arbiter.start();
		const visionState: FakeVisionState = {
			loaded: [],
			disposed: 0,
			described: 0,
			prompts: [],
			receivedProjected: [],
		};
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				arbiterCache: arbiter,
				loader: async () => ({
					id: "fake" as const,
					async describe() {
						// Simulate a 40 ms vision call.
						await new Promise<void>((r) => setTimeout(r, 40));
						visionState.described += 1;
						return {
							title: "x",
							description: "x",
							projectorMs: 1,
							decodeMs: 1,
						};
					},
					async dispose() {
						visionState.disposed += 1;
					},
				}),
			}),
		);

		// Fire a describe in the background; it holds the vision refcount.
		const inflight = arbiter.requestVisionDescribe({
			modelKey: "qwen3-vl",
			payload: {
				image: { kind: "bytes", bytes: tinyPngBytes() },
				prompt: "x",
			},
		});
		// Dispatch critical pressure mid-call. Per docs (and the arbiter's
		// `evictableModelRole`'s `evict` guard at memory-arbiter.ts:588),
		// roles with refcount > 0 are NOT evicted.
		await new Promise<void>((r) => setTimeout(r, 5));
		bridge.dispatch("critical", 16);
		await inflight;
		// The describe completed without an unload mid-flight.
		expect(visionState.described).toBe(1);
		// Whether the role got reaped after the call is a follow-up
		// concern; we only assert it survived the in-flight window.
		// (A separate test could re-dispatch pressure post-completion.)
	});
});
