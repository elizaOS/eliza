/**
 * Deterministic unit test for the custom validator strategy in secret validation
 * (features/secrets): validateSecret fails closed when no custom validator is
 * registered, prefers a key-specific validator, and falls back to the shared
 * "custom" validator, exercised via registerValidator/unregisterValidator. No
 * live model or network.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	registerValidator,
	unregisterValidator,
	validateSecret,
} from "./validation";

describe("secret validation custom strategy", () => {
	afterEach(() => {
		unregisterValidator("CUSTOM_SECRET");
		unregisterValidator("custom");
	});

	it("fails closed when no custom validator is registered", async () => {
		const result = await validateSecret("CUSTOM_SECRET", "value", "custom");

		expect(result.isValid).toBe(false);
		expect(result.error).toBe(
			"No custom validator registered for CUSTOM_SECRET",
		);
	});

	it("uses a key-specific custom validator", async () => {
		registerValidator("CUSTOM_SECRET", async (key, value) => ({
			isValid: key === "CUSTOM_SECRET" && value === "allowed",
			validatedAt: 123,
		}));

		await expect(
			validateSecret("CUSTOM_SECRET", "allowed", "custom"),
		).resolves.toMatchObject({
			isValid: true,
			validatedAt: 123,
		});
	});

	it("falls back to the shared custom validator", async () => {
		registerValidator("custom", async (key, value) => ({
			isValid: key.startsWith("CUSTOM_") && value.length > 0,
			validatedAt: 456,
		}));

		await expect(
			validateSecret("CUSTOM_TOKEN", "token", "custom"),
		).resolves.toMatchObject({
			isValid: true,
			validatedAt: 456,
		});
	});
});
