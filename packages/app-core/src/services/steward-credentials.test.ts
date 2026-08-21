/**
 * Unit tests for `saveStewardCredentials` / `loadStewardCredentials`: verifies
 * steward secrets (apiKey, agentToken) land in the PlatformSecureStore rather
 * than the plaintext metadata file, that legacy plaintext secrets are migrated
 * and scrubbed only after exact read-back, and that plaintext is retained for
 * recovery when secure storage is unavailable. Uses an in-memory secure store
 * and a temp `ELIZA_STATE_DIR`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PlatformSecureStore,
  SecureStoreDeleteResult,
  SecureStoreGetResult,
  SecureStoreSecretKind,
  SecureStoreSetResult,
} from "../security/platform-secure-store";
import {
  loadStewardCredentials,
  saveStewardCredentials,
} from "./steward-credentials";

class MemorySecureStore implements PlatformSecureStore {
  readonly backend = "none";
  readonly values = new Map<string, string>();

  constructor(private readonly available = true) {}

  async get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult> {
    const value = this.values.get(`${vaultId}:${kind}`);
    return value ? { ok: true, value } : { ok: false, reason: "not_found" };
  }

  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    this.values.set(`${vaultId}:${kind}`, value);
    return { ok: true };
  }

  async delete(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreDeleteResult> {
    const deleted = this.values.delete(`${vaultId}:${kind}`);
    return { ok: true, deleted };
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
}

function credentialsPath(stateDir: string): string {
  return path.join(stateDir, "steward-credentials.json");
}

describe("steward credentials", () => {
  let previousStateDir: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    previousStateDir = process.env.ELIZA_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-creds-"));
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("stores steward secrets in the secure store, not the metadata file", async () => {
    const secureStore = new MemorySecureStore();

    await saveStewardCredentials(
      {
        apiUrl: "https://steward.local",
        tenantId: "tenant-1",
        agentId: "agent-1",
        apiKey: "tenant-api-key",
        agentToken: "agent-token",
        walletAddresses: { evm: "0xabc" },
        agentName: "Agent",
      },
      { secureStore },
    );

    const raw = fs.readFileSync(credentialsPath(stateDir), "utf8");
    expect(raw).toContain("0xabc");
    expect(raw).not.toContain("tenant-api-key");
    expect(raw).not.toContain("agent-token");

    const loaded = await loadStewardCredentials({ secureStore });
    expect(loaded).toMatchObject({
      apiUrl: "https://steward.local",
      tenantId: "tenant-1",
      agentId: "agent-1",
      apiKey: "tenant-api-key",
      agentToken: "agent-token",
    });
  });

  it("migrates legacy plaintext secrets and scrubs the file", async () => {
    const secureStore = new MemorySecureStore();
    fs.writeFileSync(
      credentialsPath(stateDir),
      JSON.stringify(
        {
          apiUrl: "https://legacy.local",
          tenantId: "tenant-legacy",
          agentId: "agent-legacy",
          apiKey: "legacy-api-key",
          agentToken: "legacy-agent-token",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const loaded = await loadStewardCredentials({ secureStore });

    expect(loaded).toMatchObject({
      apiUrl: "https://legacy.local",
      tenantId: "tenant-legacy",
      agentId: "agent-legacy",
      apiKey: "legacy-api-key",
      agentToken: "legacy-agent-token",
    });
    const raw = fs.readFileSync(credentialsPath(stateDir), "utf8");
    expect(raw).not.toContain("legacy-api-key");
    expect(raw).not.toContain("legacy-agent-token");
  });

  it("retains legacy plaintext for recovery when secure store is unavailable", async () => {
    const secureStore = new MemorySecureStore(false);
    fs.writeFileSync(
      credentialsPath(stateDir),
      JSON.stringify(
        {
          apiUrl: "https://legacy.local",
          tenantId: "tenant-legacy",
          agentId: "agent-legacy",
          apiKey: "legacy-api-key",
          agentToken: "legacy-agent-token",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    await expect(loadStewardCredentials({ secureStore })).rejects.toThrow(
      /retained for recovery/,
    );
    const raw = fs.readFileSync(credentialsPath(stateDir), "utf8");
    expect(raw).toContain("legacy-api-key");
    expect(raw).toContain("legacy-agent-token");
  });

  it("retains legacy plaintext when native success cannot be read back", async () => {
    const secureStore = new MemorySecureStore();
    secureStore.set = async () => ({ ok: true });
    fs.writeFileSync(
      credentialsPath(stateDir),
      JSON.stringify(
        {
          apiUrl: "https://legacy.local",
          tenantId: "tenant-legacy",
          agentId: "agent-legacy",
          apiKey: "legacy-api-key",
          agentToken: "legacy-agent-token",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    await expect(loadStewardCredentials({ secureStore })).rejects.toThrow(
      /could not verify/,
    );
    const raw = fs.readFileSync(credentialsPath(stateDir), "utf8");
    expect(raw).toContain("legacy-api-key");
    expect(raw).toContain("legacy-agent-token");
  });

  it("rejects a new save when secure storage is unavailable", async () => {
    const secureStore = new MemorySecureStore(false);

    await expect(
      saveStewardCredentials(
        {
          apiUrl: "https://steward.local",
          tenantId: "tenant-1",
          agentId: "agent-1",
          apiKey: "tenant-api-key",
          agentToken: "agent-token",
        },
        { secureStore },
      ),
    ).rejects.toThrow(/were not persisted/);
    expect(fs.existsSync(credentialsPath(stateDir))).toBe(false);
  });
});
