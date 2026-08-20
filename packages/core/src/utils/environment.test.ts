/**
 * Deterministic tests for environment detection, typed getters, and cache management.
 * Each test restores only the environment keys it owns so concurrent suites retain
 * the process environment object and unrelated values.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	detectEnvironment,
	getBooleanEnv,
	getEnv,
	getEnvironment,
	getNumberEnv,
	hasEnv,
	setEnv,
} from "./environment.js";

describe("environment utils", () => {
	const testKeys = [
		"TEST_CORE_ENV_VAR",
		"TEST_CORE_BOOL_VAR",
		"TEST_CORE_NUM_VAR",
	] as const;
	const originalValues = new Map(
		testKeys.map((key) => [key, process.env[key]] as const),
	);

	beforeEach(() => {
		getEnvironment().clearCache();
		for (const key of testKeys) delete process.env[key];
	});

	afterEach(() => {
		getEnvironment().clearCache();
		for (const key of testKeys) {
			const value = originalValues.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("detects Node environment", () => {
		expect(detectEnvironment()).toBe("node");
		expect(getEnvironment().isNode()).toBe(true);
		expect(getEnvironment().isBrowser()).toBe(false);
	});

	it("gets, sets, and checks environment variables", () => {
		expect(hasEnv("TEST_CORE_ENV_VAR")).toBe(false);
		expect(getEnv("TEST_CORE_ENV_VAR")).toBeUndefined();
		expect(getEnv("TEST_CORE_ENV_VAR", "default_val")).toBe("default_val");

		setEnv("TEST_CORE_ENV_VAR", "active_val");
		expect(hasEnv("TEST_CORE_ENV_VAR")).toBe(true);
		expect(getEnv("TEST_CORE_ENV_VAR")).toBe("active_val");
	});

	it("parses boolean environment variables", () => {
		setEnv("TEST_CORE_BOOL_VAR", "true");
		expect(getBooleanEnv("TEST_CORE_BOOL_VAR")).toBe(true);

		setEnv("TEST_CORE_BOOL_VAR", "1");
		expect(getBooleanEnv("TEST_CORE_BOOL_VAR")).toBe(true);

		setEnv("TEST_CORE_BOOL_VAR", "false");
		expect(getBooleanEnv("TEST_CORE_BOOL_VAR")).toBe(false);

		setEnv("TEST_CORE_BOOL_VAR", "0");
		expect(getBooleanEnv("TEST_CORE_BOOL_VAR")).toBe(false);

		delete process.env.TEST_CORE_BOOL_VAR;
		getEnvironment().clearCache();
		expect(getBooleanEnv("TEST_CORE_BOOL_VAR", true)).toBe(true);
		expect(getBooleanEnv("TEST_CORE_BOOL_VAR", false)).toBe(false);
	});

	it("parses number environment variables and rejects empty/non-finite values", () => {
		setEnv("TEST_CORE_NUM_VAR", "4000");
		expect(getNumberEnv("TEST_CORE_NUM_VAR")).toBe(4000);

		setEnv("TEST_CORE_NUM_VAR", "  3.14  ");
		expect(getNumberEnv("TEST_CORE_NUM_VAR")).toBe(3.14);

		setEnv("TEST_CORE_NUM_VAR", "-50");
		expect(getNumberEnv("TEST_CORE_NUM_VAR")).toBe(-50);

		setEnv("TEST_CORE_NUM_VAR", "");
		expect(getNumberEnv("TEST_CORE_NUM_VAR", 8080)).toBe(8080);

		setEnv("TEST_CORE_NUM_VAR", "   ");
		expect(getNumberEnv("TEST_CORE_NUM_VAR", 8080)).toBe(8080);

		setEnv("TEST_CORE_NUM_VAR", "not_a_number");
		expect(getNumberEnv("TEST_CORE_NUM_VAR", 8080)).toBe(8080);

		setEnv("TEST_CORE_NUM_VAR", "Infinity");
		expect(getNumberEnv("TEST_CORE_NUM_VAR", 8080)).toBe(8080);

		setEnv("TEST_CORE_NUM_VAR", "-Infinity");
		expect(getNumberEnv("TEST_CORE_NUM_VAR", 8080)).toBe(8080);
	});
});
