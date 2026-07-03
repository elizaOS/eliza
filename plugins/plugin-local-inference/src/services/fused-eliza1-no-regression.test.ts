/**
 * #8808 acceptance criterion 4 — fused eliza-1 no-regression.
 *
 * The local stack is Eliza-1 only (#8808 cutover), so serving is deterministic.
 * This test pins the invariants:
 *   - `decideBackend` / `BackendDispatcher` route a `runtimeClass:"fused-eliza1"`
 *     model to the fused `llama-cpp` runtime,
 *   - the fused path retains its full-pipeline binding: the `BackendPlan` that
 *     reaches the fused backend still carries the catalog entry and the
 *     bundle-root override that `DesktopFusedFfiBackendRuntime.acquire()` reads
 *     to anchor the fused context.
 *
 * It complements `backend-runtime-class.test.ts` (which proves the binary
 * routing) by asserting that the FULL fused load contract is forwarded intact.
 */

import { describe, expect, it } from "vitest";

import {
	BackendDispatcher,
	type BackendPlan,
	decideBackend,
	type GenerateArgs,
	type GenerateResult,
	type LocalInferenceBackend,
} from "./backend";
import { findCatalogModel } from "./catalog";
import type { CatalogModel } from "./types";

const FUSED_TIER = findCatalogModel("eliza-1-4b") as CatalogModel;

function makeBackend(id: LocalInferenceBackend["id"]): LocalInferenceBackend & {
	loaded: BackendPlan[];
} {
	const loaded: BackendPlan[] = [];
	return {
		id,
		loaded,
		available: async () => true,
		load: async (plan: BackendPlan) => {
			loaded.push(plan);
		},
		unload: async () => {},
		generate: async (_args: GenerateArgs): Promise<GenerateResult> => "ok",
		hasLoadedModel: () => loaded.length > 0,
		currentModelPath: () => loaded.at(-1)?.modelPath ?? null,
	};
}

describe("fused eliza-1 no-regression (C4)", () => {
	it("the catalog tier under test really is a fused-eliza1 tier", () => {
		expect(FUSED_TIER).toBeTruthy();
		expect(FUSED_TIER.runtimeClass).toBe("fused-eliza1");
		// 4b hosts the gemma4-assistant separate drafter (2026-07-02).
		expect(FUSED_TIER.runtime?.mtp?.specType).toBe("draft-mtp");
		expect(FUSED_TIER.runtime?.mtp?.drafterFile).toBe("mtp/drafter-4b.gguf");
	});

	it("decideBackend routes a fused Eliza-1 tier to the fused llama-cpp runtime", () => {
		const decision = decideBackend({
			override: "auto",
			catalog: FUSED_TIER,
			llamaCppAvailable: true,
		});
		expect(decision.backend).toBe("llama-cpp");
	});

	it("decideBackend routes everything to llama-cpp — the stack is Eliza-1 only", () => {
		// Post-#8808 cutover: there is no generic-gguf backend; every model
		// (even an unknown catalog entry) routes to the fused llama-cpp runtime.
		const decision = decideBackend({
			override: "auto",
			catalog: undefined,
			llamaCppAvailable: true,
		});
		expect(decision.backend).toBe("llama-cpp");
	});

	it("dispatcher forwards the fused full-pipeline binding (catalog + bundleRoot) to the fused backend", async () => {
		const ffi = makeBackend("llama-cpp");
		const dispatcher = new BackendDispatcher(
			ffi,
			() => true,
			() => null,
		);

		const bundleRoot = "/models/eliza-1-4b";
		const plan: BackendPlan = {
			modelPath: `${bundleRoot}/text/eliza-1-4b-128k.gguf`,
			modelId: "eliza-1-4b",
			catalog: FUSED_TIER,
			runtimeClass: "fused-eliza1",
			overrides: {
				bundleRoot,
				draftModelPath: `${bundleRoot}/text/eliza-1-4b-mtp.gguf`,
				gpuLayers: "max",
				cacheTypeK: "tbq4_0",
				cacheTypeV: "tbq3_0",
			},
		};

		await dispatcher.load(plan);

		// Routed to the fused runtime.
		expect(ffi.loaded).toHaveLength(1);
		expect(dispatcher.activeBackendId()).toBe("llama-cpp");

		// The full-pipeline binding survives dispatch: the fused backend receives
		// the same catalog entry plus the bundle-root and explicit drafter
		// overrides that anchor the fused context and preserve fork KV-cache
		// kernel settings.
		const forwarded = ffi.loaded[0];
		expect(forwarded.catalog).toBe(FUSED_TIER);
		expect(forwarded.catalog?.runtime?.mtp?.specType).toBe("draft-mtp");
		expect(forwarded.overrides?.bundleRoot).toBe(bundleRoot);
		expect(forwarded.overrides?.draftModelPath).toBe(
			`${bundleRoot}/text/eliza-1-4b-mtp.gguf`,
		);
		expect(forwarded.overrides?.cacheTypeK).toBe("tbq4_0");
		expect(forwarded.overrides?.cacheTypeV).toBe("tbq3_0");
	});

	it("env-override=llama-cpp keeps a fused tier on the fused path", async () => {
		const prev = process.env.ELIZA_INFERENCE_BACKEND;
		process.env.ELIZA_INFERENCE_BACKEND = "llama-cpp";
		try {
			const ffi = makeBackend("llama-cpp");
			const dispatcher = new BackendDispatcher(
				ffi,
				() => true,
				() => null,
			);
			const decision = dispatcher.decide({
				modelPath: "/models/eliza-1-4b/text/eliza-1-4b-128k.gguf",
				modelId: "eliza-1-4b",
				catalog: FUSED_TIER,
				runtimeClass: "fused-eliza1",
			});
			expect(decision.backend).toBe("llama-cpp");
			expect(decision.reason).toBe("env-override");
		} finally {
			if (prev === undefined) delete process.env.ELIZA_INFERENCE_BACKEND;
			else process.env.ELIZA_INFERENCE_BACKEND = prev;
		}
	});
});
