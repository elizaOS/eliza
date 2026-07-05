// @vitest-environment jsdom

/**
 * Steward session adapter tests pin the console-auth hold predicate: only a
 * readable, non-expired token with an identity claim may suppress the login
 * redirect while the provider hydrates.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, describe, expect, it } from "vitest";
import { hasHydratableStewardToken } from "./steward-session";

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

describe("hasHydratableStewardToken", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("accepts a non-expired identity-bearing token", () => {
    localStorage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 600 }),
    );

    expect(hasHydratableStewardToken()).toBe(true);
  });

  it("rejects expired, malformed, and identity-less tokens", () => {
    localStorage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 60 }),
    );
    expect(hasHydratableStewardToken()).toBe(false);

    localStorage.setItem(STEWARD_TOKEN_KEY, "not-a-jwt");
    expect(hasHydratableStewardToken()).toBe(false);

    localStorage.setItem(
      STEWARD_TOKEN_KEY,
      makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 }),
    );
    expect(hasHydratableStewardToken()).toBe(false);
  });
});
