import { describe, expect, it } from "vitest";
import {
  type CredentialTunnelService,
  createCredentialTunnelService,
} from "./credential-tunnel-service.ts";

const SID_A = "pty-1700000000000-aaaaaaaa";
const SID_B = "pty-1700000000000-bbbbbbbb";

function declareAndTunnel(
  svc: CredentialTunnelService,
  childSessionId: string,
  keys: readonly string[],
  values: Record<string, string>,
) {
  const scope = svc.declareScope({
    childSessionId,
    credentialKeys: keys,
  });
  for (const k of keys) {
    svc.tunnelCredential({
      childSessionId,
      credentialScopeId: scope.credentialScopeId,
      key: k,
      value: values[k],
    });
  }
  return scope;
}

describe("credentialTunnelService", () => {
  it("declareScope returns a hex token of expected length and a future expiry", () => {
    const svc = createCredentialTunnelService();
    const before = Date.now();
    const scope = svc.declareScope({
      childSessionId: SID_A,
      credentialKeys: ["ANTHROPIC_API_KEY"],
    });
    expect(scope.credentialScopeId).toMatch(/^cred-scope-/);
    // 32 bytes -> 64 hex chars
    expect(scope.scopedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(scope.expiresAt).toBeGreaterThanOrEqual(before);
    expect(scope.expiresAt - before).toBeLessThanOrEqual(31 * 60 * 1000);
    expect(svc.debugScopeCount()).toBe(1);
  });

  it("happy path: tunnel + retrieve returns the plaintext exactly once", () => {
    const svc = createCredentialTunnelService();
    const scope = svc.declareScope({
      childSessionId: SID_A,
      credentialKeys: ["ANTHROPIC_API_KEY"],
    });
    svc.tunnelCredential({
      childSessionId: SID_A,
      credentialScopeId: scope.credentialScopeId,
      key: "ANTHROPIC_API_KEY",
      value: "sk-ant-XYZ",
    });
    const got = svc.retrieveCredential({
      childSessionId: SID_A,
      key: "ANTHROPIC_API_KEY",
      scopedToken: scope.scopedToken,
    });
    expect(got).toEqual({ ok: true, value: "sk-ant-XYZ" });
    // Replay: same key, same token -> rejected (single-use).
    const replay = svc.retrieveCredential({
      childSessionId: SID_A,
      key: "ANTHROPIC_API_KEY",
      scopedToken: scope.scopedToken,
    });
    expect(replay).toEqual({ ok: false, error: "scope_redeemed" });
    // Ciphertext was wiped on retrieve.
    expect(svc.debugCipherCount()).toBe(0);
  });

  it("rejects retrieval with the wrong scoped token", () => {
    const svc = createCredentialTunnelService();
    declareAndTunnel(svc, SID_A, ["OPENAI_API_KEY"], {
      OPENAI_API_KEY: "sk-OAI",
    });
    const bogus = "0".repeat(64);
    const got = svc.retrieveCredential({
      childSessionId: SID_A,
      key: "OPENAI_API_KEY",
      scopedToken: bogus,
    });
    expect(got).toEqual({ ok: false, error: "unknown_token" });
  });

  it("rejects retrieval after the scope's TTL has elapsed", async () => {
    const svc = createCredentialTunnelService();
    const scope = svc.declareScope({
      childSessionId: SID_A,
      credentialKeys: ["DEEPSEEK_API_KEY"],
      ttlMs: 5,
    });
    svc.tunnelCredential({
      childSessionId: SID_A,
      credentialScopeId: scope.credentialScopeId,
      key: "DEEPSEEK_API_KEY",
      value: "secret",
    });
    await new Promise((r) => setTimeout(r, 25));
    const got = svc.retrieveCredential({
      childSessionId: SID_A,
      key: "DEEPSEEK_API_KEY",
      scopedToken: scope.scopedToken,
    });
    expect(got).toEqual({ ok: false, error: "scope_expired" });
  });

  it("rejects retrieval of a key that is not in the declared scope", () => {
    const svc = createCredentialTunnelService();
    const scope = svc.declareScope({
      childSessionId: SID_A,
      credentialKeys: ["ANTHROPIC_API_KEY"],
    });
    const got = svc.retrieveCredential({
      childSessionId: SID_A,
      key: "OPENAI_API_KEY",
      scopedToken: scope.scopedToken,
    });
    expect(got).toEqual({ ok: false, error: "key_not_in_scope" });
  });

  it("ciphertexts are isolated across child sessions", () => {
    const svc = createCredentialTunnelService();
    const scopeA = declareAndTunnel(svc, SID_A, ["ANTHROPIC_API_KEY"], {
      ANTHROPIC_API_KEY: "sk-A-secret",
    });
    const scopeB = declareAndTunnel(svc, SID_B, ["ANTHROPIC_API_KEY"], {
      ANTHROPIC_API_KEY: "sk-B-secret",
    });
    // SID_A's token cannot retrieve SID_B's secret.
    const wrongSession = svc.retrieveCredential({
      childSessionId: SID_B,
      key: "ANTHROPIC_API_KEY",
      scopedToken: scopeA.scopedToken,
    });
    expect(wrongSession).toEqual({ ok: false, error: "wrong_session" });
    // And vice versa.
    const wrongSession2 = svc.retrieveCredential({
      childSessionId: SID_A,
      key: "ANTHROPIC_API_KEY",
      scopedToken: scopeB.scopedToken,
    });
    expect(wrongSession2).toEqual({ ok: false, error: "wrong_session" });
    // Each session can still retrieve its own.
    expect(
      svc.retrieveCredential({
        childSessionId: SID_A,
        key: "ANTHROPIC_API_KEY",
        scopedToken: scopeA.scopedToken,
      }),
    ).toEqual({ ok: true, value: "sk-A-secret" });
    expect(
      svc.retrieveCredential({
        childSessionId: SID_B,
        key: "ANTHROPIC_API_KEY",
        scopedToken: scopeB.scopedToken,
      }),
    ).toEqual({ ok: true, value: "sk-B-secret" });
  });

  it("expireScopes returns expired scope ids and prevents subsequent retrieval", async () => {
    const svc = createCredentialTunnelService();
    const scope = svc.declareScope({
      childSessionId: SID_A,
      credentialKeys: ["KEY_X"],
      ttlMs: 1,
    });
    svc.tunnelCredential({
      childSessionId: SID_A,
      credentialScopeId: scope.credentialScopeId,
      key: "KEY_X",
      value: "v",
    });
    await new Promise((r) => setTimeout(r, 5));
    const expired = svc.expireScopes(Date.now());
    expect(expired).toContain(scope.credentialScopeId);
    // Ciphertext was wiped during expiry.
    expect(svc.debugCipherCount()).toBe(0);
    const got = svc.retrieveCredential({
      childSessionId: SID_A,
      key: "KEY_X",
      scopedToken: scope.scopedToken,
    });
    // Token-hash entry was dropped, so lookup returns unknown_token.
    expect(got).toEqual({ ok: false, error: "unknown_token" });
  });

  it("tunnelCredential rejects keys that are not in scope", () => {
    const svc = createCredentialTunnelService();
    const scope = svc.declareScope({
      childSessionId: SID_A,
      credentialKeys: ["A"],
    });
    expect(() =>
      svc.tunnelCredential({
        childSessionId: SID_A,
        credentialScopeId: scope.credentialScopeId,
        key: "B",
        value: "x",
      }),
    ).toThrow(/key not in scope/);
  });

  it("tunnelCredential rejects mismatched childSessionId", () => {
    const svc = createCredentialTunnelService();
    const scope = svc.declareScope({
      childSessionId: SID_A,
      credentialKeys: ["A"],
    });
    expect(() =>
      svc.tunnelCredential({
        childSessionId: SID_B,
        credentialScopeId: scope.credentialScopeId,
        key: "A",
        value: "x",
      }),
    ).toThrow(/childSessionId/);
  });

  it("multiple keys redeem independently and only flip status when all are consumed", () => {
    const svc = createCredentialTunnelService();
    const scope = declareAndTunnel(svc, SID_A, ["K1", "K2"], {
      K1: "v1",
      K2: "v2",
    });
    expect(
      svc.retrieveCredential({
        childSessionId: SID_A,
        key: "K1",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ ok: true, value: "v1" });
    // K2 still retrievable on the same token.
    expect(
      svc.retrieveCredential({
        childSessionId: SID_A,
        key: "K2",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ ok: true, value: "v2" });
    // K1 replay rejected.
    expect(
      svc.retrieveCredential({
        childSessionId: SID_A,
        key: "K1",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ ok: false, error: "scope_redeemed" });
  });

  it("declareScope rejects empty keys array", () => {
    const svc = createCredentialTunnelService();
    expect(() =>
      svc.declareScope({ childSessionId: SID_A, credentialKeys: [] }),
    ).toThrow();
  });
});
