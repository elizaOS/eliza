/**
 * Covers readEnv / readEnvBool: canonical-key lookup, default fallback,
 * whitespace-only treated as unset, and truthy/falsy string parsing (against an
 * injected env map, not process.env).
 */
import { describe, expect, it } from "vitest";
import {
	readEnv,
	readEnvBool,
	readEnvFirst,
	readEnvNumber,
} from "./read-env.ts";

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

describe("readEnvNumber", () => {
	it("parses valid numbers and returns default for invalid/unset values", () => {
		expect(readEnvNumber("PORT", { env: { PORT: "3000" } })).toBe(3000);
		expect(
			readEnvNumber("PORT", { env: { PORT: "invalid" }, defaultValue: 8080 }),
		).toBe(8080);
		expect(readEnvNumber("UNSET", { env: {}, defaultValue: 5000 })).toBe(5000);
		expect(readEnvNumber("UNSET", { env: {} })).toBeUndefined();
	});
});

describe("readEnvFirst", () => {
	it("finds the first set key among ordered aliases", () => {
		expect(
			readEnvFirst(["OPENAI_API_KEY", "OPENAI_KEY"], {
				env: { OPENAI_KEY: "sk-test" },
			}),
		).toBe("sk-test");

		expect(
			readEnvFirst(["PRIMARY", "SECONDARY"], {
				env: { PRIMARY: "p-val", SECONDARY: "s-val" },
			}),
		).toBe("p-val");

		expect(
			readEnvFirst(["MISSING_1", "MISSING_2"], {
				env: {},
				defaultValue: "fallback",
			}),
		).toBe("fallback");
	});
});
