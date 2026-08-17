/**
 * Deterministic unit tests for secret validation (features/secrets): the
 * custom validator strategy (fail-closed dispatch, key-specific vs shared
 * fallback) and the url:reachable strategy's SSRF-guarded probe (literal
 * private/loopback/link-local targets rejected without opening a socket).
 * No live model or network.
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

	it("fails closed for an unknown validation strategy", async () => {
		const result = await validateSecret(
			"CUSTOM_SECRET",
			"value",
			"not-registered",
		);

		expect(result).toMatchObject({
			isValid: false,
			error: "Unknown validation strategy: not-registered",
		});
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

describe("secret validation url:reachable strategy (SSRF-guarded probe)", () => {
	// The probe runs through fetchWithSsrfGuard: literal private/loopback/
	// link-local targets are blocked before any socket opens, so these cases
	// stay deterministic with no network.
	it("rejects malformed URLs before probing", async () => {
		const result = await validateSecret(
			"SOME_URL",
			"not a url",
			"url:reachable",
		);

		expect(result.isValid).toBe(false);
		expect(result.error).toBe("Invalid URL format");
	});

	it("refuses to probe literal internal targets", async () => {
		for (const url of [
			"http://127.0.0.1:8080/health",
			"http://169.254.169.254/latest/meta-data",
			"http://[::1]/",
			"http://[64:ff9b::a9fe:a9fe]/",
			"http://10.0.0.1/",
		]) {
			const result = await validateSecret("SOME_URL", url, "url:reachable");
			expect(result.isValid, url).toBe(false);
			expect(result.error, url).toMatch(/^URL is not reachable: /);
		}
	});

	it("rejects non-http(s) schemes", async () => {
		const result = await validateSecret(
			"SOME_URL",
			"file:///etc/passwd",
			"url:reachable",
		);

		expect(result.isValid).toBe(false);
	});
});
