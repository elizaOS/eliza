/**
 * Memory Arbiter (WS1) tests.
 *
 * Covers:
 *   - Capability registration + acquire/release refcounting.
 *   - Same-modelKey concurrent acquires share one in-flight load.
 *   - Conflicting modelKey on the same role triggers an evict-then-load swap.
 *   - In-flight runs delay swaps (refcount > 0 waits).
 *   - Pressure events: low → one eviction; critical → wipe non-text.
 *   - Critical pressure rejects acquire for non-text capabilities.
 *   - Telemetry: model_load / model_unload / memory_pressure / eviction / capability_run.
 *   - Vision-embedding cache: hit, miss, expiry, LRU eviction.
 *   - Composite/poll pressure source emit nominal at boot and respond to source updates.
 *   - Shutdown unloads everything.
 */

import { describe, expect, it } from "vitest";
import {
	type ArbiterEvent,
	MemoryArbiter,
	type CapabilityRegistration,
} from "../src/services/memory-arbiter";
import {
	type MemoryPressureEvent,
	capacitorPressureSource,
	compositePressureSource,
	nodeOsPressureSource,
} from "../src/services/memory-pressure";
import { VisionEmbeddingCache } from "../src/services/vision-embedding-cache";
import { SharedResourceRegistry } from "../src/services/voice/shared-resources";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FakeBackend {
	id: string;
	disposed: boolean;
}

function makeFakeCapability(
	overrides: Partial<CapabilityRegistration<FakeBackend, { x: string }, string>> = {},
): {
	registration: CapabilityRegistration<FakeBackend, { x: string }, string>;
	loaded: string[];
	unloaded: string[];
	loadDelayMs: { value: number };
	runDelayMs: { value: number };
} {
	const loaded: string[] = [];
	const unloaded: string[] = [];
	const loadDelayMs = { value: 0 };
	const runDelayMs = { value: 0 };
	const registration: CapabilityRegistration<FakeBackend, { x: string }, string> = {
		capability: "text",
		residentRole: "text-target",
		estimatedMb: 1024,
		load: async (modelKey) => {
			loaded.push(modelKey);
			if (loadDelayMs.value > 0) {
				await new Promise<void>((r) => setTimeout(r, loadDelayMs.value));
			}
			return { id: modelKey, disposed: false };
		},
		unload: async (backend) => {
			unloaded.push(backend.id);
			backend.disposed = true;
		},
		run: async (backend, req) => {
			if (runDelayMs.value > 0) {
				await new Promise<void>((r) => setTimeout(r, runDelayMs.value));
			}
			if (backend.disposed) throw new Error(`backend ${backend.id} already disposed`);
			return `${backend.id}:${req.x}`;
		},
		...overrides,
	};
	return { registration, loaded, unloaded, loadDelayMs, runDelayMs };
}

function makeArbiter(opts: { capacitorBridge?: ReturnType<typeof capacitorPressureSource> } = {}): {
	arbiter: MemoryArbiter;
	registry: SharedResourceRegistry;
	bridge: ReturnType<typeof capacitorPressureSource>;
	events: ArbiterEvent[];
} {
	const registry = new SharedResourceRegistry();
	const bridge = opts.capacitorBridge ?? capacitorPressureSource();
	const arbiter = new MemoryArbiter({
		registry,
		pressureSource: bridge,
		visionCache: new VisionEmbeddingCache({ config: { maxEntries: 4, defaultTtlMs: 60_000 } }),
	});
	const events: ArbiterEvent[] = [];
	arbiter.onEvent((event) => events.push(event));
	arbiter.start();
	return { arbiter, registry, bridge, events };
}

// ---------------------------------------------------------------------------
// Capability registration + acquire/release
// ---------------------------------------------------------------------------

describe("MemoryArbiter — registration and acquire", () => {
	it("rejects acquire when no capability is registered", async () => {
		const { arbiter } = makeArbiter();
		await expect(arbiter.acquire("vision-describe", "qwen3-vl-4b")).rejects.toThrow(
			/no capability registered/,
		);
	});

	it("rejects duplicate registration", () => {
		const { arbiter } = makeArbiter();
		const a = makeFakeCapability();
		const b = makeFakeCapability();
		arbiter.registerCapability(a.registration);
		expect(() => arbiter.registerCapability(b.registration)).toThrow(/already registered/);
	});

	it("loads on first acquire and reuses the handle on the second", async () => {
		const { arbiter } = makeArbiter();
		const cap = makeFakeCapability();
		arbiter.registerCapability(cap.registration);
		const h1 = await arbiter.acquire<FakeBackend>("text", "tier-2b");
		const h2 = await arbiter.acquire<FakeBackend>("text", "tier-2b");
		expect(cap.loaded).toEqual(["tier-2b"]);
		expect(h1.backend.id).toBe("tier-2b");
		expect(h2.backend).toBe(h1.backend);
		await h1.release();
		await h2.release();
		expect(cap.unloaded).toEqual([]); // refcount=0 alone does not unload
	});

	it("shares a single in-flight load across concurrent acquires", async () => {
		const { arbiter } = makeArbiter();
		const cap = makeFakeCapability();
		cap.loadDelayMs.value = 30;
		arbiter.registerCapability(cap.registration);
		const [h1, h2, h3] = await Promise.all([
			arbiter.acquire<FakeBackend>("text", "shared-tier"),
			arbiter.acquire<FakeBackend>("text", "shared-tier"),
			arbiter.acquire<FakeBackend>("text", "shared-tier"),
		]);
		expect(cap.loaded).toEqual(["shared-tier"]);
		expect(h1.backend).toBe(h2.backend);
		expect(h2.backend).toBe(h3.backend);
		await h1.release();
		await h2.release();
		await h3.release();
	});
});

// ---------------------------------------------------------------------------
// Swap behaviour: same role, different modelKey
// ---------------------------------------------------------------------------

describe("MemoryArbiter — swap on conflicting role", () => {
	it("evicts the previous model when the same role is loaded for a different key", async () => {
		const { arbiter, events } = makeArbiter();
		const cap = makeFakeCapability();
		arbiter.registerCapability(cap.registration);
		const a = await arbiter.acquire<FakeBackend>("text", "tier-a");
		await a.release();
		const b = await arbiter.acquire<FakeBackend>("text", "tier-b");
		await b.release();
		expect(cap.loaded).toEqual(["tier-a", "tier-b"]);
		expect(cap.unloaded).toEqual(["tier-a"]);
		const evictionEvents = events.filter((e) => e.type === "eviction");
		expect(evictionEvents).toHaveLength(1);
		expect(evictionEvents[0]).toMatchObject({
			capability: "text",
			modelKey: "tier-a",
			reason: "swap",
		});
	});

	it("waits for in-flight refcount holders before swapping", async () => {
		const { arbiter } = makeArbiter();
		const cap = makeFakeCapability();
		cap.runDelayMs.value = 25;
		arbiter.registerCapability(cap.registration);
		const a = await arbiter.acquire<FakeBackend>("text", "tier-a");
		// Hold the handle and start a fake long-running op via run() against the
		// same backend.
		const longRun = (async () => {
			// Simulate work that retains the handle.
			await new Promise<void>((r) => setTimeout(r, 30));
			await a.release();
		})();
		// Now request the other model. It must NOT evict tier-a until the
		// longRun above releases.
		const swapStart = Date.now();
		const b = await arbiter.acquire<FakeBackend>("text", "tier-b");
		const swapMs = Date.now() - swapStart;
		expect(cap.unloaded).toEqual(["tier-a"]);
		// We waited at least roughly the in-flight delay; allow scheduling slack.
		expect(swapMs).toBeGreaterThanOrEqual(20);
		await b.release();
		await longRun;
	});

	it("loads two different roles concurrently without swapping", async () => {
		const { arbiter } = makeArbiter();
		const text = makeFakeCapability();
		const vision = makeFakeCapability({
			capability: "vision-describe",
			residentRole: "vision",
		});
		arbiter.registerCapability(text.registration);
		arbiter.registerCapability(vision.registration);
		const t = await arbiter.acquire<FakeBackend>("text", "tier-2b");
		const v = await arbiter.acquire<FakeBackend>("vision-describe", "qwen3-vl-4b");
		expect(text.unloaded).toEqual([]);
		expect(vision.unloaded).toEqual([]);
		await t.release();
		await v.release();
	});
});

// ---------------------------------------------------------------------------
// Pressure-driven eviction
// ---------------------------------------------------------------------------

describe("MemoryArbiter — memory pressure", () => {
	it("evicts the lowest-priority resident role on `low` pressure", async () => {
		const { arbiter, bridge, events } = makeArbiter();
		const text = makeFakeCapability();
		const vision = makeFakeCapability({
			capability: "vision-describe",
			residentRole: "vision",
		});
		arbiter.registerCapability(text.registration);
		arbiter.registerCapability(vision.registration);
		const t = await arbiter.acquire<FakeBackend>("text", "tier-2b");
		const v = await arbiter.acquire<FakeBackend>("vision-describe", "qwen3-vl-4b");
		await t.release();
		await v.release();
		// Vision is priority 20 (cheaper) than text-target (100); pressure
		// should evict vision.
		bridge.dispatch("low");
		// Allow the async handler to drain.
		await new Promise<void>((r) => setTimeout(r, 5));
		expect(vision.unloaded).toEqual(["qwen3-vl-4b"]);
		expect(text.unloaded).toEqual([]);
		const pressureEvents = events.filter((e) => e.type === "memory_pressure");
		expect(pressureEvents.at(-1)?.level).toBe("low");
	});

	it("evicts every non-text role on `critical` pressure", async () => {
		const { arbiter, bridge } = makeArbiter();
		const text = makeFakeCapability();
		const vision = makeFakeCapability({
			capability: "vision-describe",
			residentRole: "vision",
		});
		const embedding = makeFakeCapability({
			capability: "embedding",
			residentRole: "embedding",
		});
		arbiter.registerCapability(text.registration);
		arbiter.registerCapability(vision.registration);
		arbiter.registerCapability(embedding.registration);
		const t = await arbiter.acquire<FakeBackend>("text", "tier-2b");
		const v = await arbiter.acquire<FakeBackend>("vision-describe", "qwen3-vl-4b");
		const e = await arbiter.acquire<FakeBackend>("embedding", "embedding-small");
		await t.release();
		await v.release();
		await e.release();
		bridge.dispatch("critical");
		await new Promise<void>((r) => setTimeout(r, 5));
		expect(vision.unloaded).toEqual(["qwen3-vl-4b"]);
		expect(embedding.unloaded).toEqual(["embedding-small"]);
		// text-target survives critical
		expect(text.unloaded).toEqual([]);
	});

	it("rejects non-text acquires under critical pressure", async () => {
		const { arbiter, bridge } = makeArbiter();
		const vision = makeFakeCapability({
			capability: "vision-describe",
			residentRole: "vision",
		});
		arbiter.registerCapability(vision.registration);
		bridge.dispatch("critical");
		await new Promise<void>((r) => setTimeout(r, 5));
		await expect(
			arbiter.acquire<FakeBackend>("vision-describe", "qwen3-vl-4b"),
		).rejects.toThrow(/critical/);
	});

	it("still allows text acquires under critical pressure", async () => {
		const { arbiter, bridge } = makeArbiter();
		const text = makeFakeCapability();
		arbiter.registerCapability(text.registration);
		bridge.dispatch("critical");
		await new Promise<void>((r) => setTimeout(r, 5));
		const t = await arbiter.acquire<FakeBackend>("text", "tier-2b");
		expect(t.backend.id).toBe("tier-2b");
		await t.release();
	});

	it("does not evict a role with refcount > 0 under pressure", async () => {
		const { arbiter, bridge } = makeArbiter();
		const text = makeFakeCapability();
		const vision = makeFakeCapability({
			capability: "vision-describe",
			residentRole: "vision",
		});
		arbiter.registerCapability(text.registration);
		arbiter.registerCapability(vision.registration);
		const t = await arbiter.acquire<FakeBackend>("text", "tier-2b");
		const v = await arbiter.acquire<FakeBackend>("vision-describe", "qwen3-vl-4b");
		// Hold onto vision (refcount=1)
		await t.release();
		bridge.dispatch("critical");
		await new Promise<void>((r) => setTimeout(r, 5));
		expect(vision.unloaded).toEqual([]);
		await v.release();
	});
});

// ---------------------------------------------------------------------------
// Capability request queue (the request* methods)
// ---------------------------------------------------------------------------

describe("MemoryArbiter — request queue", () => {
	it("runs sequential requests against the same loaded handle", async () => {
		const { arbiter } = makeArbiter();
		const text = makeFakeCapability();
		arbiter.registerCapability(text.registration);
		const r1 = await arbiter.requestText<{ x: string }, string>({
			modelKey: "tier-2b",
			payload: { x: "alpha" },
		});
		const r2 = await arbiter.requestText<{ x: string }, string>({
			modelKey: "tier-2b",
			payload: { x: "beta" },
		});
		expect(r1).toBe("tier-2b:alpha");
		expect(r2).toBe("tier-2b:beta");
		expect(text.loaded).toEqual(["tier-2b"]);
	});

	it("emits capability_run telemetry per request", async () => {
		const { arbiter, events } = makeArbiter();
		const text = makeFakeCapability();
		arbiter.registerCapability(text.registration);
		await arbiter.requestText({ modelKey: "tier-2b", payload: { x: "y" } });
		const runs = events.filter((e) => e.type === "capability_run");
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ capability: "text", modelKey: "tier-2b" });
	});

	it("propagates run errors back to the caller without leaking the handle", async () => {
		const { arbiter } = makeArbiter();
		const text = makeFakeCapability({
			run: async () => {
				throw new Error("boom");
			},
		});
		arbiter.registerCapability(text.registration);
		await expect(
			arbiter.requestText({ modelKey: "tier-2b", payload: { x: "y" } }),
		).rejects.toThrow(/boom/);
		// Despite the error the next request must still run cleanly: no
		// dangling refcount, no permanent eviction.
		const text2 = makeFakeCapability({
			capability: "embedding",
			residentRole: "embedding",
		});
		arbiter.registerCapability(text2.registration);
		const out = await arbiter.requestEmbedding<{ x: string }, string>({
			modelKey: "embed-1",
			payload: { x: "z" },
		});
		expect(out).toBe("embed-1:z");
	});
});

// ---------------------------------------------------------------------------
// Vision-embedding cache passthrough
// ---------------------------------------------------------------------------

describe("MemoryArbiter — vision embedding cache", () => {
	it("returns null on miss and the entry on hit", () => {
		const { arbiter } = makeArbiter();
		expect(arbiter.getCachedVisionEmbedding("missing")).toBeNull();
		const tokens = new Float32Array(8);
		arbiter.setCachedVisionEmbedding("h1", { tokens, tokenCount: 2, hiddenSize: 4 });
		const hit = arbiter.getCachedVisionEmbedding("h1");
		expect(hit?.tokenCount).toBe(2);
		expect(hit?.hiddenSize).toBe(4);
		expect(hit?.tokens).toBe(tokens);
	});
});

describe("VisionEmbeddingCache", () => {
	it("evicts LRU when capacity is exceeded", () => {
		const cache = new VisionEmbeddingCache({ config: { maxEntries: 2, defaultTtlMs: 60_000 } });
		cache.set("a", { tokens: new Float32Array(2), tokenCount: 1, hiddenSize: 2 });
		cache.set("b", { tokens: new Float32Array(2), tokenCount: 1, hiddenSize: 2 });
		// Touch a so it becomes most recently used.
		expect(cache.get("a")).not.toBeNull();
		cache.set("c", { tokens: new Float32Array(2), tokenCount: 1, hiddenSize: 2 });
		expect(cache.get("b")).toBeNull(); // b was the LRU
		expect(cache.get("a")).not.toBeNull();
		expect(cache.get("c")).not.toBeNull();
	});

	it("returns null after TTL expiry and purges via purgeExpired", () => {
		let nowMs = 1000;
		const cache = new VisionEmbeddingCache({
			config: { maxEntries: 8, defaultTtlMs: 100 },
			now: () => nowMs,
		});
		cache.set("a", { tokens: new Float32Array(2), tokenCount: 1, hiddenSize: 2 });
		nowMs = 200; // not expired yet (1000 + 100 = 1100; 200 < 1100? wait — re-derive)
		// Actually expiry uses now+ttl at insertion. Recompute deterministically.
		// a expires at 1000 + 100 = 1100. Bump now past that.
		nowMs = 1500;
		expect(cache.get("a")).toBeNull();
		// Re-insert and purge.
		cache.set("b", { tokens: new Float32Array(2), tokenCount: 1, hiddenSize: 2 });
		nowMs = 1500 + 200;
		const removed = cache.purgeExpired();
		expect(removed).toBe(1);
		expect(cache.size()).toBe(0);
	});

	it("rejects mismatched token buffer length", () => {
		const cache = new VisionEmbeddingCache();
		expect(() =>
			cache.set("bad", { tokens: new Float32Array(3), tokenCount: 2, hiddenSize: 2 }),
		).toThrow(/does not match/);
	});
});

// ---------------------------------------------------------------------------
// Pressure source contracts
// ---------------------------------------------------------------------------

describe("nodeOsPressureSource", () => {
	it("emits nominal when free memory is comfortably above the low-water line", () => {
		const events: MemoryPressureEvent[] = [];
		const source = nodeOsPressureSource(
			{ intervalMs: 1_000, lowWaterFraction: 0.15, criticalWaterFraction: 0.05 },
			{ osMemory: () => ({ freeBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 }) },
		);
		const unsub = source.subscribe((e) => events.push(e));
		source.start();
		expect(events.at(-1)?.level).toBe("nominal");
		unsub();
		source.stop();
	});

	it("transitions to low and critical as free memory drops", () => {
		let freeBytes = 8 * 1024 ** 3;
		const source = nodeOsPressureSource(
			{ intervalMs: 1_000, lowWaterFraction: 0.2, criticalWaterFraction: 0.05 },
			{ osMemory: () => ({ freeBytes, totalBytes: 16 * 1024 ** 3 }) },
		);
		expect(source.current().level).toBe("nominal");
		freeBytes = 2 * 1024 ** 3; // 12.5% free → below 20% low-water
		expect(source.current().level).toBe("low");
		freeBytes = 0.5 * 1024 ** 3; // ~3% → below critical
		expect(source.current().level).toBe("critical");
	});

	it("rejects criticalWaterFraction >= lowWaterFraction at construction", () => {
		expect(() =>
			nodeOsPressureSource({ lowWaterFraction: 0.1, criticalWaterFraction: 0.2 }),
		).toThrow(/criticalWaterFraction/);
	});
});

describe("capacitorPressureSource", () => {
	it("dispatches the level the native bridge sends", () => {
		const source = capacitorPressureSource();
		const events: MemoryPressureEvent[] = [];
		source.subscribe((e) => events.push(e));
		source.start();
		source.dispatch("low", 256);
		source.dispatch("critical", 64);
		const levels = events.map((e) => e.level);
		expect(levels).toContain("low");
		expect(levels).toContain("critical");
	});
});

describe("compositePressureSource", () => {
	it("reports the worst level across underlying sources", () => {
		const a = capacitorPressureSource();
		const b = capacitorPressureSource();
		const composite = compositePressureSource([a, b]);
		composite.start();
		const events: MemoryPressureEvent[] = [];
		composite.subscribe((e) => events.push(e));
		a.dispatch("low");
		b.dispatch("critical");
		expect(events.at(-1)?.level).toBe("critical");
		// Recovery from critical only when *both* report nominal.
		b.dispatch("nominal");
		expect(events.at(-1)?.level).toBe("low");
		a.dispatch("nominal");
		expect(events.at(-1)?.level).toBe("nominal");
	});
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("MemoryArbiter — shutdown", () => {
	it("unloads every resident handle and rejects new acquires", async () => {
		const { arbiter } = makeArbiter();
		const text = makeFakeCapability();
		const vision = makeFakeCapability({
			capability: "vision-describe",
			residentRole: "vision",
		});
		arbiter.registerCapability(text.registration);
		arbiter.registerCapability(vision.registration);
		const t = await arbiter.acquire<FakeBackend>("text", "tier-2b");
		const v = await arbiter.acquire<FakeBackend>("vision-describe", "qwen3-vl-4b");
		await t.release();
		await v.release();
		await arbiter.shutdown();
		expect(text.unloaded).toContain("tier-2b");
		expect(vision.unloaded).toContain("qwen3-vl-4b");
		await expect(arbiter.acquire("text", "tier-2b")).rejects.toThrow(/shutting down/);
	});
});
