/**
 * Exercises action and provider spec helpers against generated catalog tables.
 * Pure deterministic lookup and error verification with no live runtime.
 */
import { describe, expect, it } from "vitest";
import {
	allActionDocs,
	allProviderDocs,
	coreActionDocs,
	coreProviderDocs,
} from "../generated/action-docs.ts";
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

	it("getActionSpec returns the exact core doc object for a core action", () => {
		const doc = coreActionDocs.find((d) => d.name === "REPLY");
		expect(doc).toBeDefined();
		expect(getActionSpec("REPLY")).toBe(doc);
	});

	it("getActionSpec resolves actions outside the core set through the generated catalog fallback", () => {
		expect(coreActionDocs.some((d) => d.name === "ACCOUNTS_COMMAND")).toBe(
			false,
		);
		const spec = getActionSpec("ACCOUNTS_COMMAND");
		expect(spec?.name).toBe("ACCOUNTS_COMMAND");
		expect(allActionDocs.includes(spec as (typeof allActionDocs)[number])).toBe(
			true,
		);
	});

	it("every generated action doc resolves by name with core precedence", () => {
		for (const doc of allActionDocs) {
			const resolved = getActionSpec(doc.name);
			expect(resolved?.name).toBe(doc.name);
			const coreDoc = coreActionDocs.find((d) => d.name === doc.name);
			expect(resolved).toBe(coreDoc ?? doc);
		}
	});

	it("every generated provider doc resolves by name to the core doc object", () => {
		for (const doc of allProviderDocs) {
			const resolved = getProviderSpec(doc.name);
			expect(resolved?.name).toBe(doc.name);
			const coreDoc = coreProviderDocs.find((d) => d.name === doc.name);
			expect(resolved).toBe(coreDoc ?? doc);
		}
	});

	it("requireActionSpec returns the same resolved doc as getActionSpec", () => {
		expect(requireActionSpec("REPLY")).toBe(getActionSpec("REPLY"));
	});

	it("requireProviderSpec returns the same resolved doc as getProviderSpec", () => {
		expect(requireProviderSpec("TIME")).toBe(getProviderSpec("TIME"));
	});

	it("requireActionSpec names the missing action in its error message", () => {
		expect(() => requireActionSpec("NO_SUCH_ACTION")).toThrow(
			"Action spec not found: NO_SUCH_ACTION",
		);
	});

	it("requireProviderSpec names the missing provider in its error message", () => {
		expect(() => requireProviderSpec("NO_SUCH_PROVIDER")).toThrow(
			"Provider spec not found: NO_SUCH_PROVIDER",
		);
	});

	it("lookups are case-sensitive", () => {
		expect(getActionSpec("reply")).toBeUndefined();
		expect(getProviderSpec("time")).toBeUndefined();
	});

	it("empty-string lookups miss every map", () => {
		expect(getActionSpec("")).toBeUndefined();
		expect(getProviderSpec("")).toBeUndefined();
	});
});
