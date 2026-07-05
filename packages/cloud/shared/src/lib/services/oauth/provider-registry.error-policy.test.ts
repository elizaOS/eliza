/**
 * Error-policy guard for the OAuth provider registry (#13415). OAuth scope
 * resolution is auth-domain and must fail closed: a caller requesting a scope
 * the app does not allow for a provider is an invariant violation that must
 * PROPAGATE (throw INVALID_SCOPE_REQUEST), never be silently narrowed to the
 * allowed subset or an empty list — silently dropping scopes would downgrade
 * the grant without the caller knowing. This asserts that failure path stays
 * distinguishable from the two legitimately-empty results: no-scopes-requested
 * (returns the designed provider defaults) and unknown-provider (returns null).
 * Pure config helpers with no env/DB dependency, so nothing is mocked.
 */

import { describe, expect, it } from "bun:test";
import { OAuthError, OAuthErrorCode } from "./errors";
import { getProvider, resolveRequestedScopes } from "./provider-registry";

describe("provider-registry error policy (#13415)", () => {
  it("propagates a disallowed-scope request instead of silently narrowing it", () => {
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist in the registry");

    const bogusScope = "https://www.googleapis.com/auth/drive.readonly.NOT_ALLOWED";

    let caught: unknown;
    try {
      resolveRequestedScopes(google, [bogusScope]);
    } catch (error) {
      caught = error;
    }

    // Fail-closed: the disallowed scope surfaces as a typed OAuthError, not a
    // filtered-down list and not an empty array.
    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as OAuthError).code).toBe(OAuthErrorCode.INVALID_SCOPE_REQUEST);
    expect((caught as OAuthError).message).toContain(bogusScope);
  });

  it("still throws when a valid scope is mixed with a disallowed one (no partial success)", () => {
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist in the registry");

    const validScope = google.defaultScopes?.[0];
    expect(validScope).toBeTruthy();

    expect(() =>
      resolveRequestedScopes(google, [validScope as string, "totally:made:up:scope"]),
    ).toThrow(OAuthError);
  });

  it("returns the designed default scopes when the caller requests none (legitimately-empty input)", () => {
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist in the registry");

    const resolved = resolveRequestedScopes(google, []);

    // Distinct from the throw path: an empty *request* yields the provider's
    // designed defaults, not an error and not an empty grant.
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved).toEqual([...new Set(google.defaultScopes)]);
  });

  it("resolves a valid subset unchanged (no over-broadening, no throw)", () => {
    const google = getProvider("google");
    if (!google) throw new Error("google provider must exist in the registry");

    const subset = [google.defaultScopes?.[0] as string];
    expect(resolveRequestedScopes(google, subset)).toEqual(subset);
  });

  it("returns null for an unknown provider (designed not-found, distinct from a thrown failure)", () => {
    expect(getProvider("definitely-not-a-real-provider")).toBeNull();
    expect(getProvider("google")).not.toBeNull();
  });
});
