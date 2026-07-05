/**
 * stewardCookieNames env scoping: production/unset keep the historical names,
 * every other environment gets suffixed names that cannot collide with
 * production's on the shared parent-zone cookie domain (#13728).
 */

import { describe, expect, it } from "vitest";
import { LEGACY_STEWARD_COOKIES, stewardCookieNames } from "./steward-cookies";

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
