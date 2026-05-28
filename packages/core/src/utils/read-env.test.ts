import { describe, expect, it } from "vitest";
import { readEnv, readEnvBool } from "./read-env.ts";

describe("readEnv", () => {
	it("reads the canonical key", () => {
		expect(readEnv("ELIZA_FOO", { env: { ELIZA_FOO: "canon" } })).toBe("canon");
	});

	it("returns the default when nothing is set", () => {
		expect(readEnv("ELIZA_NOPE", { env: {}, defaultValue: "d" })).toBe("d");
		expect(readEnv("ELIZA_NOPE", { env: {} })).toBeUndefined();
	});

	it("treats whitespace-only values as unset", () => {
		expect(
			readEnv("ELIZA_FOO", {
				env: { ELIZA_FOO: "   " },
				defaultValue: "default",
			}),
		).toBe("default");
	});
});

describe("readEnvBool", () => {
	it("parses common truthy/falsy values", () => {
		for (const v of ["1", "true", "TRUE", "yes", "on"]) {
			expect(readEnvBool("ELIZA_FLAG", { env: { ELIZA_FLAG: v } })).toBe(true);
		}
		for (const v of ["0", "false", "no", "off"]) {
			expect(readEnvBool("ELIZA_FLAG", { env: { ELIZA_FLAG: v } })).toBe(false);
		}
	});

	it("returns the default when unset", () => {
		expect(readEnvBool("ELIZA_FLAG", { env: {} })).toBe(false);
		expect(readEnvBool("ELIZA_FLAG", { env: {}, defaultValue: true })).toBe(
			true,
		);
	});
});
