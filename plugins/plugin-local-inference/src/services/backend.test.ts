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
	for (const key of Object.keys(process.env)) {
		if (!(key in ORIGINAL_ENV)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		process.env[key] = value;
	}
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

const OPTIMIZED_CATALOG = withRuntime(BASE_CATALOG, {
	preferredBackend: "llama-cpp",
	mtp: {
		specType: "draft-mtp",
		draftMin: 1,
		draftMax: 4,
		gpuLayers: "auto",
	},
});

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
		process.env.ELIZA_LOCAL_BACKEND = "llama-cpp";
		expect(readBackendOverride()).toBe("llama-cpp");
		process.env.ELIZA_LOCAL_BACKEND = "llama-server";
		expect(readBackendOverride()).toBe("auto");
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
	it("defaults to optimized llama.cpp when available", () => {
		const decision = decideBackend({
			override: "auto",
			catalog: OPTIMIZED_CATALOG,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("llama-cpp");
		expect(decision.reason).toBe("preferred-backend");
	});

	it("defaults to capacitor-llama for plain catalog models", () => {
		const decision = decideBackend({
			override: "auto",
			catalog: BASE_CATALOG,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("capacitor-llama");
		expect(decision.reason).toBe("default");
	});

	it("routes to optimized llama.cpp when a kernel is required", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["dflash"] },
		});
		const decision = decideBackend({
			override: "auto",
			catalog,
			llamaServerAvailable: false,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("llama-cpp");
		expect(decision.reason).toBe("kernel-required");
		expect(decision.kernels).toEqual(["dflash"]);
	});

	it("env override wins over default", () => {
		const decision = decideBackend({
			override: "llama-cpp",
			catalog: BASE_CATALOG,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("llama-cpp");
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
		expect(decision.backend).toBe("llama-cpp");
		expect(decision.reason).toBe("kernel-required");
	});

	it("respects preferredBackend=llama-cpp when runtime available", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			preferredBackend: "llama-cpp",
		});
		const decision = decideBackend({
			override: "auto",
			catalog,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("llama-cpp");
		expect(decision.reason).toBe("preferred-backend");
	});

	it("falls back to capacitor-llama when preferredBackend=llama-cpp but runtime missing and DFlash not required", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			preferredBackend: "llama-cpp",
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

	it("forces optimized llama.cpp when DFlash is required and configured, even if runtime probe is false", () => {
		const catalog = withRuntime(BASE_CATALOG, {
			preferredBackend: "llama-cpp",
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
		expect(decision.backend).toBe("llama-cpp");
		expect(decision.reason).toBe("dflash-required");
	});

	it("returns capacitor-llama default when no catalog entry is supplied", () => {
		const decision = decideBackend({
			override: "auto",
			catalog: undefined,
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		expect(decision.backend).toBe("capacitor-llama");
		expect(decision.reason).toBe("default");
	});
});

class FakeBackend implements LocalInferenceBackend {
	loaded = false;
	unloads = 0;
	loadCalls: string[] = [];
	plans: Array<{ modelPath: string; overrides?: unknown }> = [];

	constructor(public readonly id: "capacitor-llama" | "llama-cpp") {}

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
	it("loads optimized llama.cpp by default", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-cpp");
		const ffi = new FakeBackend("llama-cpp");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			() => true,
		);
		await d.load({ modelPath: "/m.gguf", catalog: OPTIMIZED_CATALOG });
		expect(d.activeBackendId()).toBe("llama-cpp");
		expect(node.loaded).toBe(false);
		expect(server.loaded).toBe(false);
		expect(ffi.loaded).toBe(true);
		expect(await d.generate({ prompt: "hi" })).toBe("llama-cpp:reply");
	});

	it("switches backends when the decision differs and unloads the previous", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-cpp");
		const ffi = new FakeBackend("llama-cpp");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			() => true,
		);
		await d.load({ modelPath: "/m.gguf", catalog: OPTIMIZED_CATALOG });
		expect(d.activeBackendId()).toBe("llama-cpp");

		const kernelCatalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["turbo3"] },
		});
		await d.load({ modelPath: "/m2.gguf", catalog: kernelCatalog });
		expect(d.activeBackendId()).toBe("llama-cpp");
		expect(node.unloads).toBe(0);
		expect(server.loaded).toBe(false);
		expect(ffi.loaded).toBe(true);
	});

	it("passes multimodal projector overrides through to the selected backend", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-cpp");
		const ffi = new FakeBackend("llama-cpp");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			() => true,
		);
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["turbo3"] },
		});

		await d.load({
			modelPath: "/m.gguf",
			catalog,
			overrides: { mmprojPath: "/bundle/vision/mmproj.gguf" },
		});

		expect(ffi.plans[0]?.overrides).toMatchObject({
			mmprojPath: "/bundle/vision/mmproj.gguf",
		});
	});

	it("throws on generate before load", async () => {
		const d = new BackendDispatcher(
			new FakeBackend("capacitor-llama"),
			new FakeBackend("llama-cpp"),
			() => true,
			() => false,
		);
		await expect(d.generate({ prompt: "x" })).rejects.toThrow(
			/No backend loaded/,
		);
	});

	it("rejects optimized llama.cpp loads when probeFfiActive is omitted", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-cpp");
		const ffi = new FakeBackend("llama-cpp");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			// probeFfiActive omitted
		);
		await expect(
			d.load({ modelPath: "/m.gguf", catalog: OPTIMIZED_CATALOG }),
		).rejects.toThrow(/in-process FFI backend/);
		expect(server.loaded).toBe(false);
		expect(ffi.loaded).toBe(false);
	});

	it("routes the optimized llama.cpp decision to ffi backend when probe is true", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-cpp");
		const ffi = new FakeBackend("llama-cpp");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			() => true,
		);
		await d.load({ modelPath: "/m.gguf", catalog: OPTIMIZED_CATALOG });
		expect(ffi.loaded).toBe(true);
		expect(server.loaded).toBe(false);
		expect(d.activeBackendId()).toBe("llama-cpp");
	});

	it("rejects optimized llama.cpp loads when the FFI probe is false", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-cpp");
		const ffi = new FakeBackend("llama-cpp");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			() => false,
		);
		await expect(
			d.load({ modelPath: "/m.gguf", catalog: OPTIMIZED_CATALOG }),
		).rejects.toThrow(/in-process FFI backend/);
		expect(server.loaded).toBe(false);
		expect(ffi.loaded).toBe(false);
	});

	it("does not route to ffi when decision is capacitor-llama", async () => {
		// Force capacitor-llama via env override; ffi probe MUST not override
		// (selectBackend is a transport decision for the optimized llama.cpp branch
		// only — it does not apply to the capacitor-llama branch).
		const prev = process.env.ELIZA_LOCAL_BACKEND;
		process.env.ELIZA_LOCAL_BACKEND = "capacitor-llama";
		try {
			const node = new FakeBackend("capacitor-llama");
			const server = new FakeBackend("llama-cpp");
			const ffi = new FakeBackend("llama-cpp");
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

	it("throws when no ffi backend is wired", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-cpp");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
		);
		await expect(
			d.load({ modelPath: "/m.gguf", catalog: OPTIMIZED_CATALOG }),
		).rejects.toThrow(/in-process FFI backend/);
		expect(server.loaded).toBe(false);
	});

	it("unloads ffi backend when switching to capacitor-llama on a later load", async () => {
		const node = new FakeBackend("capacitor-llama");
		const server = new FakeBackend("llama-cpp");
		const ffi = new FakeBackend("llama-cpp");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			undefined,
			ffi,
			() => true,
		);
		await d.load({ modelPath: "/m.gguf", catalog: OPTIMIZED_CATALOG });
		expect(ffi.loaded).toBe(true);
		const prev = process.env.ELIZA_LOCAL_BACKEND;
		process.env.ELIZA_LOCAL_BACKEND = "capacitor-llama";
		try {
			await d.load({ modelPath: "/m2.gguf", catalog: BASE_CATALOG });
			expect(ffi.unloads).toBe(1);
			expect(node.loaded).toBe(true);
			expect(server.loaded).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.ELIZA_LOCAL_BACKEND;
			else process.env.ELIZA_LOCAL_BACKEND = prev;
		}
	});
});

describe("LocalInferenceEngine backend fallback", () => {
	it("does not fall back when optimized llama.cpp was selected for required kernels", async () => {
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
			backend: "llama-cpp",
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

	it("still falls back when optimized llama.cpp was only a soft preference", async () => {
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
			backend: "llama-cpp",
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
		const server = new FakeBackend("llama-cpp");
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
		const server = new FakeBackend("llama-cpp");
		const ffi = new FakeBackend("llama-cpp");
		const d = new BackendDispatcher(
			node,
			server,
			() => true,
			() => false,
			() => ({ dflash: true, turbo3: true }),
			ffi,
			() => true,
		);
		const catalog = withRuntime(BASE_CATALOG, {
			optimizations: { requiresKernel: ["turbo3"] },
		});
		await d.load({ modelPath: "/m.gguf", catalog });
		expect(d.activeBackendId()).toBe("llama-cpp");
		expect(ffi.loaded).toBe(true);
		expect(server.loaded).toBe(false);
	});
});
