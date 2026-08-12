/**
 * stewardCookieNames env scoping: production/unset keep the historical names,
 * every other environment gets suffixed names that cannot collide with
 * production's on the shared parent-zone cookie domain (#13728).
 *
 * The bounded read-only migration window that allowed non-production
 * environments to fall back to the historical unsuffixed access cookie closed
 * on 2026-08-04 (#14130). Non-production environments now read ONLY their own
 * scoped cookie — the legacy unsuffixed cookie is never read, regardless of
 * timestamp.
 */

import { describe, expect, it } from "vitest";
import {
  canMutateLegacyStewardCookies,
  LEGACY_STEWARD_COOKIES,
  readStewardAccessCookieFromHeader,
  stewardCookieNames,
} from "./steward-cookies";

describe("stewardCookieNames", () => {
  it("production and unset use the historical unsuffixed names", () => {
    expect(stewardCookieNames("production")).toEqual(LEGACY_STEWARD_COOKIES);
    expect(stewardCookieNames(undefined)).toEqual(LEGACY_STEWARD_COOKIES);
  });

  it("staging names are suffixed and disjoint from production's", () => {
    const staging = stewardCookieNames("staging");
    expect(staging).toEqual({
      token: "steward-token-staging",
      refreshToken: "steward-refresh-token-staging",
      authed: "steward-authed-staging",
    });
    expect(staging.token).not.toBe(LEGACY_STEWARD_COOKIES.token);
    expect(staging.refreshToken).not.toBe(LEGACY_STEWARD_COOKIES.refreshToken);
    expect(staging.authed).not.toBe(LEGACY_STEWARD_COOKIES.authed);
  });
});

describe("canMutateLegacyStewardCookies", () => {
  it("limits legacy mutations to production and unset local environments", () => {
    expect(canMutateLegacyStewardCookies("production")).toBe(true);
    expect(canMutateLegacyStewardCookies(undefined)).toBe(true);
    expect(canMutateLegacyStewardCookies("staging")).toBe(false);
    expect(canMutateLegacyStewardCookies("preview")).toBe(false);
  });
});

describe("readStewardAccessCookieFromHeader (post-migration, #14130)", () => {
  it("reads the environment-scoped access cookie first", () => {
    expect(
      readStewardAccessCookieFromHeader(
        "steward-token=prod; steward-token-staging=stage",
        "staging",
      ),
    ).toBe("stage");
  });

  it("never falls back to the legacy unsuffixed cookie in non-production", () => {
    // Only the legacy unsuffixed cookie is present (no scoped cookie).
    // Post-migration, non-production must NOT read it.
    expect(readStewardAccessCookieFromHeader("steward-token=legacy", "staging")).toBeUndefined();
  });

  it("reads the historical cookie in production and unset (local dev)", () => {
    expect(readStewardAccessCookieFromHeader("steward-token=prod", "production")).toBe("prod");
    expect(readStewardAccessCookieFromHeader("steward-token=local", undefined)).toBe("local");
  });

  it("returns undefined when no cookie is present", () => {
    expect(readStewardAccessCookieFromHeader(null, "staging")).toBeUndefined();
    expect(readStewardAccessCookieFromHeader("", "production")).toBeUndefined();
  });
});
