/**
 * Tests the agent vault id: a deterministic sha256 over the canonical state dir
 * (base64url-truncated, stable `mldy1-` prefix) that namespaces an agent's
 * secrets in the OS keychain, plus the `<vaultId>:<kind>` keychain-account
 * derivation. The same install always resolves the same vault, and two
 * different state dirs never collide onto one keychain namespace.
 */
import { describe, expect, it } from "vitest";
import {
  deriveAgentVaultId,
  keychainAccountForSecretKind,
} from "./agent-vault-id.ts";

describe("deriveAgentVaultId", () => {
  it("is deterministic for a given state dir and prefixed", () => {
    const a = deriveAgentVaultId("/Users/x/.eliza");
    const b = deriveAgentVaultId("/Users/x/.eliza");
    expect(a).toBe(b);
    expect(a).toMatch(/^mldy1-[A-Za-z0-9_-]{16}$/);
  });

  it("distinguishes different state dirs", () => {
    expect(deriveAgentVaultId("/Users/x/.eliza")).not.toBe(
      deriveAgentVaultId("/Users/y/.eliza"),
    );
  });
});

describe("keychainAccountForSecretKind", () => {
  it("namespaces the secret kind under the vault id", () => {
    expect(keychainAccountForSecretKind("mldy1-abc", "wallet" as never)).toBe(
      "mldy1-abc:wallet",
    );
  });
});
