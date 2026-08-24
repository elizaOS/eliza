/**
 * Unit tests for spec-helpers: validates action and provider spec lookups,
 * optional vs required retrieval, and not-found error handling.
 */
import { describe, expect, it } from "vitest";
import {
	getActionSpec,
	getProviderSpec,
	requireActionSpec,
	requireProviderSpec,
} from "./spec-helpers.ts";

describe("spec-helpers", () => {
	describe("actions lookup", () => {
		it("retrieves known action spec or undefined for unknown", () => {
			expect(getActionSpec("UNKNOWN_ACTION_999")).toBeUndefined();
		});

		it("throws Error on requireActionSpec when not found", () => {
			expect(() => requireActionSpec("NON_EXISTENT_ACTION")).toThrow(
				"Action spec not found: NON_EXISTENT_ACTION",
			);
		});
	});

	describe("providers lookup", () => {
		it("retrieves known provider spec or undefined for unknown", () => {
			expect(getProviderSpec("UNKNOWN_PROVIDER_999")).toBeUndefined();
		});

		it("throws Error on requireProviderSpec when not found", () => {
			expect(() => requireProviderSpec("NON_EXISTENT_PROVIDER")).toThrow(
				"Provider spec not found: NON_EXISTENT_PROVIDER",
			);
		});
	});
});
