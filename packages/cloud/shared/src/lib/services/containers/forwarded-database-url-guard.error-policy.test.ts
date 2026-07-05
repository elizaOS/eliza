/**
 * Error-policy pins (#13415) for the forwarded-database-URL guard: an INTERNAL
 * failure (an unparseable/malformed forwarded header or configured URL — the
 * J3 sanitize path) must fail CLOSED, and must stay DISTINGUISHABLE from a
 * legitimately-empty trust set (no DB configured at all). Both reject, but for
 * different, non-fabricated reasons — a parse failure never widens the trusted
 * set nor reads as an authorized forward. Drives the real exported functions.
 */

import { describe, expect, it } from "bun:test";
import {
  buildTrustedDatabaseIdentitySet,
  databaseIdentityKey,
  evaluateForwardedDatabaseUrl,
} from "./forwarded-database-url-guard";

const CONFIGURED = "postgres://svc:pw@db.internal.example:5432/cloud";

describe("forwarded-database-url-guard — error-policy fail-closed", () => {
  it("J3: an unparseable forwarded URL yields the explicit null invalid-signal (not a fabricated key)", () => {
    // The catch-around-new-URL returns null; a valid URL returns a real key.
    expect(databaseIdentityKey("::::not a url::::")).toBeNull();
    expect(databaseIdentityKey(CONFIGURED)).not.toBeNull();
  });

  it("an unparseable CONFIGURED url does NOT silently widen the trusted set (drop, never add)", () => {
    const set = buildTrustedDatabaseIdentitySet({ configuredDatabaseUrl: "garbage-not-a-url" });
    expect(set.size).toBe(0);
    // A parse failure must not become a trusted identity that authorizes a forward.
    const decision = evaluateForwardedDatabaseUrl(CONFIGURED, {
      configuredDatabaseUrl: "garbage-not-a-url",
    });
    expect(decision.allowed).toBe(false);
  });

  it("distinguishes an INTERNAL parse failure from a designed-EMPTY trust set by reason", () => {
    // Internal failure: the forwarded value itself is malformed → parse-failure reason.
    const malformed = evaluateForwardedDatabaseUrl("::::bad::::", {
      configuredDatabaseUrl: CONFIGURED,
    });
    expect(malformed.allowed).toBe(false);
    if (!malformed.allowed) expect(malformed.reason).toContain("malformed");

    // Designed-empty: a well-formed forward, but NOTHING is trusted (no config,
    // empty allowlist). Still rejected, but with a DISTINCT reason — not conflated
    // with the malformed-input path, and never allowed-open.
    const noTrust = evaluateForwardedDatabaseUrl(CONFIGURED, {
      configuredDatabaseUrl: undefined,
      allowlistDatabaseUrls: [],
    });
    expect(noTrust.allowed).toBe(false);
    if (!noTrust.allowed) expect(noTrust.reason).toContain("no trusted database identity");

    // The two failure reasons are genuinely different strings.
    if (!malformed.allowed && !noTrust.allowed) {
      expect(malformed.reason).not.toBe(noTrust.reason);
    }
  });

  it("a well-formed off-allowlist identity fails closed with the mismatch reason (distinct again)", () => {
    const mismatch = evaluateForwardedDatabaseUrl(
      "postgres://attacker:pw@evil.example:5432/exfil",
      { configuredDatabaseUrl: CONFIGURED },
    );
    expect(mismatch.allowed).toBe(false);
    if (!mismatch.allowed) {
      expect(mismatch.reason).toContain("does not match the pinned");
      expect(mismatch.reason).not.toContain("malformed");
      expect(mismatch.reason).not.toContain("no trusted database identity");
    }
  });

  it("only the exact configured identity is honored — the fail-closed default is reject", () => {
    // Positive control: proves the guard is not vacuously rejecting everything.
    const ok = evaluateForwardedDatabaseUrl(CONFIGURED, { configuredDatabaseUrl: CONFIGURED });
    expect(ok.allowed).toBe(true);
  });
});
