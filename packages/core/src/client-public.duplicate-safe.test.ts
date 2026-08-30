/**
 * The client-public surface is safe to bundle separately from the core root:
 * identity-bearing classes and private mutable registries stay elsewhere,
 * while boot configuration uses the established cross-bundle ambient slot.
 */
import { describe, expect, it } from "vitest";
import { setAmbientSingleton } from "./ambient-context.ts";
import * as clientPublic from "./client-public.ts";

describe("@elizaos/core/client-public is duplicate-safe", () => {
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
