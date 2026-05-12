import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import {
	__resetReadEnvWarnings,
	readEnv,
	readEnvBool,
} from "./read-env.ts";

describe("readEnv", () => {
	beforeEach(() => __resetReadEnvWarnings());
	afterEach(() => vi.restoreAllMocks());

	it("prefers the canonical key over legacy aliases", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(
			readEnv("ELIZA_FOO", ["MILADY_FOO"], {
				env: { ELIZA_FOO: "canon", MILADY_FOO: "legacy" },
			}),
		).toBe("canon");
		expect(warn).not.toHaveBeenCalled();
	});

	it("falls back to a legacy alias and warns exactly once per alias", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const env = { MILADY_FOO: "legacy" };
		expect(readEnv("ELIZA_FOO", ["MILADY_FOO"], { env })).toBe("legacy");
		expect(readEnv("ELIZA_FOO", ["MILADY_FOO"], { env })).toBe("legacy");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("MILADY_FOO");
		expect(String(warn.mock.calls[0]?.[0])).toContain("ELIZA_FOO");
	});

	it("honors multiple aliases newest-first", () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(
			readEnv("ELIZA_X", ["MILADY_X", "OLD_X"], { env: { OLD_X: "oldest" } }),
		).toBe("oldest");
	});

	it("returns the default when nothing is set", () => {
		expect(
			readEnv("ELIZA_NOPE", ["MILADY_NOPE"], { env: {}, defaultValue: "d" }),
		).toBe("d");
		expect(readEnv("ELIZA_NOPE", ["MILADY_NOPE"], { env: {} })).toBeUndefined();
	});

	it("treats whitespace-only values as unset", () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(
			readEnv("ELIZA_FOO", ["MILADY_FOO"], {
				env: { ELIZA_FOO: "   ", MILADY_FOO: "legacy" },
			}),
		).toBe("legacy");
	});

	it("silent option suppresses the deprecation warning", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(
			readEnv("ELIZA_FOO", ["MILADY_FOO"], {
				env: { MILADY_FOO: "legacy" },
				silent: true,
			}),
		).toBe("legacy");
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("readEnvBool", () => {
	beforeEach(() => __resetReadEnvWarnings());
	afterEach(() => vi.restoreAllMocks());

	it("parses common truthy/falsy values", () => {
		for (const v of ["1", "true", "TRUE", "yes", "on"]) {
			expect(readEnvBool("ELIZA_FLAG", [], { env: { ELIZA_FLAG: v } })).toBe(
				true,
			);
		}
		for (const v of ["0", "false", "no", "off"]) {
			expect(readEnvBool("ELIZA_FLAG", [], { env: { ELIZA_FLAG: v } })).toBe(
				false,
			);
		}
	});

	it("returns the default when unset", () => {
		expect(readEnvBool("ELIZA_FLAG", [], { env: {} })).toBe(false);
		expect(
			readEnvBool("ELIZA_FLAG", [], { env: {}, defaultValue: true }),
		).toBe(true);
	});

	it("honors legacy aliases with a deprecation warning", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(
			readEnvBool("ELIZA_FLAG", ["MILADY_FLAG"], {
				env: { MILADY_FLAG: "1" },
			}),
		).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
