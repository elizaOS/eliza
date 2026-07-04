/**
 * Protected-app resolution tests for first-party slug spoofing boundaries.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProtected, resolveProtectedApps } from "./protected-apps.js";

let savedEnv: string | undefined;
beforeEach(() => {
	savedEnv = process.env.ELIZA_PROTECTED_APPS;
});
afterEach(() => {
	if (savedEnv === undefined) delete process.env.ELIZA_PROTECTED_APPS;
	else process.env.ELIZA_PROTECTED_APPS = savedEnv;
});

const NO_REPO = "/definitely-not-a-real-repo-root-9f3a";

describe("resolveProtectedApps", () => {
	it("reads + trims the env list and tolerates a missing apps dir", async () => {
		process.env.ELIZA_PROTECTED_APPS =
			" @elizaos/app-knowledge , app-wallet ,, ";
		const res = await resolveProtectedApps(NO_REPO);
		expect(res.fromEnv).toEqual(["@elizaos/app-knowledge", "app-wallet"]);
		expect(res.fromFirstPartyDir).toEqual([]);
	});

	it("yields an empty protected set when nothing is configured", async () => {
		delete process.env.ELIZA_PROTECTED_APPS;
		const res = await resolveProtectedApps(NO_REPO);
		expect(res.fromEnv).toEqual([]);
		expect(res.set.size).toBe(0);
	});
});

describe("isProtected — name-form matching", () => {
	it("matches the full name, basename, and app-stripped suffix, case-insensitively", async () => {
		process.env.ELIZA_PROTECTED_APPS = "@elizaos/app-knowledge,app-wallet";
		const res = await resolveProtectedApps(NO_REPO);
		expect(isProtected("@elizaos/app-knowledge", res)).toBe(true);
		expect(isProtected("app-knowledge", res)).toBe(true);
		expect(isProtected("knowledge", res)).toBe(true);
		expect(isProtected("KNOWLEDGE", res)).toBe(true);
		expect(isProtected("wallet", res)).toBe(true);
	});

	it("blocks a foreign package that reuses a protected slug (anti-spoof)", async () => {
		process.env.ELIZA_PROTECTED_APPS = "@elizaos/app-knowledge";
		const res = await resolveProtectedApps(NO_REPO);
		// Attacker scopes their own package but reuses the "knowledge" slug.
		expect(isProtected("@attacker/knowledge", res)).toBe(true);
		expect(isProtected("@attacker/app-knowledge", res)).toBe(true);
	});

	it("does not protect unrelated names or invalid inputs", async () => {
		process.env.ELIZA_PROTECTED_APPS = "app-knowledge";
		const res = await resolveProtectedApps(NO_REPO);
		expect(isProtected("calculator", res)).toBe(false);
		expect(isProtected("@x/calculator", res)).toBe(false);
		expect(isProtected("", res)).toBe(false);
		expect(isProtected("   ", res)).toBe(false);
		expect(isProtected(undefined as unknown as string, res)).toBe(false);
	});
});
