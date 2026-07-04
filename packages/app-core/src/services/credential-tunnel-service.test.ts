/**
 * Covers the credential tunnel service and its sub-agent credential bridge
 * adapter: a one-shot tunnel where a parent declares a scope (64-hex scoped token
 * + scope id + TTL), tunnels a ciphertext, and retrieves it exactly once — with
 * guards for replay, expiry, session isolation, undeclared keys, and bad token
 * shapes. Also asserts the bridge dispatches an owner-only sensitive request
 * without leaking the scoped token or value, and that registration skips
 * sandbox/child runtimes. Uses in-process services with an injected fake clock.
 */
import {
  createSensitiveRequestDispatchRegistry,
  SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
  type SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialScopeError,
  createCredentialTunnelService,
  createSubAgentCredentialBridgeAdapter,
  registerSubAgentCredentialBridgeAdapter,
  SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE,
  SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
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

  it("adapter dispatches an owner-only tunnel request without exposing scoped token or value", async () => {
    const tunnel = createCredentialTunnelService();
    const dispatch = createSensitiveRequestDispatchRegistry();
    const deliver = vi.fn(
      async (
        _args: Parameters<SensitiveRequestDeliveryAdapter["deliver"]>[0],
      ) => ({
        delivered: true,
        target: "owner_app_inline" as const,
        formRendered: true,
      }),
    );
    const adapter: SensitiveRequestDeliveryAdapter = {
      target: "owner_app_inline",
      deliver,
    };
    dispatch.register(adapter);

    const bridge = createSubAgentCredentialBridgeAdapter({
      tunnel,
      dispatch,
      runtime: { agentId: "agent-runtime-1" } as never,
    });

    const scope = await bridge.requestCredentials({
      childSessionId: "pty-1-abc",
      credentialKeys: [" OPENAI_API_KEY ", "STRIPE_KEY", "OPENAI_API_KEY"],
      origin: {
        roomId: "room-owner",
        channelId: "channel-owner",
        source: "owner_app",
        ownerEntityId: "owner-entity",
      },
    });

    expect(scope.credentialScopeId).toMatch(/^cred_scope_/);
    expect(scope.scopedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(scope.sensitiveRequestIds).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const deliveredRequest = deliver.mock.calls[0][0].request as unknown as {
      agentId: string;
      ownerEntityId: string | null;
      sourceRoomId: string | null;
      target: { key: string };
      delivery: {
        mode: string;
        tunnel?: {
          credentialScopeId: string;
          childSessionId: string;
          keys?: readonly string[];
        };
      };
    };
    expect(deliveredRequest.agentId).toBe("agent-runtime-1");
    expect(deliveredRequest.ownerEntityId).toBe("owner-entity");
    expect(deliveredRequest.sourceRoomId).toBe("room-owner");
    expect(deliveredRequest.target.key).toBe("SUB_AGENT_CREDENTIALS");
    expect(deliveredRequest.delivery.mode).toBe("inline_owner_app");
    expect(deliveredRequest.delivery.tunnel).toEqual({
      credentialScopeId: scope.credentialScopeId,
      childSessionId: "pty-1-abc",
      keys: ["OPENAI_API_KEY", "STRIPE_KEY"],
    });
    expect(JSON.stringify(deliveredRequest)).not.toContain(scope.scopedToken);
    expect(JSON.stringify(deliveredRequest)).not.toContain("sk-test-12345");

    await bridge.tunnelCredential({
      childSessionId: "pty-1-abc",
      credentialScopeId: scope.credentialScopeId,
      key: "OPENAI_API_KEY",
      value: "sk-test-12345",
    });

    expect(
      await bridge.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ status: "ready", value: "sk-test-12345" });
    expect(
      await bridge.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ status: "rejected", reason: "already_redeemed" });
  });

  it("adapter returns a scope even when no owner-app delivery adapter is registered", async () => {
    const bridge = createSubAgentCredentialBridgeAdapter({
      tunnel: createCredentialTunnelService(),
      dispatch: createSensitiveRequestDispatchRegistry(),
      runtime: { agentId: "agent-runtime-1" } as never,
    });

    const scope = await bridge.requestCredentials({
      childSessionId: "pty-1-abc",
      credentialKeys: ["OPENAI_API_KEY"],
    });

    expect(scope.scopedToken).toMatch(/^[0-9a-f]{64}$/);
    expect(scope.sensitiveRequestIds).toEqual([]);
    expect(
      await bridge.tryRetrieveCredential({
        childSessionId: "pty-1-abc",
        key: "OPENAI_API_KEY",
        scopedToken: scope.scopedToken,
      }),
    ).toEqual({ status: "pending" });
  });

  it("registerSubAgentCredentialBridgeAdapter installs parent-runtime services and skips sandboxes", () => {
    const dispatch = createSensitiveRequestDispatchRegistry();
    const services = new Map<string, unknown[]>();
    const runtime = {
      agentId: "agent-runtime-1",
      services,
      getService: vi.fn((name: string) =>
        name === SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE ? dispatch : null,
      ),
    };

    expect(
      registerSubAgentCredentialBridgeAdapter(runtime as never, {
        tunnel: createCredentialTunnelService(),
      }),
    ).toBe(true);
    expect(services.get(SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE)?.[0]).toBeTruthy();
    expect(
      services.get(SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE)?.[0],
    ).toBeTruthy();

    const sandboxServices = new Map<string, unknown[]>();
    expect(
      registerSubAgentCredentialBridgeAdapter(
        {
          agentId: "sandbox-runtime",
          services: sandboxServices,
          getService: () => dispatch,
        } as never,
        {
          tunnel: createCredentialTunnelService(),
          env: { SANDBOX_AGENT_ID: "sandbox-1" },
        },
      ),
    ).toBe(false);
    expect(sandboxServices.size).toBe(0);

    const childServices = new Map<string, unknown[]>();
    expect(
      registerSubAgentCredentialBridgeAdapter(
        {
          agentId: "child-runtime",
          services: childServices,
          getService: () => dispatch,
        } as never,
        {
          tunnel: createCredentialTunnelService(),
          env: { PARALLAX_SESSION_ID: "pty-1-child" },
        },
      ),
    ).toBe(false);
    expect(childServices.size).toBe(0);
  });
});
