import { beforeEach, describe, expect, it } from "vitest";
import {
	type ArbiterCapability,
	type ArbiterEvent,
	MemoryArbiter,
} from "./memory-arbiter";
import {
	type CapacitorPressureSource,
	capacitorPressureSource,
} from "./memory-pressure";
import {
	type ResidentModelRole,
	SharedResourceRegistry,
} from "./voice/shared-resources";

interface FakeBackend {
	capability: ArbiterCapability;
	modelKey: string;
}

interface FakeCapability {
	registration: {
		capability: ArbiterCapability;
		residentRole?: ResidentModelRole;
		estimatedMb?: number;
		load: (modelKey: string) => Promise<FakeBackend>;
		unload: (backend: FakeBackend) => Promise<void>;
		run: (backend: FakeBackend, request: string) => Promise<string>;
	};
	loads: string[];
	unloads: string[];
}

function makeCapability(
	capability: ArbiterCapability,
	opts: { residentRole?: ResidentModelRole; estimatedMb?: number } = {},
): FakeCapability {
	const loads: string[] = [];
	const unloads: string[] = [];
	return {
		loads,
		unloads,
		registration: {
			capability,
			residentRole: opts.residentRole,
			estimatedMb: opts.estimatedMb,
			load: async (modelKey) => {
				loads.push(modelKey);
				return { capability, modelKey };
			},
			unload: async (backend) => {
				unloads.push(backend.modelKey);
			},
			run: async (backend, request) => `${backend.modelKey}:${request}`,
		},
	};
}

/** Let queued microtasks + setTimeout(0) callbacks (pressure handler) run. */
async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

let clock = 1000;
const now = (): number => clock;

beforeEach(() => {
	clock = 1000;
});

describe("MemoryArbiter — acquire / reuse / release", () => {
	it("loads once and shares the handle across acquirers via refcount", async () => {
		const registry = new SharedResourceRegistry();
		const arbiter = new MemoryArbiter({ registry, now });
		const text = makeCapability("text");
		arbiter.registerCapability(text.registration);

		const h1 = await arbiter.acquire("text", "m");
		const h2 = await arbiter.acquire("text", "m");

		expect(text.loads).toEqual(["m"]); // single load
		const snap = arbiter.residentSnapshot();
		expect(snap).toHaveLength(1);
		expect(snap[0]?.refCount).toBe(2);

		await h1.release();
		await h2.release();
		// refcount 0 does NOT unload — the model stays warm.
		expect(text.unloads).toEqual([]);
		expect(arbiter.residentSnapshot()).toHaveLength(1);
	});

	it("touches lastUsedAt on every acquire", async () => {
		const registry = new SharedResourceRegistry();
		const arbiter = new MemoryArbiter({ registry, now });
		arbiter.registerCapability(makeCapability("text").registration);

		clock = 2000;
		const h = await arbiter.acquire("text", "m");
		expect(arbiter.residentSnapshot()[0]?.lastUsedAt).toBe(2000);
		await h.release();

		clock = 5000;
		const h2 = await arbiter.acquire("text", "m");
		expect(arbiter.residentSnapshot()[0]?.lastUsedAt).toBe(5000);
		await h2.release();
	});
});

describe("MemoryArbiter — swap (one model per role)", () => {
	it("evicts the previous model in a role when a new modelKey loads", async () => {
		const registry = new SharedResourceRegistry();
		const events: ArbiterEvent[] = [];
		const arbiter = new MemoryArbiter({ registry, now });
		arbiter.onEvent((e) => events.push(e));
		const text = makeCapability("text");
		arbiter.registerCapability(text.registration);

		const a = await arbiter.acquire("text", "A");
		await a.release(); // drain so the swap can proceed
		const b = await arbiter.acquire("text", "B");

		expect(text.loads).toEqual(["A", "B"]);
		expect(text.unloads).toEqual(["A"]);
		const snap = arbiter.residentSnapshot();
		expect(snap).toHaveLength(1);
		expect(snap[0]?.modelKey).toBe("B");
		expect(
			events.some((e) => e.type === "eviction" && e.reason === "swap"),
		).toBe(true);
		await b.release();
	});
});

describe("MemoryArbiter — fit-to-budget LRU eviction", () => {
	it("evicts the least-recently-used evictable model to fit the budget", async () => {
		const registry = new SharedResourceRegistry();
		const events: ArbiterEvent[] = [];
		// budget 1000 MB; each model 600 MB → only one non-text fits at a time.
		const arbiter = new MemoryArbiter({ registry, now, budgetMb: () => 1000 });
		arbiter.onEvent((e) => events.push(e));
		const embedding = makeCapability("embedding", {
			residentRole: "embedding",
			estimatedMb: 600,
		});
		const vision = makeCapability("vision-describe", {
			residentRole: "vision",
			estimatedMb: 600,
		});
		arbiter.registerCapability(embedding.registration);
		arbiter.registerCapability(vision.registration);

		clock = 1;
		const e = await arbiter.acquire("embedding", "emb");
		await e.release();
		clock = 2;
		const v = await arbiter.acquire("vision-describe", "vl");
		await v.release();

		// vl needed 600 on top of resident emb 600 → over 1000 → evict LRU (emb).
		expect(embedding.unloads).toEqual(["emb"]);
		const keys = arbiter.residentSnapshot().map((s) => s.modelKey);
		expect(keys).toEqual(["vl"]);
		expect(
			events.some((e) => e.type === "eviction" && e.reason === "fit"),
		).toBe(true);
	});

	it("never evicts the text target to make room", async () => {
		const registry = new SharedResourceRegistry();
		const arbiter = new MemoryArbiter({ registry, now, budgetMb: () => 1000 });
		const text = makeCapability("text", { estimatedMb: 600 });
		const embedding = makeCapability("embedding", {
			residentRole: "embedding",
			estimatedMb: 600,
		});
		arbiter.registerCapability(text.registration);
		arbiter.registerCapability(embedding.registration);

		const t = await arbiter.acquire("text", "txt");
		await t.release();
		const e = await arbiter.acquire("embedding", "emb");
		await e.release();

		// Can't free the text target, so the fit path is best-effort: embedding
		// still loads and both stay resident.
		expect(text.unloads).toEqual([]);
		const roles = arbiter
			.residentSnapshot()
			.map((s) => s.residentRole)
			.sort();
		expect(roles).toEqual(["embedding", "text-target"]);
	});

	it("never evicts a model with a live refcount", async () => {
		const registry = new SharedResourceRegistry();
		const arbiter = new MemoryArbiter({ registry, now, budgetMb: () => 1000 });
		const embedding = makeCapability("embedding", {
			residentRole: "embedding",
			estimatedMb: 600,
		});
		const vision = makeCapability("vision-describe", {
			residentRole: "vision",
			estimatedMb: 600,
		});
		arbiter.registerCapability(embedding.registration);
		arbiter.registerCapability(vision.registration);

		const held = await arbiter.acquire("embedding", "emb"); // keep refcount=1
		const v = await arbiter.acquire("vision-describe", "vl");

		expect(embedding.unloads).toEqual([]); // pinned by refcount
		expect(arbiter.residentSnapshot()).toHaveLength(2);
		await held.release();
		await v.release();
	});

	it("orders eviction by last-use, not load order", async () => {
		const registry = new SharedResourceRegistry();
		// budget 1300: two 600 MB models fit, a third forces one eviction.
		const arbiter = new MemoryArbiter({ registry, now, budgetMb: () => 1300 });
		const embedding = makeCapability("embedding", {
			residentRole: "embedding",
			estimatedMb: 600,
		});
		const vision = makeCapability("vision-describe", {
			residentRole: "vision",
			estimatedMb: 600,
		});
		const asr = makeCapability("transcribe", {
			residentRole: "asr",
			estimatedMb: 600,
		});
		arbiter.registerCapability(embedding.registration);
		arbiter.registerCapability(vision.registration);
		arbiter.registerCapability(asr.registration);

		clock = 1;
		await (await arbiter.acquire("embedding", "emb")).release();
		clock = 2;
		await (await arbiter.acquire("vision-describe", "vl")).release();
		clock = 3;
		// Re-touch embedding so vision is now the least-recently-used.
		await (await arbiter.acquire("embedding", "emb")).release();
		clock = 4;
		await (await arbiter.acquire("transcribe", "asr")).release();

		expect(vision.unloads).toEqual(["vl"]); // LRU victim
		expect(embedding.unloads).toEqual([]);
		const keys = arbiter
			.residentSnapshot()
			.map((s) => s.modelKey)
			.sort();
		expect(keys).toEqual(["asr", "emb"]);
	});

	it("does nothing when no budget is configured", async () => {
		const registry = new SharedResourceRegistry();
		const arbiter = new MemoryArbiter({ registry, now }); // budgetMb default → null
		const embedding = makeCapability("embedding", {
			residentRole: "embedding",
			estimatedMb: 600,
		});
		const vision = makeCapability("vision-describe", {
			residentRole: "vision",
			estimatedMb: 600,
		});
		arbiter.registerCapability(embedding.registration);
		arbiter.registerCapability(vision.registration);

		await (await arbiter.acquire("embedding", "emb")).release();
		await (await arbiter.acquire("vision-describe", "vl")).release();

		expect(embedding.unloads).toEqual([]);
		expect(arbiter.residentSnapshot()).toHaveLength(2);
	});
});

describe("MemoryArbiter — memory pressure", () => {
	it("critical evicts every non-text role but keeps the text target", async () => {
		const registry = new SharedResourceRegistry();
		const source: CapacitorPressureSource = capacitorPressureSource({ now });
		const arbiter = new MemoryArbiter({
			registry,
			pressureSource: source,
			now,
		});
		const text = makeCapability("text");
		const embedding = makeCapability("embedding", {
			residentRole: "embedding",
		});
		const vision = makeCapability("vision-describe", {
			residentRole: "vision",
		});
		arbiter.registerCapability(text.registration);
		arbiter.registerCapability(embedding.registration);
		arbiter.registerCapability(vision.registration);
		arbiter.start();

		await (await arbiter.acquire("text", "txt")).release();
		await (await arbiter.acquire("embedding", "emb")).release();
		await (await arbiter.acquire("vision-describe", "vl")).release();

		source.dispatch("critical");
		await flush();

		expect(arbiter.currentPressureLevel()).toBe("critical");
		expect(embedding.unloads).toEqual(["emb"]);
		expect(vision.unloads).toEqual(["vl"]);
		expect(text.unloads).toEqual([]);
		const roles = arbiter.residentSnapshot().map((s) => s.residentRole);
		expect(roles).toEqual(["text-target"]);
		await arbiter.shutdown();
	});

	it("refuses non-text acquire under critical pressure but still loads text", async () => {
		const registry = new SharedResourceRegistry();
		const source: CapacitorPressureSource = capacitorPressureSource({ now });
		const arbiter = new MemoryArbiter({
			registry,
			pressureSource: source,
			now,
		});
		arbiter.registerCapability(makeCapability("text").registration);
		arbiter.registerCapability(
			makeCapability("embedding", { residentRole: "embedding" }).registration,
		);
		arbiter.start();

		source.dispatch("critical");
		await flush();

		await expect(arbiter.acquire("embedding", "emb")).rejects.toThrow(
			/critical/i,
		);
		const t = await arbiter.acquire("text", "txt");
		expect(t.modelKey).toBe("txt");
		await t.release();
		await arbiter.shutdown();
	});

	it("low pressure evicts one (lowest-priority) role per tick", async () => {
		const registry = new SharedResourceRegistry();
		const source: CapacitorPressureSource = capacitorPressureSource({ now });
		const arbiter = new MemoryArbiter({
			registry,
			pressureSource: source,
			now,
		});
		const embedding = makeCapability("embedding", {
			residentRole: "embedding", // priority 25
		});
		const vision = makeCapability("vision-describe", {
			residentRole: "vision", // priority 20 → evicts first
		});
		arbiter.registerCapability(embedding.registration);
		arbiter.registerCapability(vision.registration);
		arbiter.start();

		await (await arbiter.acquire("embedding", "emb")).release();
		await (await arbiter.acquire("vision-describe", "vl")).release();

		source.dispatch("low");
		await flush();

		expect(vision.unloads).toEqual(["vl"]); // lowest priority dropped
		expect(embedding.unloads).toEqual([]);
		await arbiter.shutdown();
	});
});

describe("MemoryArbiter — request queue + telemetry + shutdown", () => {
	it("runs queued requests and emits run telemetry", async () => {
		const registry = new SharedResourceRegistry();
		const events: ArbiterEvent[] = [];
		const arbiter = new MemoryArbiter({ registry, now });
		arbiter.onEvent((e) => events.push(e));
		arbiter.registerCapability(makeCapability("text").registration);

		const result = await arbiter.requestText<string, string>({
			modelKey: "m",
			payload: "hi",
		});
		expect(result).toBe("m:hi");
		expect(events.some((e) => e.type === "model_load")).toBe(true);
		expect(events.some((e) => e.type === "capability_run")).toBe(true);
	});

	it("shutdown unloads every resident handle", async () => {
		const registry = new SharedResourceRegistry();
		const arbiter = new MemoryArbiter({ registry, now });
		const text = makeCapability("text");
		const embedding = makeCapability("embedding", {
			residentRole: "embedding",
		});
		arbiter.registerCapability(text.registration);
		arbiter.registerCapability(embedding.registration);

		await (await arbiter.acquire("text", "txt")).release();
		await (await arbiter.acquire("embedding", "emb")).release();

		await arbiter.shutdown();

		expect(text.unloads).toEqual(["txt"]);
		expect(embedding.unloads).toEqual(["emb"]);
		expect(arbiter.residentSnapshot()).toHaveLength(0);
	});

	it("rejects acquire after shutdown", async () => {
		const registry = new SharedResourceRegistry();
		const arbiter = new MemoryArbiter({ registry, now });
		arbiter.registerCapability(makeCapability("text").registration);
		await arbiter.shutdown();
		await expect(arbiter.acquire("text", "m")).rejects.toThrow(
			/shutting down/i,
		);
	});
});
