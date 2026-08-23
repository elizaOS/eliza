import { describe, expect, it } from "vitest";
import { readEnv, readEnvBool } from "./read-env.ts";

describe("readEnv", () => {
	it("reads trimmed values from the injected env", () => {
		expect(readEnv("K", { env: { K: "  v  " } })).toBe("v");
	});

	it("treats blank as unset", () => {
		expect(readEnv("K", { env: { K: "   " } })).toBeUndefined();
		expect(readEnv("K", { env: {} })).toBeUndefined();
	});

	it("returns the default when unset", () => {
		expect(readEnv("K", { env: {}, defaultValue: "d" })).toBe("d");
	});
});

describe("readEnvBool", () => {
	it("parses truthy values", () => {
		expect(readEnvBool("K", { env: { K: "1" } })).toBe(true);
		expect(readEnvBool("K", { env: { K: "true" } })).toBe(true);
		expect(readEnvBool("K", { env: { K: "yes" } })).toBe(true);
	});

	it("parses falsy values", () => {
		expect(readEnvBool("K", { env: { K: "0" } })).toBe(false);
		expect(readEnvBool("K", { env: { K: "no" } })).toBe(false);
	});

	it("falls back to the default", () => {
		expect(readEnvBool("K", { env: {}, defaultValue: true })).toBe(true);
		expect(readEnvBool("K", { env: {} })).toBe(false);
		expect(readEnvBool("K", { env: { K: "garbage" } })).toBe(false);
	});
});
