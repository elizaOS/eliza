/**
 * SECRET_SALT lifecycle (W1-060): an unset salt must never silently fall back
 * to the publicly known `"secretsalt"` constant — production throws (unless
 * explicitly overridden), everything else gets an ephemeral per-process salt
 * with a loud warning, so ciphertext can never be keyed by a published value.
 * Uses real env manipulation plus the documented clearSaltCache() test seam.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSaltCache, getSalt } from "./settings.ts";

const ENV_KEYS = [
	"SECRET_SALT",
	"NODE_ENV",
	"ELIZA_ALLOW_DEFAULT_SECRET_SALT",
] as const;

describe("getSalt (W1-060)", () => {
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		clearSaltCache();
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		clearSaltCache();
	});

	it("generates an ephemeral salt instead of the public constant when unset", () => {
		const salt = getSalt();
		expect(salt).not.toBe("secretsalt");
		expect(salt).toMatch(/^[0-9a-f]{64}$/);
	});

	it("keeps the ephemeral salt stable across calls and cache clears", () => {
		const first = getSalt();
		clearSaltCache();
		expect(getSalt()).toBe(first);
	});

	it("returns an explicitly configured salt as-is", () => {
		process.env.SECRET_SALT = "operator-provided-salt";
		expect(getSalt()).toBe("operator-provided-salt");
	});

	it("honors the legacy constant only under explicit opt-in", () => {
		process.env.ELIZA_ALLOW_DEFAULT_SECRET_SALT = "true";
		expect(getSalt()).toBe("secretsalt");
	});

	it("throws in production when the salt is unset", () => {
		process.env.NODE_ENV = "production";
		expect(() => getSalt()).toThrow(/SECRET_SALT must be set/);
	});

	it("throws in production when the salt is the legacy constant", () => {
		process.env.NODE_ENV = "production";
		process.env.SECRET_SALT = "secretsalt";
		expect(() => getSalt()).toThrow(/SECRET_SALT must be set/);
	});

	it("allows the production override only with the opt-in flag", () => {
		process.env.NODE_ENV = "production";
		process.env.ELIZA_ALLOW_DEFAULT_SECRET_SALT = "true";
		expect(getSalt()).toBe("secretsalt");
	});

	it.each(["TRUE", "true", " true "])(
		"honors the override for the exact value %j (case/whitespace insensitive)",
		(flag) => {
			process.env.NODE_ENV = "production";
			process.env.ELIZA_ALLOW_DEFAULT_SECRET_SALT = flag;
			expect(getSalt()).toBe("secretsalt");
		},
	);

	it.each(["1", "yes", "on", "enabled"])(
		"still throws for a truthy-but-not-\"true\" override (%j), but names the exact required value",
		(flag) => {
			process.env.NODE_ENV = "production";
			process.env.ELIZA_ALLOW_DEFAULT_SECRET_SALT = flag;
			// The exact-match gate stays fail-closed — this must NOT enable the
			// publicly known salt — but the error tells the operator what to set.
			expect(() => getSalt()).toThrow(/must be exactly "true"/);
		},
	);

	it.each(["false", "0", "no", "", "  ", "maybe"])(
		"throws the generic message when the override is absent or falsy (%j)",
		(flag) => {
			process.env.NODE_ENV = "production";
			process.env.ELIZA_ALLOW_DEFAULT_SECRET_SALT = flag;
			expect(() => getSalt()).toThrow(
				/Set ELIZA_ALLOW_DEFAULT_SECRET_SALT=true to override/,
			);
		},
	);
});
