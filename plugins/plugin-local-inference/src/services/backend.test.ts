// Coverage for the pure backend-routing decision (#8848). decideBackend is the
// optimization-kernel enforcement point: a catalog model declares the fused
// kernels it requires (turbo/qjl/polarquant/…), and the dispatcher computes
// which of them the installed binary's CAPABILITIES.json does NOT satisfy so the
// caller can tell the operator to rebuild instead of letting the model silently
// run de-optimized. These branches gate that contract, so they are pinned here.

import type { CatalogModel } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { decideBackend } from "./backend";

/** Minimal CatalogModel carrying only the requiresKernel field decideBackend reads. */
function catalog(requiresKernel: string[]): CatalogModel {
	return {
		runtime: { optimizations: { requiresKernel } },
	} as unknown as CatalogModel;
}

describe("decideBackend", () => {
	it("routes to llama-cpp with reason=env-override when forced, regardless of kernels", () => {
		const d = decideBackend({
			override: "llama-cpp",
			catalog: catalog(["turbo3"]),
			llamaCppAvailable: true,
		});
		expect(d.backend).toBe("llama-cpp");
		expect(d.reason).toBe("env-override");
		expect(d.kernels).toEqual(["turbo3"]);
	});

	it("uses reason=default for a model with no required kernels", () => {
		const d = decideBackend({
			override: "auto",
			catalog: undefined,
			llamaCppAvailable: true,
		});
		expect(d.reason).toBe("default");
		expect(d.kernels).toEqual([]);
		expect(d.unsatisfiedKernels).toBeUndefined();
	});

	it("uses reason=kernel-required when the catalog declares required kernels", () => {
		const d = decideBackend({
			override: "auto",
			catalog: catalog(["turbo3", "qjl_full"]),
			llamaCppAvailable: true,
		});
		expect(d.reason).toBe("kernel-required");
		expect(d.kernels).toEqual(["turbo3", "qjl_full"]);
		// No CAPABILITIES probe → trust the declaration, defer to load attempt.
		expect(d.unsatisfiedKernels).toBeUndefined();
	});

	it("flags the required kernels the installed binary does not satisfy", () => {
		const d = decideBackend({
			override: "auto",
			catalog: catalog(["turbo3", "qjl_full"]),
			llamaCppAvailable: true,
			binaryKernels: { turbo3: true, qjl_full: false },
		});
		// turbo3 satisfied, qjl_full not → operator must rebuild for qjl_full.
		expect(d.unsatisfiedKernels).toEqual(["qjl_full"]);
	});

	it("reports an empty unsatisfied set when every required kernel is present", () => {
		const d = decideBackend({
			override: "auto",
			catalog: catalog(["turbo3"]),
			llamaCppAvailable: true,
			binaryKernels: { turbo3: true },
		});
		expect(d.unsatisfiedKernels).toEqual([]);
	});

	it("treats a kernel missing from the probe as unsatisfied (not silently ok)", () => {
		const d = decideBackend({
			override: "auto",
			catalog: catalog(["turbo3", "polarquant"]),
			llamaCppAvailable: true,
			binaryKernels: { turbo3: true }, // polarquant absent from the map
		});
		expect(d.unsatisfiedKernels).toEqual(["polarquant"]);
	});
});
