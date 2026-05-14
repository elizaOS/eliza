/**
 * DFlash backend selection per Eliza-1 tier.
 *
 * Every Eliza-1 tier declares `runtime.preferredBackend = "llama-server"`
 * and `runtime.optimizations.requiresKernel` includes "dflash". The dispatcher
 * MUST honour both: the speculative-decoding fork ships in llama-server, not
 * in the in-process node-llama-cpp binding. Mis-selecting `node-llama-cpp`
 * here would silently lose DFlash and the TurboQuant / QJL / PolarQuant KV
 * kernels — every Eliza-1 turn would run on stock f16 with no draft model.
 *
 * This test proves the catalog → dispatcher round-trip per tier:
 *   - catalog tier resolves to a catalog entry,
 *   - `decideBackend(...)` picks "llama-server",
 *   - the reason is "kernel-required" (the dflash kernel is in
 *     `requiresKernel`), NOT "preferred-backend" (the soft hint),
 *   - the dflash drafter config is present and points back to the
 *     companion drafter id.
 *
 * Together with the existing `backend.test.ts` (which covers the decision
 * function with synthetic catalogs) and `catalog.test.ts` (which pins the
 * tier-level `preferredBackend` + `requiresKernel`), this test pins the
 * runtime contract for the whole tier set.
 */
import { describe, expect, it } from "vitest";
import {
	decideBackend,
	type BackendDecision,
} from "../src/services/backend.ts";
import { findCatalogModel } from "../src/services/catalog.ts";
import { ELIZA_1_TIER_IDS } from "../src/services/catalog.ts";

function decideForTier(
	tierId: string,
	opts?: {
		llamaServerAvailable?: boolean;
		dflashRequired?: boolean;
		binaryKernels?: Partial<Record<string, boolean>> | null;
	},
): BackendDecision {
	const catalog = findCatalogModel(tierId);
	if (!catalog) {
		throw new Error(`tier "${tierId}" missing from MODEL_CATALOG`);
	}
	return decideBackend({
		override: "auto",
		catalog,
		llamaServerAvailable: opts?.llamaServerAvailable ?? true,
		dflashRequired: opts?.dflashRequired ?? false,
		binaryKernels: opts?.binaryKernels ?? null,
	});
}

describe("DFlash backend selection (catalog tiers → dispatcher)", () => {
	for (const tierId of ELIZA_1_TIER_IDS) {
		describe(tierId, () => {
			it("resolves to a catalog entry", () => {
				expect(findCatalogModel(tierId)).toBeTruthy();
			});

			it("decides llama-server with reason=kernel-required (dflash kernel is hard-required)", () => {
				const decision = decideForTier(tierId);
				expect(decision.backend, `${tierId} backend`).toBe("llama-server");
				expect(decision.reason, `${tierId} reason`).toBe("kernel-required");
				expect(decision.kernels, `${tierId} kernels`).toContain("dflash");
			});

			it("decides llama-server even when llama-server binary appears unavailable (dflashRequired wins)", () => {
				// The dispatcher routes to llama-server when DFlash is required
				// even if the availability probe is false — the load itself is
				// expected to fail with a clear "rebuild your binary" surface;
				// silently falling back to node-llama-cpp would drop DFlash and
				// the KV-cache kernels.
				const decision = decideForTier(tierId, {
					llamaServerAvailable: false,
					dflashRequired: true,
				});
				expect(decision.backend).toBe("llama-server");
			});

			it("pairs with a drafter that lives in the same catalog under id `${tier}-drafter`", () => {
				const target = findCatalogModel(tierId);
				expect(target?.runtime?.dflash?.drafterModelId).toBe(
					`${tierId}-drafter`,
				);
				expect(target?.companionModelIds).toContain(`${tierId}-drafter`);
				const drafter = findCatalogModel(`${tierId}-drafter`);
				expect(drafter, `${tierId}-drafter missing`).toBeTruthy();
				expect(drafter?.hiddenFromCatalog).toBe(true);
				expect(drafter?.runtimeRole).toBe("dflash-drafter");
			});

			it("flags unsatisfied kernels when CAPABILITIES.json says dflash is false", () => {
				const decision = decideForTier(tierId, {
					binaryKernels: { dflash: false, turbo3: true },
				});
				expect(decision.unsatisfiedKernels).toContain("dflash");
				// Still routes to llama-server — silently falling back is what
				// would hide the missing kernel from the operator.
				expect(decision.backend).toBe("llama-server");
			});

			it("declares the long-context KV-cache kernels too (turbo3_tcq when contextLength >= 65536)", () => {
				const target = findCatalogModel(tierId);
				const ctx = target?.contextLength ?? 0;
				if (ctx >= 65536) {
					expect(target?.runtime?.optimizations?.requiresKernel).toContain(
						"turbo3_tcq",
					);
				}
			});
		});
	}
});

describe("DFlash backend selection — env override sanity", () => {
	it("ELIZA_LOCAL_BACKEND=node-llama-cpp is still overridden by the required kernel set", () => {
		const decision = decideBackend({
			override: "node-llama-cpp",
			catalog: findCatalogModel("eliza-1-2b"),
			llamaServerAvailable: true,
			dflashRequired: false,
		});
		// Operator can't ask the in-process binding to run dflash — the
		// hard requirement wins and the dispatcher still picks llama-server.
		expect(decision.backend).toBe("llama-server");
		expect(decision.reason).toBe("kernel-required");
	});
});
