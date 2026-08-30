import { describe, expect, it } from "vitest";
import { readEnv, readEnvBool } from "./read-env";

describe("readEnv", () => {
	it("reads from env", () => {
		expect(readEnv("HOME", { env: { HOME: "/home/user" } })).toBe("/home/user");
	});

	it("trims whitespace", () => {
		expect(readEnv("HOME", { env: { HOME: "  /home/user  " } })).toBe("/home/user");
	});

	it("treats empty strings as unset", () => {
		expect(readEnv("HOME", { env: { HOME: "" } })).toBeUndefined();
		expect(readEnv("HOME", { env: { HOME: "   " } })).toBeUndefined();
	});

	it("returns defaultValue when unset", () => {
		expect(readEnv("MISSING", { defaultValue: "fallback" })).toBe("fallback");
	});

	it("returns undefined when unset and no default", () => {
		expect(readEnv("MISSING")).toBeUndefined();
	});
});

describe("readEnvBool", () => {
	it("returns true for truthy values", () => {
		expect(readEnvBool("ENABLED", { env: { ENABLED: "true" } })).toBe(true);
		expect(readEnvBool("ENABLED", { env: { ENABLED: "1" } })).toBe(true);
		expect(readEnvBool("ENABLED", { env: { ENABLED: "yes" } })).toBe(true);
		expect(readEnvBool("ENABLED", { env: { ENABLED: "on" } })).toBe(true);
	});

	it("returns false for falsy values", () => {
		expect(readEnvBool("ENABLED", { env: { ENABLED: "false" } })).toBe(false);
		expect(readEnvBool("ENABLED", { env: { ENABLED: "0" } })).toBe(false);
		expect(readEnvBool("ENABLED", { env: { ENABLED: "no" } })).toBe(false);
		expect(readEnvBool("ENABLED", { env: { ENABLED: "off" } })).toBe(false);
	});

	it("defaults to false when unset", () => {
		expect(readEnvBool("MISSING")).toBe(false);
	});

	it("returns defaultValue when unset", () => {
		expect(readEnvBool("MISSING", { defaultValue: true })).toBe(true);
	});

	it("returns false for unrecognized values", () => {
		expect(readEnvBool("ENABLED", { env: { ENABLED: "maybe" } })).toBe(false);
	});
});
