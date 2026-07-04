// Exercises token refresh.expiry behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "vitest";
import type { SocialCredentials } from "../../types/social-media";
import { isTokenExpired } from "./token-refresh";

/**
 * `isTokenExpired` decides when a social OAuth token must be refreshed (#8801 —
 * shipped untested). It refreshes 5 minutes EARLY so a token never expires
 * mid-request. A regression that returns false too long lets requests fire with
 * a dead token; one that returns true too eagerly thrashes the refresh path.
 * Both edges of the 5-minute buffer are pinned.
 */
const MIN = 60_000;
const creds = (tokenExpiresAt?: Date): SocialCredentials =>
  ({ tokenExpiresAt }) as SocialCredentials;

describe("isTokenExpired (5-min refresh buffer)", () => {
  it("treats a token with no expiry as not expired", () => {
    expect(isTokenExpired(creds(undefined))).toBe(false);
  });

  it("is NOT expired comfortably outside the buffer window", () => {
    expect(isTokenExpired(creds(new Date(Date.now() + 10 * MIN)))).toBe(false);
    expect(isTokenExpired(creds(new Date(Date.now() + 6 * MIN)))).toBe(false);
  });

  it("IS expired once inside the 5-min buffer (refresh early)", () => {
    expect(isTokenExpired(creds(new Date(Date.now() + 2 * MIN)))).toBe(true);
  });

  it("IS expired for an already-past expiry", () => {
    expect(isTokenExpired(creds(new Date(Date.now() - MIN)))).toBe(true);
  });
});
