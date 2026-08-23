/**
 * ConnectorSetupService unit coverage: config round-trip, owner-contact
 * persistence, escalation-channel registration, workspace resolution, the
 * WebSocket broadcast seam, and credential-store fallbacks. Isolated in a
 * throwaway state dir so loadElizaConfig / saveElizaConfig run for real.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPE } from "./connector-credential-store.ts";
import { ConnectorSetupService } from "./connector-setup-service.ts";

const originalEnv = {
  ELIZA_CONFIG_PATH: process.env.ELIZA_CONFIG_PATH,
  ELIZA_PERSIST_CONFIG_PATH: process.env.ELIZA_PERSIST_CONFIG_PATH,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  ELIZA_WORKSPACE_DIR: process.env.ELIZA_WORKSPACE_DIR,
};

let tempStateDir: string;
let workspaceDir: string;

function restoreEnv(
  key: keyof typeof originalEnv,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tempStateDir = mkdtempSync(join(tmpdir(), "eliza-connector-setup-"));
  workspaceDir = join(tempStateDir, "workspace");
  const configPath = join(tempStateDir, "eliza.json");
  process.env.ELIZA_STATE_DIR = tempStateDir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  process.env.ELIZA_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    restoreEnv(key as keyof typeof originalEnv, value);
  }
  rmSync(tempStateDir, { recursive: true, force: true });
});

function runtimeWithStore(store: unknown): IAgentRuntime {
  return {
    agentId: "agent-1",
    getService: (type: string) =>
      type === CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPE ? store : null,
  } as unknown as IAgentRuntime;
}

function memoryCredentialStore() {
  const values = new Map<string, string>();
  return {
    values,
    async putSecret(params: {
      agentId: string;
      provider: string;
      accountId: string;
      credentialType: string;
      value: string;
    }): Promise<string> {
      const ref = [
        "connector",
        params.agentId,
        params.provider,
        params.accountId,
        params.credentialType,
      ].join(".");
      values.set(ref, params.value);
      return ref;
    },
    async remove(ref: string): Promise<void> {
      values.delete(ref);
    },
  };
}

async function startedService(
  store: unknown = null,
): Promise<ConnectorSetupService> {
  const instance = await ConnectorSetupService.start(runtimeWithStore(store));
  return instance as ConnectorSetupService;
}

describe("ConnectorSetupService", () => {
  it("starts with the connector-setup service type and clears broadcast on stop", async () => {
    const delivered: object[] = [];
    const service = await startedService();
    expect(ConnectorSetupService.serviceType).toBe("connector-setup");
    expect(service.capabilityDescription).toMatch(/connector setup/i);

    service.setBroadcastWs((data) => {
      delivered.push(data);
    });
    service.broadcastWs({ event: "before-stop" });
    await service.stop();
    service.broadcastWs({ event: "after-stop" });
    expect(delivered).toEqual([{ event: "before-stop" }]);
  });

  it("round-trips config through the real load/save path", async () => {
    const service = await startedService();
    const empty = service.getConfig();
    expect(empty.logging).toEqual({ level: "error" });

    service.persistConfig({
      logging: { level: "warn" },
      plugins: {
        entries: { "connector-setup-coverage": { enabled: true } },
      },
    });
    expect(service.getConfig().logging).toEqual({ level: "warn" });
    expect(
      (
        service.getConfig().plugins as {
          entries: Record<string, { enabled: boolean }>;
        }
      ).entries["connector-setup-coverage"],
    ).toEqual({ enabled: true });
  });

  it("updateConfig loads, mutates, and persists in one pass", async () => {
    const service = await startedService();
    service.updateConfig((config) => {
      config.logging = { level: "info" };
    });
    expect(service.getConfig().logging).toEqual({ level: "info" });
  });

  it("registers a new escalation channel and rejects empty, whitespace, and duplicates", async () => {
    const service = await startedService();
    expect(service.registerEscalationChannel("")).toBe(false);
    expect(service.registerEscalationChannel("   ")).toBe(false);
    expect(service.registerEscalationChannel("Telegram")).toBe(true);
    expect(service.registerEscalationChannel("telegram")).toBe(false);

    const channels = (
      service.getConfig() as {
        agents?: { defaults?: { escalation?: { channels?: string[] } } };
      }
    ).agents?.defaults?.escalation?.channels;
    expect(channels?.[0]).toBe("client_chat");
    expect(channels).toContain("telegram");
  });

  it("persists owner contacts only when the entry actually changes", async () => {
    const service = await startedService();
    expect(service.setOwnerContact({ source: "" })).toBe(false);
    expect(service.setOwnerContact({ source: "telegram" })).toBe(false);

    expect(
      service.setOwnerContact({
        source: "telegram",
        channelId: "42",
        entityId: "ent-1",
      }),
    ).toBe(true);
    expect(
      service.setOwnerContact({
        source: "telegram",
        channelId: "42",
        entityId: "ent-1",
      }),
    ).toBe(false);
    expect(
      service.setOwnerContact({
        source: "telegram",
        channelId: "99",
        entityId: "ent-1",
      }),
    ).toBe(true);

    const contacts = (
      service.getConfig() as {
        agents?: {
          defaults?: {
            ownerContacts?: Record<string, { channelId?: string }>;
          };
        };
      }
    ).agents?.defaults?.ownerContacts;
    expect(contacts?.telegram).toEqual({
      channelId: "99",
      entityId: "ent-1",
    });
  });

  it("resolves the workspace from ELIZA_WORKSPACE_DIR", async () => {
    const service = await startedService();
    expect(service.getWorkspaceDir()).toBe(workspaceDir);
  });

  it("broadcasts only while a WebSocket function is installed", async () => {
    const delivered: object[] = [];
    const service = await startedService();
    service.broadcastWs({ event: "no-listener" });
    expect(delivered).toEqual([]);

    service.setBroadcastWs((data) => {
      delivered.push(data);
    });
    service.broadcastWs({ event: "open" });
    service.setBroadcastWs(null);
    service.broadcastWs({ event: "closed" });
    expect(delivered).toEqual([{ event: "open" }]);
  });
});

describe("ConnectorSetupService credential persistence", () => {
  const input = {
    provider: "telegram",
    accountId: "42",
    credentialType: "bot-token",
    value: "never-return-this-token",
    caller: "test",
  };

  it("stores material through the credential store and returns only a vault sentinel", async () => {
    const store = memoryCredentialStore();
    const service = await startedService(store);
    const reference = await service.persistConnectorCredential(input);

    expect(reference).toBe("vault://connector.agent-1.telegram.42.bot-token");
    expect(store.values.get("connector.agent-1.telegram.42.bot-token")).toBe(
      "never-return-this-token",
    );
  });

  it("falls back to null when the encrypted store is missing or has no putSecret", async () => {
    const missing = await startedService(null);
    await expect(missing.persistConnectorCredential(input)).resolves.toBeNull();

    const noPut = await startedService({
      remove: async () => undefined,
    });
    await expect(noPut.persistConnectorCredential(input)).resolves.toBeNull();
  });

  it("falls back to null when putSecret rejects without echoing the secret", async () => {
    const service = await startedService({
      putSecret: async () => {
        throw new Error("keychain failed");
      },
    });
    await expect(service.persistConnectorCredential(input)).resolves.toBeNull();
  });

  it("removes a present vault reference and treats a missing key as success when remove resolves", async () => {
    const store = memoryCredentialStore();
    const service = await startedService(store);
    const reference = await service.persistConnectorCredential(input);
    if (reference === null) {
      throw new Error("expected a vault sentinel from persist");
    }

    await expect(
      service.removeConnectorCredentialReference(reference),
    ).resolves.toBe(true);
    expect(store.values.size).toBe(0);

    await expect(
      service.removeConnectorCredentialReference(reference),
    ).resolves.toBe(true);
  });

  it("rejects plaintext, empty, and prefix-only references without touching the store", async () => {
    const store = memoryCredentialStore();
    const service = await startedService(store);
    await service.persistConnectorCredential(input);

    await expect(
      service.removeConnectorCredentialReference("plaintext"),
    ).resolves.toBe(false);
    await expect(service.removeConnectorCredentialReference("")).resolves.toBe(
      false,
    );
    await expect(
      service.removeConnectorCredentialReference("vault://"),
    ).resolves.toBe(false);
    expect(store.values.size).toBe(1);
  });

  it("returns false when the store is missing, has no remove, or remove rejects", async () => {
    const present = "vault://connector.agent-1.telegram.42.bot-token";

    const noStore = await startedService(null);
    await expect(
      noStore.removeConnectorCredentialReference(present),
    ).resolves.toBe(false);

    const noRemove = await startedService({
      putSecret: async () => "connector.agent-1.telegram.42.bot-token",
    });
    await expect(
      noRemove.removeConnectorCredentialReference(present),
    ).resolves.toBe(false);

    const throwing = await startedService({
      putSecret: async () => "unused",
      remove: async () => {
        throw new Error("vault miss");
      },
    });
    await expect(
      throwing.removeConnectorCredentialReference(present),
    ).resolves.toBe(false);
  });
});
