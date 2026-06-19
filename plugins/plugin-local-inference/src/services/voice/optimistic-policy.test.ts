import { describe, expect, it } from "vitest";
import {
	DEFAULT_OPTIMISTIC_EOT_THRESHOLD,
	OptimisticGenerationPolicy,
	resolveOptimisticPolicyEnabled,
} from "./optimistic-policy";

describe("resolveOptimisticPolicyEnabled — pure", () => {
	it("override:true wins regardless of power source", () => {
		expect(
			resolveOptimisticPolicyEnabled({
				powerSource: "battery",
				override: true,
			}),
		).toBe(true);
	});

	it("override:false wins regardless of power source", () => {
		expect(
			resolveOptimisticPolicyEnabled({
				powerSource: "plugged-in",
				override: false,
			}),
		).toBe(false);
	});

	it("battery without override → false", () => {
		expect(resolveOptimisticPolicyEnabled({ powerSource: "battery" })).toBe(
			false,
		);
	});

	it("plugged-in without override → true", () => {
		expect(resolveOptimisticPolicyEnabled({ powerSource: "plugged-in" })).toBe(
			true,
		);
	});

	it("unknown power source defaults to true", () => {
		expect(resolveOptimisticPolicyEnabled({ powerSource: "unknown" })).toBe(
			true,
		);
		expect(resolveOptimisticPolicyEnabled({})).toBe(true);
	});
});

describe("OptimisticGenerationPolicy", () => {
	it("defaults: enabled, threshold = DEFAULT", () => {
		const p = new OptimisticGenerationPolicy();
		expect(p.enabled()).toBe(true);
		expect(p.threshold).toBe(DEFAULT_OPTIMISTIC_EOT_THRESHOLD);
	});

	it("battery flips enabled() to false", () => {
		const p = new OptimisticGenerationPolicy();
		p.setPowerSource("battery");
		expect(p.enabled()).toBe(false);
	});

	it("explicit override true wins on battery", () => {
		const p = new OptimisticGenerationPolicy();
		p.setPowerSource("battery");
		p.setOverride(true);
		expect(p.enabled()).toBe(true);
	});

	it("override:false wins on plugged-in", () => {
		const p = new OptimisticGenerationPolicy();
		p.setPowerSource("plugged-in");
		p.setOverride(false);
		expect(p.enabled()).toBe(false);
	});

	it("shouldStartOptimisticLm gates on EOT threshold", () => {
		const p = new OptimisticGenerationPolicy({ eotThreshold: 0.7 });
		expect(p.shouldStartOptimisticLm(0.5)).toBe(false);
		expect(p.shouldStartOptimisticLm(0.7)).toBe(true);
		expect(p.shouldStartOptimisticLm(0.95)).toBe(true);
	});

	it("shouldStartOptimisticLm returns false when disabled regardless of probability", () => {
		const p = new OptimisticGenerationPolicy();
		p.setPowerSource("battery");
		expect(p.shouldStartOptimisticLm(0.99)).toBe(false);
	});

	it("override clears back to default with undefined", () => {
		const p = new OptimisticGenerationPolicy();
		p.setOverride(false);
		expect(p.enabled()).toBe(false);
		p.setOverride(undefined);
		expect(p.enabled()).toBe(true);
	});

	it("constructor defaultEnabled=false flips the base policy", () => {
		const p = new OptimisticGenerationPolicy({ defaultEnabled: false });
		expect(p.enabled()).toBe(false);
		p.setOverride(true);
		expect(p.enabled()).toBe(true);
	});
});
