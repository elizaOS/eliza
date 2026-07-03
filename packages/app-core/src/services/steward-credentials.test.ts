import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PlatformSecureStore,
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

  async delete(vaultId: string, kind: SecureStoreSecretKind): Promise<void> {
    this.values.delete(`${vaultId}:${kind}`);
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

  it("scrubs legacy plaintext secrets even when secure store is unavailable", async () => {
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

    const loaded = await loadStewardCredentials({ secureStore });

    expect(loaded).toMatchObject({
      apiUrl: "https://legacy.local",
      tenantId: "tenant-legacy",
      agentId: "agent-legacy",
      apiKey: "",
      agentToken: "",
    });
    const raw = fs.readFileSync(credentialsPath(stateDir), "utf8");
    expect(raw).not.toContain("legacy-api-key");
    expect(raw).not.toContain("legacy-agent-token");
  });
});
