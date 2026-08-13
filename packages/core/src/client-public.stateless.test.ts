/**
 * The client-public surface is stateless only: types, constants, and pure
 * functions. Identity-bearing classes and mutable registries belong elsewhere.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as clientPublic from "./client-public.ts";

const src = readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "client-public.ts"),
	"utf8",
);

describe("@elizaos/core/client-public is a stateless surface", () => {
	it("does not export ElizaError or connector registration", () => {
		expect(src).not.toMatch(/^export[\s\S]*\bElizaError\b/m);
		expect(src).not.toMatch(/^export[\s\S]*registerConnectorSource/m);
		expect(src).not.toMatch(/^export[\s\S]*normalizeConnectorSource/m);
		expect(Object.keys(clientPublic)).not.toContain("ElizaError");
		expect(Object.keys(clientPublic)).not.toContain(
			"registerConnectorSourceAliases",
		);
		expect(Object.keys(clientPublic)).not.toContain("normalizeConnectorSource");
	});

	it("exports the shared-needed pure helpers", () => {
		expect(typeof clientPublic.formatError).toBe("function");
		expect(typeof clientPublic.isTruthyEnvValue).toBe("function");
		expect(typeof clientPublic.resolveAliasedEnvValue).toBe("function");
		expect(typeof clientPublic.isElizaSettingsDebugEnabled).toBe("function");
		expect(typeof clientPublic.sanitizeForSettingsDebug).toBe("function");
		expect(typeof clientPublic.settingsDebugCloudSummary).toBe("function");
	});

	it("formatError survives hostile primitives", () => {
		const hostile = Object.create(null);
		Object.defineProperty(hostile, Symbol.toPrimitive, {
			get() {
				throw new Error("poisoned");
			},
		});
		expect(clientPublic.formatError(hostile)).toMatch(/^\[object /);

		const throwingMessage = new Error("visible");
		Object.defineProperty(throwingMessage, "message", {
			get() {
				throw new Error("poisoned-message");
			},
		});
		expect(clientPublic.formatError(throwingMessage)).toMatch(/^\[object /);
	});

	it("isTruthyEnvValue rejects non-strings and unknown tokens", () => {
		expect(clientPublic.isTruthyEnvValue("true")).toBe(true);
		expect(clientPublic.isTruthyEnvValue("  YES  ")).toBe(true);
		expect(clientPublic.isTruthyEnvValue("false")).toBe(false);
		expect(clientPublic.isTruthyEnvValue("maybe")).toBe(false);
		expect(clientPublic.isTruthyEnvValue(undefined)).toBe(false);
		expect(clientPublic.isTruthyEnvValue(null)).toBe(false);
	});

	it("blank ELIZA_ values do not shadow a present brand alias", () => {
		const aliases = [["MILADY_API_TOKEN", "ELIZA_API_TOKEN"]] as const;
		const env = {
			ELIZA_API_TOKEN: "   ",
			MILADY_API_TOKEN: "brand-secret",
		};
		expect(
			clientPublic.resolveAliasedEnvValue("ELIZA_API_TOKEN", aliases, env),
		).toBe("brand-secret");
		expect(
			clientPublic.resolveAliasedEnvValue("UNRELATED_KEY", aliases, env),
		).toBeUndefined();
	});
});
