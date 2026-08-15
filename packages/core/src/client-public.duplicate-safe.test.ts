/**
 * The client-public surface is safe to bundle separately from the core root:
 * identity-bearing classes and private mutable registries stay elsewhere,
 * while boot configuration uses the established cross-bundle ambient slot.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setAmbientSingleton } from "./ambient-context.ts";
import * as clientPublic from "./client-public.ts";

const src = readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "client-public.ts"),
	"utf8",
);
const packageJson = JSON.parse(
	readFileSync(
		path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"),
		"utf8",
	),
);

describe("@elizaos/core/client-public is duplicate-safe", () => {
	it("exports only the reviewed helper allowlist", () => {
		expect(src).not.toMatch(/^export[\s\S]*\bElizaError\b/m);
		expect(src).not.toMatch(/^export[\s\S]*registerConnectorSource/m);
		expect(src).not.toMatch(/^export\s+\*/m);
		expect(Object.keys(clientPublic).sort()).toEqual([
			"formatError",
			"isElizaSettingsDebugEnabled",
			"isTruthyEnvValue",
			"resolveAliasedEnvValue",
			"sanitizeForSettingsDebug",
			"settingsDebugCloudSummary",
		]);
	});

	it("exports the helpers required by shared", () => {
		expect(typeof clientPublic.formatError).toBe("function");
		expect(typeof clientPublic.isTruthyEnvValue).toBe("function");
		expect(typeof clientPublic.resolveAliasedEnvValue).toBe("function");
		expect(typeof clientPublic.isElizaSettingsDebugEnabled).toBe("function");
		expect(typeof clientPublic.sanitizeForSettingsDebug).toBe("function");
		expect(typeof clientPublic.settingsDebugCloudSummary).toBe("function");
	});

	it("publishes the browser and server builds through matching conditions", () => {
		const subpath = packageJson.exports["./client-public"];
		expect(subpath.browser.import).toBe("./dist/browser/client-public.js");
		expect(subpath.browser.default).toBe("./dist/browser/client-public.js");
		expect(subpath.node.import).toBe("./dist/node/client-public.js");
		expect(subpath.bun.import).toBe("./dist/node/client-public.js");
		expect(subpath.default).toBe("./dist/node/client-public.js");
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

	it("reads default aliases from the shared ambient boot-config slot", () => {
		const key = Symbol.for("elizaos.app.boot-config");
		const slot = globalThis as Record<PropertyKey, unknown>;
		const hadOriginal = Object.hasOwn(slot, key);
		const original = slot[key];
		try {
			setAmbientSingleton(key, {
				current: {
					envAliases: [["MILADY_API_TOKEN", "ELIZA_API_TOKEN"]],
				},
			});
			expect(
				clientPublic.resolveAliasedEnvValue("ELIZA_API_TOKEN", undefined, {
					MILADY_API_TOKEN: "ambient-secret",
				}),
			).toBe("ambient-secret");
		} finally {
			if (hadOriginal) slot[key] = original;
			else Reflect.deleteProperty(slot, key);
		}
	});
});
