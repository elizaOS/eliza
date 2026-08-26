/**
 * Tests for resolveSetting: runtime-setting-wins-over-env precedence, non-string
 * coercion, the readEnv-based env fallback (whitespace treated as unset), and
 * default handling, driven through an in-memory SettingReader stub rather than a
 * live runtime.
 */
import { describe, expect, it } from "vitest";
import { resolveSetting, type SettingReader } from "./resolve-setting.ts";

const reader = (
	values: Record<string, string | boolean | number | null>,
): SettingReader => ({
	getSetting: (key) => (key in values ? values[key] : null),
});

describe("resolveSetting", () => {
	it("prefers the runtime setting over env", () => {
		expect(
			resolveSetting(reader({ KEY: "from-runtime" }), "KEY", {
				env: { KEY: "from-env" },
			}),
		).toBe("from-runtime");
	});

	it("coerces non-string runtime values to string", () => {
		const r = reader({ FLAG: true, COUNT: 5 });
		expect(resolveSetting(r, "FLAG", { env: {} })).toBe("true");
		expect(resolveSetting(r, "COUNT", { env: {} })).toBe("5");
	});

	it("falls back to env when the runtime returns null", () => {
		expect(
			resolveSetting(reader({ OTHER: "x" }), "KEY", {
				env: { KEY: "from-env" },
			}),
		).toBe("from-env");
	});

	it("falls back to env when there is no runtime", () => {
		expect(resolveSetting(null, "KEY", { env: { KEY: "from-env" } })).toBe(
			"from-env",
		);
		expect(resolveSetting(undefined, "KEY", { env: { KEY: "from-env" } })).toBe(
			"from-env",
		);
	});

	it("returns the default when neither runtime nor env has the key", () => {
		expect(
			resolveSetting(reader({}), "KEY", { env: {}, defaultValue: "d" }),
		).toBe("d");
		expect(resolveSetting(reader({}), "KEY", { env: {} })).toBeUndefined();
	});

	it("uses readEnv semantics for the env fallback (whitespace is unset)", () => {
		expect(
			resolveSetting(reader({}), "KEY", {
				env: { KEY: "   " },
				defaultValue: "d",
			}),
		).toBe("d");
	});

	it("does NOT read process.env when the runtime has the key (no leak past runtime)", () => {
		// Runtime value present → env is never consulted, even the real one.
		expect(resolveSetting(reader({ KEY: "runtime" }), "KEY")).toBe("runtime");
	});
});
