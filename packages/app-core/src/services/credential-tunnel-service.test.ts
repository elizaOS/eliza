import { describe, expect, it, vi } from "vitest";
import {
  type CredentialBridgeDispatch,
  type CredentialBridgeDispatchInput,
  CredentialScopeError,
  createCredentialTunnelService,
  createSubAgentCredentialBridgeAdapter,
} from "./credential-tunnel-service.ts";

describe("credential-tunnel-service", () => {
  it("declareScope returns a 64-char hex token, a scope id, and an unexpired expiry", () => {
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

describe("createSubAgentCredentialBridgeAdapter", () => {
  function makeDispatch(): CredentialBridgeDispatch & {
    calls: CredentialBridgeDispatchInput[];
  } {
    const calls: CredentialBridgeDispatchInput[] = [];
    return {
      calls,
      dispatch: vi.fn(async (input: CredentialBridgeDispatchInput) => {
        calls.push(input);
        return { sensitiveRequestIds: [`req_${input.credentialScopeId}`] };
      }),
    };
  }

  it("requestCredentials declares a scope and dispatches a secret request with tunnel routing", async () => {
    const tunnel = createCredentialTunnelService();
    const dispatch = makeDispatch();
    const adapter = createSubAgentCredentialBridgeAdapter({ tunnel, dispatch });

    const result = await adapter.requestCredentials({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });

    expect(result.credentialScopeId).toMatch(/^cred_scope_[0-9a-f]{16}$/);
    expect(result.scopedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.sensitiveRequestIds).toEqual([
      `req_${result.credentialScopeId}`,
    ]);

    // The dispatcher receives identifiers only — never the scoped token.
    expect(dispatch.calls).toHaveLength(1);
    const dispatched = dispatch.calls[0];
    expect(dispatched).toMatchObject({
      childSessionId: "pty-1-abc",
      credentialScopeId: result.credentialScopeId,
      credentialKeys: ["OPENAI_API_KEY"],
      actorPolicy: "owner_only",
      deliveryTarget: "owner_app_inline",
    });
    expect(JSON.stringify(dispatched)).not.toContain(result.scopedToken);
  });

  it("declareScope honours an explicit actorPolicy / deliveryTarget", async () => {
    const tunnel = createCredentialTunnelService();
    const dispatch = makeDispatch();
    const adapter = createSubAgentCredentialBridgeAdapter({ tunnel, dispatch });

    const scope = await adapter.declareScope({
      childSessionId: "pty-1-abc",
      credentialKeys: ["STRIPE_KEY"],
      actorPolicy: "owner_or_linked_identity",
      deliveryTarget: "dm",
    });

    expect(scope.sensitiveRequestIds).toEqual([
      `req_${scope.credentialScopeId}`,
    ]);
    expect(dispatch.calls[0]).toMatchObject({
      actorPolicy: "owner_or_linked_identity",
      deliveryTarget: "dm",
    });
  });

  it("tunnelCredential → tryRetrieveCredential is one-shot; the second retrieve rejects already_redeemed", async () => {
    const tunnel = createCredentialTunnelService();
    const adapter = createSubAgentCredentialBridgeAdapter({
      tunnel,
      dispatch: makeDispatch(),
    });

    const scope = await adapter.requestCredentials({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });

    // Before tunneling: pending (owner has not submitted the value).
    expect(
      await adapter.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ status: "pending" });

    await adapter.tunnelCredential({
      childSessionId: "pty-1-abc",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-secret",
    });

    expect(
      await adapter.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ status: "ready", value: "sk-secret" });

    // One-shot: a second retrieve is terminal.
    expect(
      await adapter.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toMatchObject({ status: "rejected" });
  });

  it("maps key_not_in_scope to a rejected retrieve and rejects tunnel of an undeclared key", async () => {
    const tunnel = createCredentialTunnelService();
    const adapter = createSubAgentCredentialBridgeAdapter({
      tunnel,
      dispatch: makeDispatch(),
    });
    const scope = await adapter.requestCredentials({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });

    await expect(
      adapter.tunnelCredential({
        childSessionId: "pty-1-abc",
        credentialScopeId: scope.credentialScopeId,
        key: "AWS_SECRET",
        value: "x",
      }),
    ).rejects.toMatchObject({ code: "key_not_in_scope" });

    expect(
      await adapter.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "AWS_SECRET",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ status: "rejected", reason: "key_not_in_scope" });
  });

  it("maps scope_expired to an expired retrieve", async () => {
    let clock = 1_000;
    const tunnel = createCredentialTunnelService({
      ttlMs: 100,
      now: () => clock,
    });
    const adapter = createSubAgentCredentialBridgeAdapter({
      tunnel,
      dispatch: makeDispatch(),
    });
    const scope = await adapter.requestCredentials({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });
    await adapter.tunnelCredential({
      childSessionId: "pty-1-abc",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-secret",
    });
    clock = 100_000_000;

    expect(
      await adapter.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ status: "expired" });
  });

  it("maps session_mismatch to a rejected retrieve", async () => {
    const tunnel = createCredentialTunnelService();
    const adapter = createSubAgentCredentialBridgeAdapter({
      tunnel,
      dispatch: makeDispatch(),
    });
    const scope = await adapter.requestCredentials({
      childSessionId: "pty-1-aaa",
      credentialKeys: ["OPENAI_API_KEY"],
    });
    await adapter.tunnelCredential({
      childSessionId: "pty-1-aaa",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-secret",
    });

    expect(
      await adapter.tryRetrieveCredential({
        childSessionId: "pty-1-bbb",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ status: "rejected", reason: "session_mismatch" });
  });

  it("maps an invalid scoped token to a rejected retrieve", async () => {
    const tunnel = createCredentialTunnelService();
    const adapter = createSubAgentCredentialBridgeAdapter({
      tunnel,
      dispatch: makeDispatch(),
    });
    await adapter.requestCredentials({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });

    expect(
      await adapter.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: "not-a-valid-token",
      }),
    ).toEqual({ status: "rejected", reason: "invalid_token" });
  });
});
