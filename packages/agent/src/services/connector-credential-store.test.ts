/**
 * Unit coverage for ConnectorCredentialStoreService: the vault-backed
 * `connector_credential_store` runtime service and the host-bridge durability
 * gate that decides whether it registers. Deterministic harness — the vault is
 * an in-memory fake implementing the `@elizaos/vault` surface the service
 * touches; no keychain or PGlite is involved.
 */
import type { Vault } from "@elizaos/vault";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  hasDurableHostVault,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import {
  buildConnectorCredentialVaultRef,
  ConnectorCredentialStoreService,
} from "./connector-credential-store.ts";

function createFakeVault(): Vault & {
  entries: Map<string, string>;
  revealCalls: string[];
} {
  const entries = new Map<string, string>();
  const revealCalls: string[] = [];
  return {
    entries,
    revealCalls,
    set: async (key: string, value: string) => {
      entries.set(key, value);
    },
    setIfAbsent: async (key: string, value: string) => {
      if (entries.has(key)) return false;
      entries.set(key, value);
      return true;
    },
    setReference: async () => {},
    get: async (key: string) => {
      const value = entries.get(key);
      if (value === undefined) throw new Error(`vault miss: ${key}`);
      return value;
    },
    reveal: async (key: string, caller?: string) => {
      revealCalls.push(caller ?? "");
      const value = entries.get(key);
      if (value === undefined) throw new Error(`vault miss: ${key}`);
      return value;
    },
    has: async (key: string) => entries.has(key),
    remove: async (key: string) => {
      entries.delete(key);
    },
    quarantineUnreadable: async () => false,
    list: async () => [],
    describe: async () => null,
    stats: async () => ({
      total: 0,
      sensitive: 0,
      nonSensitive: 0,
      references: 0,
    }),
  } as Vault & { entries: Map<string, string>; revealCalls: string[] };
}

describe("ConnectorCredentialStoreService", () => {
  it("round-trips putSecret → reveal/has → remove through the vault", async () => {
    const vault = createFakeVault();
    const service = new ConnectorCredentialStoreService(undefined, vault);

    const vaultRef = await service.putSecret({
      agentId: "agent-1",
      provider: "google",
      accountId: "acct-1",
      credentialType: "oauth.tokens",
      value: "token-material",
      caller: "test",
    });
    expect(vaultRef).toBe("connector.agent-1.google.acct-1.oauth_tokens");
    expect(await service.reveal(vaultRef, "test-reader")).toBe(
      "token-material",
    );
    expect(vault.revealCalls).toContain("test-reader");
    expect(await service.has(vaultRef)).toBe(true);

    await service.remove(vaultRef);
    expect(await service.has(vaultRef)).toBe(false);
    await expect(service.reveal(vaultRef)).rejects.toThrow(/vault miss/);
  });

  it("honors an explicit vaultRef instead of deriving one", async () => {
    const vault = createFakeVault();
    const service = new ConnectorCredentialStoreService(undefined, vault);
    const explicit = "connector.a.google.b.oauth_tokens";
    const vaultRef = await service.putSecret({
      vaultRef: explicit,
      agentId: "ignored",
      provider: "ignored",
      accountId: "ignored",
      credentialType: "ignored",
      value: "v",
    });
    expect(vaultRef).toBe(explicit);
    expect(vault.entries.has(explicit)).toBe(true);
  });

  it("normalizes vault ref segments deterministically", () => {
    expect(
      buildConnectorCredentialVaultRef({
        agentId: "agent id!",
        provider: "google",
        accountId: "acct/1",
        credentialType: "oauth.tokens",
      }),
    ).toBe("connector.agent_id.google.acct_1.oauth_tokens");
  });
});

describe("hasDurableHostVault", () => {
  afterEach(() => {
    _resetAgentHostBridge();
  });

  it("is false for the no-op default bridge", () => {
    _resetAgentHostBridge();
    expect(hasDurableHostVault()).toBe(false);
  });

  it("is true when a host installs a bridge with a real vault", () => {
    const vault = createFakeVault();
    setAgentHostBridge({ ...defaultAgentHostBridge, sharedVault: () => vault });
    expect(hasDurableHostVault()).toBe(true);
  });
});
