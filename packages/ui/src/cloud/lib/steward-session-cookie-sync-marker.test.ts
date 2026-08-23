// @vitest-environment jsdom

/**
 * Steward server-cookie sync marker responsibility: proofs are one-shot,
 * token/endpoint scoped, canonical across equivalent URLs, and explicitly
 * retired before any cookie/session clear can invalidate server authority.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeStewardServerCookieSynced,
  invalidateStewardServerCookieSyncMarker,
  markStewardServerCookieSynced,
} from "./steward-session-cookie-sync-marker";

describe("Steward server-cookie sync marker", () => {
  beforeEach(() => {
    invalidateStewardServerCookieSyncMarker();
  });

  it("is one-shot for the exact token and endpoint URL", () => {
    markStewardServerCookieSynced("token-a", "/api/auth/steward-session");

    expect(
      consumeStewardServerCookieSynced(
        "token-a",
        `${window.location.origin}/api/auth/steward-session`,
      ),
    ).toBe(true);
    expect(
      consumeStewardServerCookieSynced("token-a", "/api/auth/steward-session"),
    ).toBe(false);
  });

  it("fails closed and invalidates authority on a token mismatch", () => {
    markStewardServerCookieSynced("token-a", "/api/auth/steward-session");

    expect(
      consumeStewardServerCookieSynced("token-b", "/api/auth/steward-session"),
    ).toBe(false);
    expect(
      consumeStewardServerCookieSynced("token-a", "/api/auth/steward-session"),
    ).toBe(false);
  });

  it("fails closed and invalidates authority on an endpoint mismatch", () => {
    markStewardServerCookieSynced(
      "token-a",
      "https://preview.example/api/auth/steward-session",
    );

    expect(
      consumeStewardServerCookieSynced(
        "token-a",
        "https://api.example/api/auth/steward-session",
      ),
    ).toBe(false);
    expect(
      consumeStewardServerCookieSynced(
        "token-a",
        "https://preview.example/api/auth/steward-session",
      ),
    ).toBe(false);
  });

  it("retires an unconsumed proof when session authority is cleared", () => {
    markStewardServerCookieSynced("token-a", "/api/auth/steward-session");

    invalidateStewardServerCookieSyncMarker();

    expect(
      consumeStewardServerCookieSynced("token-a", "/api/auth/steward-session"),
    ).toBe(false);
  });
});
