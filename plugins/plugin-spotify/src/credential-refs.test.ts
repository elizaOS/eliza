import { CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { persistSpotifyCredentialRefs, readCredentialValue } from "./credential-refs";

function runtimeWithServices(services: Record<string, unknown>) {
  return {
    agentId: "agent-1",
    getService(type: string) {
      return services[type] ?? null;
    },
  };
}

describe("readCredentialValue failover", () => {
  it("currently rejects when the connector credential store read throws (degenerate case: no failover to the vault yet)", async () => {
    // Degenerate case pinned for now: unlike the write path
    // (writeWithFirstAvailableVault), the read path does not fail over when
    // the first available store throws — the rejection propagates and the
    // vault fallback is never consulted. Fixing this requires the read path
    // to mirror the write path's per-writer try/catch failover.
    const store = {
      getSecret: vi.fn().mockRejectedValue(new Error("store unavailable")),
    };
    const vault = { get: vi.fn().mockResolvedValue("s3cr3t-value") };
    const runtime = runtimeWithServices({
      connector_credential_store: store,
      vault,
    });
    await expect(
      readCredentialValue(runtime, "connector.agent-1.spotify.acct.tokens")
    ).rejects.toThrow("store unavailable");
    expect(store.getSecret).toHaveBeenCalledWith({
      vaultRef: "connector.agent-1.spotify.acct.tokens",
    });
    expect(vault.get).not.toHaveBeenCalled();
  });

  it("falls through to the vault when the store returns null", async () => {
    const runtime = runtimeWithServices({
      connector_credential_store: {
        getSecret: vi.fn().mockResolvedValue(null),
      },
      vault: { get: vi.fn().mockResolvedValue("vault-value") },
    });
    await expect(readCredentialValue(runtime, "ref")).resolves.toBe("vault-value");
  });

  it("propagates the first reader failure when the store read throws (no aggregation today)", async () => {
    // Degenerate case pinned for now: the read path surfaces the raw store
    // error instead of an aggregated reader summary.
    const runtime = runtimeWithServices({
      connector_credential_store: {
        getSecret: vi.fn().mockRejectedValue(new Error("store down")),
      },
      vault: { get: vi.fn().mockRejectedValue(new Error("vault down")) },
    });
    await expect(readCredentialValue(runtime, "ref")).rejects.toThrow("store down");
  });

  it("returns the store value without consulting the vault", async () => {
    const store = { getSecret: vi.fn().mockResolvedValue("direct-value") };
    const vault = { get: vi.fn() };
    const runtime = runtimeWithServices({
      connector_credential_store: store,
      vault,
    });
    await expect(readCredentialValue(runtime, "ref")).resolves.toBe("direct-value");
    expect(vault.get).not.toHaveBeenCalled();
  });

  it("returns undefined when no durable reader is available", async () => {
    const runtime = runtimeWithServices({});
    await expect(readCredentialValue(runtime, "ref")).resolves.toBeUndefined();
  });
});

describe("persistSpotifyCredentialRefs fail-closed gate", () => {
  it("refuses to persist when no durable writer exists", async () => {
    const runtime = runtimeWithServices({});
    await expect(
      persistSpotifyCredentialRefs({
        runtime,
        provider: "spotify",
        accountId: "acct-1",
        credentials: [{ credentialType: "oauth.tokens", value: "token" }],
        caller: "test",
      })
    ).rejects.toThrow(/No durable connector credential store or vault writer/);
  });

  it("refuses to persist when no credential ref writer exists", async () => {
    const runtime = runtimeWithServices({
      connector_credential_store: {
        putSecret: vi.fn().mockResolvedValue("connector.agent-1.spotify.acct-1.oauth_tokens"),
      },
    });
    await expect(
      persistSpotifyCredentialRefs({
        runtime,
        provider: "spotify",
        accountId: "acct-1",
        credentials: [{ credentialType: "oauth.tokens", value: "token" }],
        caller: "test",
      })
    ).rejects.toThrow(/No durable connector credential ref writer/);
  });

  it("sanitizes vault ref segments and records the ref on the account", async () => {
    const store = {
      putSecret: vi.fn(({ vaultRef }: { vaultRef: string }) => vaultRef),
    };
    const refWriter = {
      setConnectorAccountCredentialRef: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = runtimeWithServices({
      connector_credential_store: store,
      [CONNECTOR_ACCOUNT_STORAGE_SERVICE_TYPE]: refWriter,
    });
    const result = await persistSpotifyCredentialRefs({
      runtime,
      provider: "my.provider/weird",
      accountId: "acct..id!",
      credentials: [
        {
          credentialType: "oauth.tokens",
          value: "token-value",
          expiresAt: 1_800_000_000_000,
        },
      ],
      caller: "test-caller",
    });
    expect(store.putSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultRef: "connector.agent-1.my_provider_weird.acct_id.oauth_tokens",
        provider: "my.provider/weird",
        accountId: "acct..id!",
        credentialType: "oauth.tokens",
        value: "token-value",
        caller: "test-caller",
      })
    );
    expect(refWriter.setConnectorAccountCredentialRef).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct..id!",
        credentialType: "oauth.tokens",
        vaultRef: "connector.agent-1.my_provider_weird.acct_id.oauth_tokens",
        expiresAt: 1_800_000_000_000,
      })
    );
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0].credentialType).toBe("oauth.tokens");
  });
});
