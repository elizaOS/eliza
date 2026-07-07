/**
 * stewardCookieNames env scoping: production/unset keep the historical names,
 * every other environment gets suffixed names that cannot collide with
 * production's on the shared parent-zone cookie domain (#13728).
 */

import { describe, expect, it } from "vitest";
import {
  canMutateLegacyStewardCookies,
  LEGACY_STEWARD_COOKIE_FALLBACK_EXPIRES_AT_MS,
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

describe("readStewardAccessCookieFromHeader", () => {
  const beforeCutoff = LEGACY_STEWARD_COOKIE_FALLBACK_EXPIRES_AT_MS - 1;
  const atCutoff = LEGACY_STEWARD_COOKIE_FALLBACK_EXPIRES_AT_MS;

  it("reads the environment-scoped access cookie first", () => {
    expect(
      readStewardAccessCookieFromHeader(
        "steward-token=prod; steward-token-staging=stage",
        "staging",
        beforeCutoff,
      ),
    ).toBe("stage");
  });

  it("allows a bounded read-only legacy fallback before the cutoff", () => {
    expect(readStewardAccessCookieFromHeader("steward-token=legacy", "staging", beforeCutoff)).toBe(
      "legacy",
    );
  });

  it("shuts off the non-production legacy fallback at the cutoff", () => {
    expect(
      readStewardAccessCookieFromHeader("steward-token=legacy", "staging", atCutoff),
    ).toBeUndefined();
  });

  it("keeps production and unset local environments on the historical cookie", () => {
    expect(readStewardAccessCookieFromHeader("steward-token=prod", "production", atCutoff)).toBe(
      "prod",
    );
    expect(readStewardAccessCookieFromHeader("steward-token=local", undefined, atCutoff)).toBe(
      "local",
    );
  });
});
