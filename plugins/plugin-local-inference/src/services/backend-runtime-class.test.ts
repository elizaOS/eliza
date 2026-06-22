import { describe, expect, it, vi } from "vitest";

import {
	BackendDispatcher,
	type BackendPlan,
	decideBackend,
	type GenerateArgs,
	type GenerateResult,
	GenericRuntimeUnavailableError,
	type LocalInferenceBackend,
} from "./backend";
import { findCatalogModel } from "./catalog";
import type { CatalogModel } from "./types";

const ELIZA_1_TIER = findCatalogModel("eliza-1-4b") as CatalogModel;

function genericCatalog(): CatalogModel {
	return {
		id: "hf:meta-llama/Llama-3.2-3B-Instruct-GGUF::Llama-3.2-3B-Instruct-Q4_K_M.gguf",
		displayName: "Llama-3.2-3B-Instruct",
		hfRepo: "meta-llama/Llama-3.2-3B-Instruct-GGUF",
		ggufFile: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
		params: "3B",
		quant: "Q4_K_M",
		sizeGb: 2,
		minRamGb: 4,
		category: "chat",
		bucket: "small",
		runtimeClass: "generic-gguf",
		blurb: "generic GGUF",
	};
}

/** Minimal `LocalInferenceBackend` spy that records load() calls. */
function makeBackend(id: LocalInferenceBackend["id"]): LocalInferenceBackend {
	const loaded: BackendPlan[] = [];
	return {
		id,
		available: async () => true,
		load: async (plan: BackendPlan) => {
			loaded.push(plan);
		},
		unload: async () => {},
		generate: async (_args: GenerateArgs): Promise<GenerateResult> => "ok",
		hasLoadedModel: () => loaded.length > 0,
		currentModelPath: () => loaded.at(-1)?.modelPath ?? null,
		// expose for assertions
		...({ __loaded: loaded } as Record<string, unknown>),
	};
}

function loadedPlans(backend: LocalInferenceBackend): BackendPlan[] {
	return (backend as unknown as { __loaded: BackendPlan[] }).__loaded;
}

describe("decideBackend runtime-class branching", () => {
	it("routes a fused Eliza-1 tier to the llama-cpp (fused) backend", () => {
		const decision = decideBackend({
			override: "auto",
			catalog: ELIZA_1_TIER,
			llamaCppAvailable: true,
		});
		expect(decision.runtimeClass).toBe("fused-eliza1");
		expect(decision.backend).toBe("llama-cpp");
	});

	it("routes a generic catalog GGUF to the generic-gguf backend", () => {
		const decision = decideBackend({
			override: "auto",
			catalog: genericCatalog(),
			llamaCppAvailable: true,
		});
		expect(decision.runtimeClass).toBe("generic-gguf");
		expect(decision.backend).toBe("generic-gguf");
		expect(decision.reason).toBe("generic-gguf");
	});

	it("honours an explicit registry runtimeClass over the catalog", () => {
		// No catalog entry (external blob): the registry-derived class is the
		// only signal, and it must NOT be string-matched off the id.
		const decision = decideBackend({
			override: "auto",
			catalog: undefined,
			runtimeClass: "generic-gguf",
			llamaCppAvailable: true,
		});
		expect(decision.backend).toBe("generic-gguf");
	});

	it("does NOT force a generic model onto the fused path even under env-override", () => {
		const decision = decideBackend({
			override: "llama-cpp",
			catalog: genericCatalog(),
			llamaCppAvailable: true,
		});
		// The fused lib is bundle-locked to the Eliza-1 vocab; the override only
		// applies to fused models.
		expect(decision.backend).toBe("generic-gguf");
	});

	it("env-override keeps a fused model on the fused path", () => {
		const decision = decideBackend({
			override: "llama-cpp",
			catalog: ELIZA_1_TIER,
			llamaCppAvailable: true,
		});
		expect(decision.backend).toBe("llama-cpp");
		expect(decision.reason).toBe("env-override");
	});

	it("treats an unplaceable model (no catalog, no class) as generic", () => {
		const decision = decideBackend({
			override: "auto",
			catalog: undefined,
			llamaCppAvailable: true,
		});
		expect(decision.backend).toBe("generic-gguf");
	});
});

describe("BackendDispatcher routes load by runtime class", () => {
	it("loads a fused Eliza-1 plan through the FFI backend", async () => {
		const ffi = makeBackend("llama-cpp");
		const generic = makeBackend("generic-gguf");
		const dispatcher = new BackendDispatcher(
			ffi,
			() => true,
			() => null,
			generic,
		);
		await dispatcher.load({
			modelPath: "/models/eliza-1-4b/text/eliza-1-4b-128k.gguf",
			modelId: "eliza-1-4b",
			catalog: ELIZA_1_TIER,
			runtimeClass: "fused-eliza1",
		});
		expect(loadedPlans(ffi)).toHaveLength(1);
		expect(loadedPlans(generic)).toHaveLength(0);
		expect(dispatcher.activeBackendId()).toBe("llama-cpp");
	});

	it("loads a generic GGUF plan through the generic backend", async () => {
		const ffi = makeBackend("llama-cpp");
		const generic = makeBackend("generic-gguf");
		const dispatcher = new BackendDispatcher(
			ffi,
			() => true,
			() => null,
			generic,
		);
		await dispatcher.load({
			modelPath: "/models/llama-3.2-3b.gguf",
			runtimeClass: "generic-gguf",
		});
		expect(loadedPlans(generic)).toHaveLength(1);
		expect(loadedPlans(ffi)).toHaveLength(0);
		expect(dispatcher.activeBackendId()).toBe("generic-gguf");
	});

	it("throws a typed error when a generic model has no generic runtime", async () => {
		const ffi = makeBackend("llama-cpp");
		const dispatcher = new BackendDispatcher(
			ffi,
			() => true,
			() => null,
			null, // no generic runtime on this host (desktop today)
		);
		await expect(
			dispatcher.load({
				modelPath: "/models/llama-3.2-3b.gguf",
				runtimeClass: "generic-gguf",
			}),
		).rejects.toBeInstanceOf(GenericRuntimeUnavailableError);
		expect(loadedPlans(ffi)).toHaveLength(0);
	});

	it("throws the typed error when the generic runtime reports unavailable", async () => {
		const ffi = makeBackend("llama-cpp");
		const generic = makeBackend("generic-gguf");
		generic.available = vi.fn(async () => false);
		const dispatcher = new BackendDispatcher(
			ffi,
			() => true,
			() => null,
			generic,
		);
		await expect(
			dispatcher.load({
				modelPath: "/models/llama-3.2-3b.gguf",
				runtimeClass: "generic-gguf",
			}),
		).rejects.toBeInstanceOf(GenericRuntimeUnavailableError);
		expect(loadedPlans(generic)).toHaveLength(0);
	});
});
