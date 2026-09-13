/**
 * Covers readEnv, readEnvBool, readEnvNumber, and readEnvFirst: canonical-key
 * lookup, typed number/boolean parsing, error rejection on malformed numeric
 * input, whitespace-only treated as unset, and fallback key iteration.
 */
import { describe, expect, it } from "vitest";
import { isElizaError } from "../errors.ts";
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
	it("parses valid integer and float numbers", () => {
		expect(readEnvNumber("PORT", { env: { PORT: "3000" } })).toBe(3000);
		expect(readEnvNumber("RATIO", { env: { RATIO: "0.75" } })).toBe(0.75);
	});

	it("returns defaultValue or undefined when unset or empty", () => {
		expect(readEnvNumber("UNSET", { env: {}, defaultValue: 5000 })).toBe(5000);
		expect(readEnvNumber("UNSET", { env: {} })).toBeUndefined();
		expect(
			readEnvNumber("EMPTY", { env: { EMPTY: "  " }, defaultValue: 80 }),
		).toBe(80);
	});

	it("throws ElizaError on unparseable, NaN, or non-finite numbers", () => {
		expect(() =>
			readEnvNumber("PORT", { env: { PORT: "invalid" }, defaultValue: 8080 }),
		).toThrowError(/Invalid numeric environment variable PORT: "invalid"/);

		expect(() =>
			readEnvNumber("PORT", { env: { PORT: "Infinity" } }),
		).toThrowError(/Invalid numeric environment variable PORT: "Infinity"/);

		try {
			readEnvNumber("PORT", { env: { PORT: "abc" } });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(isElizaError(err)).toBe(true);
			if (isElizaError(err)) {
				expect(err.code).toBe("INVALID_ENV_VALUE");
				expect(err.context).toEqual({ key: "PORT", value: "abc" });
			}
		}
	});

	it("enforces min and max bounds when specified", () => {
		expect(
			readEnvNumber("COUNT", { env: { COUNT: "10" }, min: 0, max: 20 }),
		).toBe(10);
		expect(() =>
			readEnvNumber("COUNT", { env: { COUNT: "-1" }, min: 0 }),
		).toThrowError(/below minimum 0/);
		expect(() =>
			readEnvNumber("COUNT", { env: { COUNT: "25" }, max: 20 }),
		).toThrowError(/above maximum 20/);
	});
});

describe("readEnvFirst", () => {
	it("finds the first set key among ordered fallback keys", () => {
		expect(
			readEnvFirst(["KEY_A", "KEY_B"], {
				env: { KEY_B: "val-b" },
			}),
		).toBe("val-b");

		expect(
			readEnvFirst(["PRIMARY", "SECONDARY"], {
				env: { PRIMARY: "p-val", SECONDARY: "s-val" },
			}),
		).toBe("p-val");
	});

	it("skips empty and whitespace-only keys without shadowing later keys", () => {
		expect(
			readEnvFirst(["PRIMARY", "SECONDARY"], {
				env: { PRIMARY: "   ", SECONDARY: "s-val" },
			}),
		).toBe("s-val");
	});

	it("returns defaultValue when all keys are unset or key list is empty", () => {
		expect(
			readEnvFirst(["MISSING_1", "MISSING_2"], {
				env: {},
				defaultValue: "fallback",
			}),
		).toBe("fallback");

		expect(readEnvFirst([], { defaultValue: "fallback" })).toBe("fallback");
		expect(readEnvFirst([])).toBeUndefined();
	});
});
