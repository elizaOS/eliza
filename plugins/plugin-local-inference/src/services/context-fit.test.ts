/** Unit tests for `computeRuntimeContextFit`: context-window sizing under RAM budgets and the opt-in f16-KV precision upgrade. Deterministic. */
import { describe, expect, it } from "vitest";
import { computeRuntimeContextFit } from "./context-fit";

describe("computeRuntimeContextFit", () => {
	it("shrinks context to the largest 4k window that fits the q8_0 KV budget", () => {
		const fit = computeRuntimeContextFit({
			params: "2B",
			weightMb: 1434,
			usableMb: 2560,
			nativeContext: 131072,
		});

		expect(fit).not.toBeNull();
		expect(fit?.contextDownscaled).toBe(true);
		expect(fit?.contextSize).toBeGreaterThanOrEqual(8192);
		expect(fit?.contextSize).toBeLessThan(131072);
		expect(fit?.contextSize % 4096).toBe(0);
		expect(fit?.kvBytesPerToken).toBeGreaterThan(0);
	});

	it("keeps the native context when the KV budget has headroom", () => {
		const fit = computeRuntimeContextFit({
			params: "9B",
			weightMb: 5529,
			usableMb: 23 * 1024,
			nativeContext: 131072,
		});

		expect(fit?.contextSize).toBe(131072);
		expect(fit?.contextDownscaled).toBe(false);
		expect(fit?.maxFittingContext).toBeGreaterThanOrEqual(131072);
	});

	it("returns null when not even the minimum local context fits", () => {
		const fit = computeRuntimeContextFit({
			params: "2B",
			weightMb: 2200,
			usableMb: 2300,
			nativeContext: 131072,
		});

		expect(fit).toBeNull();
	});

	it("defaults to q8_0 KV", () => {
		const fit = computeRuntimeContextFit({
			params: "9B",
			weightMb: 5529,
			usableMb: 64 * 1024,
			nativeContext: 131072,
		});
		expect(fit?.kvQuant).toBe("q8_0");
	});

	it("upgrades to f16 KV when there's headroom and it's opted in (#8809 AC#4)", () => {
		const fit = computeRuntimeContextFit({
			params: "9B",
			weightMb: 5529,
			usableMb: 64 * 1024,
			nativeContext: 131072,
			preferAccurateKvWhenHeadroom: true,
		});
		expect(fit?.kvQuant).toBe("f16");
		// f16 still affords the full native window on a roomy host.
		expect(fit?.contextSize).toBe(131072);
		expect(fit?.contextDownscaled).toBe(false);
	});

	it("never trades context for f16 KV precision (stays q8_0 when f16 would shrink the window)", () => {
		// kvBudget here lets q8_0 reach the full native window but f16 (≈1.88×)
		// would not — so the opt-in must keep q8_0 rather than downscale context.
		const fit = computeRuntimeContextFit({
			params: "9B",
			weightMb: 5529,
			usableMb: 8053,
			nativeContext: 131072,
			preferAccurateKvWhenHeadroom: true,
		});
		expect(fit?.contextSize).toBe(131072);
		expect(fit?.kvQuant).toBe("q8_0");
	});

	it("scales the selected context with the device RAM class (4/8/16/24/128 GB) (#8809 AC#4)", () => {
		// One representative tier across the five canonical device classes.
		// `weightMb` is the resident weight; `usableMb` is the post-headroom
		// budget the caller (active-model.ts) passes. The q8_0 KV rate comes from
		// the tier params, so the selected window tracks free RAM.
		const deviceClassesGb = [4, 8, 16, 24, 128];
		const fits = deviceClassesGb.map((gb) =>
			computeRuntimeContextFit({
				params: "9B",
				weightMb: 6500,
				usableMb: gb * 1024,
				nativeContext: 131072,
			}),
		);

		// 4 GB can't hold the weights + a minimum KV window → no fit.
		expect(fits[0]).toBeNull();

		// Every class that fits gets a 4k-aligned window within [min, native].
		for (const fit of fits.slice(1)) {
			expect(fit).not.toBeNull();
			expect((fit?.contextSize ?? 0) % 4096).toBe(0);
			expect(fit?.contextSize).toBeGreaterThanOrEqual(8192);
			expect(fit?.contextSize).toBeLessThanOrEqual(131072);
		}

		// Context never shrinks as RAM grows (headroom → larger KV window).
		const sizes = fits.map((f) => f?.contextSize ?? 0);
		for (let i = 1; i < sizes.length; i++) {
			expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
		}

		// Tight-but-fitting (8 GB) downscales below native; roomy (128 GB) hits it.
		expect(fits[1]?.contextDownscaled).toBe(true);
		expect(fits[1]?.contextSize).toBeLessThan(131072);
		expect(fits.at(-1)?.contextSize).toBe(131072);
		expect(fits.at(-1)?.contextDownscaled).toBe(false);
	});
});
