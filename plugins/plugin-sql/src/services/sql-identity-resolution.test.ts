/**
 * Deterministic contract tests for identity mutation request digests. Database
 * transaction, rollback, restart, and race behavior is covered by the real
 * PGlite integration lane rather than mocks of the SQL authority.
 */
import { describe, expect, it } from "vitest";
import { computeIdentityRequestDigest } from "./sql-identity-resolution";

describe("computeIdentityRequestDigest", () => {
  it("is stable across object-key and principal-set order", () => {
    const first = computeIdentityRequestDigest("propose-merge", {
      agentId: "agent",
      sourcePrincipalIds: ["a", "b"],
      reason: "same",
    });
    const reordered = computeIdentityRequestDigest("propose-merge", {
      reason: "same",
      sourcePrincipalIds: ["a", "b"],
      agentId: "agent",
    });
    const changed = computeIdentityRequestDigest("propose-merge", {
      agentId: "agent",
      sourcePrincipalIds: ["b", "a"],
      reason: "same",
    });
    expect(reordered).toBe(first);
    expect(changed).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("domain-separates proposal, commit, and split", () => {
    const payload = { agentId: "agent", idempotencyKey: "same" };
    expect(
      new Set([
        computeIdentityRequestDigest("propose-merge", payload),
        computeIdentityRequestDigest("commit-merge", payload),
        computeIdentityRequestDigest("split", payload),
      ])
    ).toHaveLength(3);
  });
});
