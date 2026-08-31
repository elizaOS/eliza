/**
 * Pins the shared X identity verification contract used by OAuth2 callback
 * success projection and generic connection-catalog readiness. Deterministic:
 * no provider, secret, or environment mutation.
 */
import { describe, expect, test } from "bun:test";
import {
  normalizeXProviderIdentity,
  projectXCatalogIdentity,
  X_PROVIDER_IDENTITY_VERIFICATION_FAILED,
} from "./x-identity";

describe("X identity verification contract", () => {
  test("accepts a complete trimmed user id and username", () => {
    expect(normalizeXProviderIdentity({ userId: " 111 ", username: " alice " })).toEqual({
      userId: "111",
      username: "alice",
    });
  });

  test.each([
    { userId: undefined, username: "alice" },
    { userId: "111", username: undefined },
    { userId: "", username: "alice" },
    { userId: "111", username: "" },
    { userId: "   ", username: "alice" },
    { userId: "111", username: "   " },
    { userId: 111, username: "alice" },
    { userId: "111", username: { handle: "alice" } },
    { userId: null, username: null },
  ])("rejects incomplete or malformed identity %j", (identity) => {
    expect(normalizeXProviderIdentity(identity)).toBeNull();
  });

  test("verified identity projects as active catalog readiness", () => {
    const projected = projectXCatalogIdentity({ userId: "111", username: "alice" });
    expect(projected).toEqual({
      verified: true,
      status: "active",
      platformUserId: "111",
      username: "alice",
      displayName: "@alice",
    });
  });

  test("missing identity is not catalogued as active and does not use unknown", () => {
    const projected = projectXCatalogIdentity({ userId: null, username: undefined });
    expect(projected.verified).toBe(false);
    expect(projected.status).toBe("error");
    expect(projected.status).not.toBe("active");
    expect(projected.platformUserId).toBe("");
    expect(projected.platformUserId).not.toBe("unknown");
    expect(projected.username).toBeUndefined();
    expect(projected.displayName).toBeUndefined();
  });

  test("exports a stable redacted failure classification", () => {
    expect(X_PROVIDER_IDENTITY_VERIFICATION_FAILED).toBe("provider_identity_verification_failed");
  });
});
