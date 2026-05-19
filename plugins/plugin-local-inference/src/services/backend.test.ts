import { afterEach, describe, expect, it } from "vitest";
import {
	BackendDispatcher,
	decideBackend,
	gpuLayersForKvOffload,
	type LocalInferenceBackend,
	readBackendOverride,
} from "./backend";
import { LocalInferenceEngine } from "./engine";
import type { CatalogModel } from "./types";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

const BASE_CATALOG: CatalogModel = {
	id: "test-model",
	displayName: "Test Model",
	hfRepo: "fake/Test-GGUF",
	ggufFile: "Test-Q4.gguf",
	params: "4B",
	quant: "Q4_K_M",
	sizeGb: 2.5,
	minRamGb: 5,
	category: "chat",
	bucket: "small",
	blurb: "test",
};

function withRuntime(
	base: CatalogModel,
	runtime: CatalogModel["runtime"],
): CatalogModel {
	return { ...base, runtime };
}

describe("readBackendOverride", () => {
	it("returns 'auto' when unset", () => {
		delete process.env.ELIZA_LOCAL_BACKEND;
		expect(readBackendOverride()).toBe("auto");
	});

	it("returns 'auto' for unknown values", () => {
		process.env.ELIZA_LOCAL_BACKEND = "magic";
		expect(readBackendOverride()).toBe("auto");
	});

	it("respects explicit overrides", () => {
		process.env.ELIZA_LOCAL_BACKEND = "capacitor-llama";
		expect(readBackendOverride()).toBe("capacitor-llama");
		process.env.ELIZA_LOCAL_BACKEND = "llama-server";
		expect(readBackendOverride()).toBe("llama-server");
	});
});

describe("gpuLayersForKvOffload", () => {
	it("maps KV placement requests onto backend gpuLayers settings", () => {
		expect(gpuLayersForKvOffload("cpu")).toBe(0);
		expect(gpuLayersForKvOffload("gpu")).toBe("max");
		expect(gpuLayersForKvOffload("split")).toBe("auto");
		expect(gpuLayersForKvOffload({ gpuLayers: 12 })).toBe(12);
	});
});

describe("decideBackend", () => {
	it("defaults to the custom llama-server when available", () => {
		const decision = decideBackend({
			override: "auto",
			catalog: BASE_CATALOG,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("llama-server");
		expect(decision.reason).toBe("default");
	});

	it("routes to llama-server when a kernel is required", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["dflash"] },
		});
		const decision = decideBackend({
			override: "auto",
			catalog,
			llamaServerAvailable: false,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("llama-server");
		expect(decision.reason).toBe("kernel-required");
		expect(decision.kernels).toEqual(["dflash"]);
	});

	it("env override wins over default", () => {
		const decision = decideBackend({
			override: "llama-server",
			catalog: BASE_CATALOG,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("llama-server");
		expect(decision.reason).toBe("env-override");
	});

	it("env override is overridden by hard kernel requirement", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["turbo3"] },
		});
		const decision = decideBackend({
			override: "capacitor-llama",
			catalog,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		// The user can't ask the in-process binding to run turbo3.
		expect(decision.backend).toBe("llama-server");
		expect(decision.reason).toBe("kernel-required");
	});

	it("respects preferredBackend=llama-server when binary available", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			preferredBackend: "llama-server",
		});
		const decision = decideBackend({
			override: "auto",
			catalog,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("llama-server");
		expect(decision.reason).toBe("preferred-backend");
	});

	it("falls back to capacitor-llama when preferredBackend=llama-server but binary missing and DFlash not required", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			preferredBackend: "llama-server",
		});
		const decision = decideBackend({
			override: "auto",
			catalog,
			llamaServerAvailable: false,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("capacitor-llama");
		expect(decision.reason).toBe("default");
	});

	it("forces llama-server when DFlash is required and configured, even if binary probe is false", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			preferredBackend: "llama-server",
			dflash: {
				drafterModelId: "x",
				specType: "dflash",
				contextSize: 8192,
				draftContextSize: 256,
				draftMin: 1,
				draftMax: 16,
				gpuLayers: "auto",
				draftGpuLayers: "auto",
				disableThinking: true,
			},
		});
		const decision = decideBackend({
			override: "auto",
			catalog,
			llamaServerAvailable: false,
			dflashRequired: true,
		});
		expect(decision.backend).toBe("llama-server");
		expect(decision.reason).toBe("dflash-required");
	});

	it("returns default when no catalog entry is supplied", () => {
		const decision = decideBackend({
			override: "auto",
			catalog: undefined,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("llama-server");
		expect(decision.reason).toBe("default");
	});
});

class FakeBackend implements LocalInferenceBackend {
	loaded = false;
	unloads = 0;
	loadCalls: string[] = [];
	plans: Array<{ modelPath: string; overrides?: unknown }> = [];

	constructor(public readonly id: "capacitor-llama" | "llama-server") {}

	async available(): Promise<boolean> {
		return true;
	}

	async load(plan: { modelPath: string; overrides?: unknown }): Promise<void> {
		this.loaded = true;
		this.plans.push(plan);
		this.loadCalls.push(plan.modelPath);
	}

	async unload(): Promise<void> {
		this.loaded = false;
		this.unloads += 1;
	}

	async generate(): Promise<string> {
		return `${this.id}:reply`;
	}

	hasLoadedModel(): boolean {
		return this.loaded;
	}

	currentModelPath(): string | null {
		return this.loaded ? (this.loadCalls.at(-1) ?? null) : null;
	}
}

describe("BackendDispatcher", () => {
	it("loads custom llama-server by default", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-server");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
		);
		await d.load({ modelPath: "/m.gguf", catalog: BASE_CATALOG });
		expect(d.activeBackendId()).toBe("llama-server");
		expect(node.loaded).toBe(false);
		expect(server.loaded).toBe(true);
		expect(await d.generate({ prompt: "hi" })).toBe("llama-server:reply");
	});

	it("switches backends when the decision differs and unloads the previous", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-server");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
		);
		await d.load({ modelPath: "/m.gguf", catalog: BASE_CATALOG });
		expect(d.activeBackendId()).toBe("llama-server");

		const kernelCatalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["dflash"] },
		});
		await d.load({ modelPath: "/m2.gguf", catalog: kernelCatalog });
		expect(d.activeBackendId()).toBe("llama-server");
		expect(node.unloads).toBe(0);
		expect(server.loaded).toBe(true);
	});

	it("passes multimodal projector overrides through to the selected backend", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-server");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
		);
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["dflash"] },
		});

		await d.load({
			modelPath: "/m.gguf",
			catalog,
			overrides: { mmprojPath: "/bundle/vision/mmproj.gguf" },
		});

		expect(server.plans[0]?.overrides).toMatchObject({
			mmprojPath: "/bundle/vision/mmproj.gguf",
		});
	});

	it("throws on generate before load", async () => {
		const d = new BackendDispatcher(
			new FakeBackend("capacitor-llama"),
			new FakeBackend("llama-server"),
			() => true,
			() => false,
		);
		await expect(d.generate({ prompt: "x" })).rejects.toThrow(
			/No backend loaded/,
		);
	});

	it("ignores ffiStreaming when probeFfiActive is omitted", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-server");
		const ffi = new FakeBackend("llama-server");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			// probeFfiActive omitted
		);
		await d.load({ modelPath: "/m.gguf", catalog: BASE_CATALOG });
		expect(server.loaded).toBe(true);
		expect(ffi.loaded).toBe(false);
	});

	it("routes the llama-server decision to ffi backend when probe is true", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-server");
		const ffi = new FakeBackend("llama-server");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			() => true,
		);
		await d.load({ modelPath: "/m.gguf", catalog: BASE_CATALOG });
		expect(ffi.loaded).toBe(true);
		expect(server.loaded).toBe(false);
		expect(d.activeBackendId()).toBe("llama-server");
	});

	it("keeps subprocess when probe is false even with ffi backend supplied", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-server");
		const ffi = new FakeBackend("llama-server");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			() => false,
		);
		await d.load({ modelPath: "/m.gguf", catalog: BASE_CATALOG });
		expect(server.loaded).toBe(true);
		expect(ffi.loaded).toBe(false);
	});

	it("does not route to ffi when decision is capacitor-llama", async () => {
		// Force capacitor-llama via env override; ffi probe MUST not override
		// (selectBackend is a TRANSPORT decision for the llama-server branch
		// only — it does not apply to the capacitor-llama branch).
		const prev = process.env.ELIZA_LOCAL_BACKEND;
		process.env.ELIZA_LOCAL_BACKEND = "capacitor-llama";
		try {
			const node = new FakeBackend("capacitor-llama");
			const server = new FakeBackend("llama-server");
			const ffi = new FakeBackend("llama-server");
			const d = new BackendDispatcher(
				node,
				server,
				() => true,
				() => false,
				undefined,
				ffi,
				() => true,
			);
			await d.load({ modelPath: "/m.gguf", catalog: BASE_CATALOG });
			expect(node.loaded).toBe(true);
			expect(ffi.loaded).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.ELIZA_LOCAL_BACKEND;
			else process.env.ELIZA_LOCAL_BACKEND = prev;
		}
	});

	it("falls through to subprocess when no ffi backend is wired", async () => {
		// The dispatcher's behavior when `ffiStreaming`/`probeFfiActive` are
		// omitted (e.g. mobile bootstrap that only passes the 4-arg form):
		// every `decideBackend() === "llama-server"` load goes to the
		// subprocess. No throw, no env-var opt-in required.
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-server");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
		);
		await d.load({ modelPath: "/m.gguf", catalog: BASE_CATALOG });
		expect(server.loaded).toBe(true);
	});

	it("unloads ffi backend when switching to subprocess on a later load", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-server");
		const ffi = new FakeBackend("llama-server");
		let ffiActive = true;
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			() => ffiActive,
		);
		await d.load({ modelPath: "/m.gguf", catalog: BASE_CATALOG });
		expect(ffi.loaded).toBe(true);
		ffiActive = false;
		await d.load({ modelPath: "/m2.gguf", catalog: BASE_CATALOG });
		expect(ffi.unloads).toBe(1);
		expect(server.loaded).toBe(true);
	});
});

describe("LocalInferenceEngine backend fallback", () => {
	it("does not fall back when llama-server was selected for required kernels", async () => {
		const engine = new LocalInferenceEngine();
		const internals = engine as unknown as {
			dispatcher: {
				load(plan: unknown): Promise<void>;
				decide(plan: unknown): ReturnType<typeof decideBackend>;
			};
			nodeBackend: { load(plan: unknown): Promise<void> };
		};
		let nodeLoads = 0;
		internals.dispatcher.load = async () => {
			throw new Error("missing turbo3 kernel");
		};
		internals.dispatcher.decide = () => ({
			backend: "llama-server",
			reason: "kernel-required",
			kernels: ["turbo3"],
			unsatisfiedKernels: ["turbo3"],
		});
		internals.nodeBackend.load = async () => {
			nodeLoads += 1;
		};

		await expect(engine.load("/tmp/eliza-1.gguf")).rejects.toThrow(
			/missing turbo3 kernel/,
		);
		expect(nodeLoads).toBe(0);
	});

	it("still falls back when llama-server was only a soft preference", async () => {
		const engine = new LocalInferenceEngine();
		const internals = engine as unknown as {
			dispatcher: {
				load(plan: unknown): Promise<void>;
				decide(plan: unknown): ReturnType<typeof decideBackend>;
			};
			nodeBackend: { load(plan: unknown): Promise<void> };
		};
		let nodeLoads = 0;
		internals.dispatcher.load = async () => {
			throw new Error("llama-server unavailable");
		};
		internals.dispatcher.decide = () => ({
			backend: "llama-server",
			reason: "preferred-backend",
			kernels: [],
		});
		internals.nodeBackend.load = async () => {
			nodeLoads += 1;
		};

		await expect(engine.load("/tmp/soft-preference.gguf")).resolves.toBe(
			undefined,
		);
		expect(nodeLoads).toBe(1);
	});
});

describe("decideBackend kernel-availability probe", () => {
	it("returns no unsatisfiedKernels when no probe is provided (older binaries)", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["dflash"] },
		});
		const decision = decideBackend({
			override: "auto",
			catalog,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		expect(decision.unsatisfiedKernels).toBeUndefined();
	});

	it("returns empty unsatisfiedKernels when binary advertises required kernels", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["dflash", "turbo3"] },
		});
		const decision = decideBackend({
			override: "auto",
			catalog,
			llamaServerAvailable: true,
			dflashRequired: false,
			binaryKernels: { dflash: true, turbo3: true, turbo4: false },
		});
		expect(decision.unsatisfiedKernels).toEqual([]);
	});

	it("flags missing kernels when binary lacks them", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["dflash", "turbo3_tcq"] },
		});
		const decision = decideBackend({
			override: "auto",
			catalog,
			llamaServerAvailable: true,
			dflashRequired: false,
			binaryKernels: { dflash: true, turbo3_tcq: false },
		});
		expect(decision.unsatisfiedKernels).toEqual(["turbo3_tcq"]);
	});

	it("rejects load when required kernels are unsatisfied", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-server");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			() => ({ dflash: true, turbo3_tcq: false }),
		);
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["turbo3_tcq"] },
		});
		await expect(d.load({ modelPath: "/m.gguf", catalog })).rejects.toThrow(
			/turbo3_tcq.*does not advertise/,
		);
		expect(server.loaded).toBe(false);
		expect(node.loaded).toBe(false);
	});

	it("loads cleanly when probed kernels match the requirement", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-server");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			() => ({ dflash: true, turbo3: true }),
		);
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["dflash"] },
		});
		await d.load({ modelPath: "/m.gguf", catalog });
		expect(d.activeBackendId()).toBe("llama-server");
	});
});
