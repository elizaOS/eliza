/**
 * Exercises action and provider spec helpers against generated catalog tables.
 * Pure deterministic lookup and error verification with no live runtime.
 */
import { describe, expect, it } from "vitest";
import {
	getActionSpec,
	getProviderSpec,
	requireActionSpec,
	requireProviderSpec,
} from "../generated/spec-helpers.ts";

describe("spec-helpers", () => {
	it("getActionSpec returns spec for known action", () => {
		const spec = getActionSpec("REPLY");
		expect(spec).toBeDefined();
		expect(spec?.name).toBe("REPLY");
	});

	it("getActionSpec returns undefined for unknown", () => {
		expect(getActionSpec("UNKNOWN_ACTION_XYZ")).toBeUndefined();
	});

	it("requireActionSpec throws for unknown", () => {
		expect(() => requireActionSpec("UNKNOWN_XYZ")).toThrow(
			"Action spec not found",
		);
	});

	it("getProviderSpec returns spec for known provider", () => {
		const spec = getProviderSpec("TIME");
		expect(spec).toBeDefined();
		expect(spec?.name).toBe("TIME");
	});

	it("getProviderSpec returns undefined for unknown", () => {
		expect(getProviderSpec("UNKNOWN_PROVIDER_XYZ")).toBeUndefined();
	});

	it("requireProviderSpec throws for unknown", () => {
		expect(() => requireProviderSpec("UNKNOWN_XYZ")).toThrow(
			"Provider spec not found",
		);
	});
});
