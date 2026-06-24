import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProtected, resolveProtectedApps } from "./protected-apps.js";

/**
 * Protected-apps resolution stops a foreign package from registering under a
 * first-party slug (e.g. spoofing companion) — a security boundary, so the
 * name-form matching (full / basename / app-stripped, case-insensitive) is pinned.
 */

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
    process.env.ELIZA_PROTECTED_APPS = " @elizaos/app-companion , app-wallet ,, ";
    const res = await resolveProtectedApps(NO_REPO);
    expect(res.fromEnv).toEqual(["@elizaos/app-companion", "app-wallet"]);
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
    process.env.ELIZA_PROTECTED_APPS = "@elizaos/app-companion,app-wallet";
    const res = await resolveProtectedApps(NO_REPO);
    expect(isProtected("@elizaos/app-companion", res)).toBe(true);
    expect(isProtected("app-companion", res)).toBe(true);
    expect(isProtected("companion", res)).toBe(true);
    expect(isProtected("COMPANION", res)).toBe(true);
    expect(isProtected("wallet", res)).toBe(true);
  });

  it("blocks a foreign package that reuses a protected slug (anti-spoof)", async () => {
    process.env.ELIZA_PROTECTED_APPS = "@elizaos/app-companion";
    const res = await resolveProtectedApps(NO_REPO);
    // Attacker scopes their own package but reuses the "companion" slug.
    expect(isProtected("@attacker/companion", res)).toBe(true);
    expect(isProtected("@attacker/app-companion", res)).toBe(true);
  });

  it("does not protect unrelated names or invalid inputs", async () => {
    process.env.ELIZA_PROTECTED_APPS = "app-companion";
    const res = await resolveProtectedApps(NO_REPO);
    expect(isProtected("calculator", res)).toBe(false);
    expect(isProtected("@x/calculator", res)).toBe(false);
    expect(isProtected("", res)).toBe(false);
    expect(isProtected("   ", res)).toBe(false);
    expect(isProtected(undefined as unknown as string, res)).toBe(false);
  });
});
