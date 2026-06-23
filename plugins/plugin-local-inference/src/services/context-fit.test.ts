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
});
