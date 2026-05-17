import { describe, expect, it } from "vitest";
import {
  CredentialScopeError,
  createCredentialTunnelService,
} from "./credential-tunnel-service.ts";

describe("credential-tunnel-service", () => {
  it("declareScope returns a 64-char hex token, a scope id, and a future expiry", () => {
    const service = createCredentialTunnelService();
    const scope = service.declareScope({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });

    expect(scope.credentialScopeId).toMatch(/^cred_scope_[0-9a-f]{16}$/);
    expect(scope.scopedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(scope.expiresAt).toBeGreaterThan(Date.now());
  });

  it("tunnel + retrieve round-trips a credential value", () => {
    const service = createCredentialTunnelService();
    const scope = service.declareScope({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });

    service.tunnelCredential({
      childSessionId: "pty-1-abc",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-test-12345",
    });

    expect(
      service.hasCiphertext(scope.credentialScopeId, "OPENAI_API_KEY"),
    ).toBe(true);

    const value = service.retrieveCredential({
      childSessionId: "pty-1-abc",
      key: "OPENAI_API_KEY",
      scopedToken: scope.scopedToken,
    });

    expect(value).toBe("sk-test-12345");
  });

  it("rejects replay: retrieve a second time fails with already_redeemed", () => {
    const service = createCredentialTunnelService();
    const scope = service.declareScope({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY", "STRIPE_KEY"],
    });

    service.tunnelCredential({
      childSessionId: "pty-1-abc",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-test",
    });

    expect(
      service.retrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toBe("sk-test");

    expect(() =>
      service.retrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toThrowError(CredentialScopeError);

    try {
      service.retrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      });
    } catch (error) {
      expect((error as CredentialScopeError).code).toBe("already_redeemed");
    }
  });

  it("rejects an expired scope on retrieve", () => {
    let clock = 1_000;
    const service = createCredentialTunnelService({
      ttlMs: 100,
      now: () => clock,
    });
    const scope = service.declareScope({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });
    service.tunnelCredential({
      childSessionId: "pty-1-abc",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-test",
    });

    clock = 100_000_000;

    expect(() =>
      service.retrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toThrowError(/expired|does not match/);
  });

  it("rejects a key that was not declared in the scope", () => {
    const service = createCredentialTunnelService();
    const scope = service.declareScope({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });
    expect(() =>
      service.tunnelCredential({
        childSessionId: "pty-1-abc",
        credentialScopeId: scope.credentialScopeId,
        key: "AWS_SECRET",
        value: "x",
      }),
    ).toThrowError(/key_not_in_scope|not declared/);
  });

  it("isolates sessions: token issued for session A cannot retrieve for session B", () => {
    const service = createCredentialTunnelService();
    const scope = service.declareScope({
      childSessionId: "pty-1-aaa",
      credentialKeys: ["OPENAI_API_KEY"],
    });
    service.tunnelCredential({
      childSessionId: "pty-1-aaa",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-test",
    });

    expect(() =>
      service.retrieveCredential({
        childSessionId: "pty-1-bbb",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toThrowError(/session_mismatch|does not match/);
  });

  it("rejects retrieve before tunnel with no_ciphertext", () => {
    const service = createCredentialTunnelService();
    const scope = service.declareScope({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });
    expect(() =>
      service.retrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toThrowError(/no_ciphertext|no value tunneled/);
  });

  it("rejects an invalid scoped token shape", () => {
    const service = createCredentialTunnelService();
    expect(() =>
      service.retrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: "not-hex!",
      }),
    ).toThrowError();
  });

  it("expireScopes sweeps past-TTL scopes and returns the count", () => {
    let clock = 1_000;
    const service = createCredentialTunnelService({
      ttlMs: 100,
      now: () => clock,
    });
    service.declareScope({
      childSessionId: "pty-1-a",
      credentialKeys: ["K1"],
    });
    service.declareScope({
      childSessionId: "pty-1-b",
      credentialKeys: ["K2"],
    });
    clock = 100_000;
    expect(service.expireScopes()).toBe(2);
    expect(service.expireScopes()).toBe(0);
  });
});
