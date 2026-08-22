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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("restores the complete prior credential set after a partial save failure", async () => {
    const secureStore = new MemorySecureStore();
    await saveStewardCredentials(
      {
        apiUrl: "https://old.steward.local",
        tenantId: "old-tenant",
        agentId: "old-agent",
        apiKey: "old-api-key",
        agentToken: "old-agent-token",
      },
      { secureStore },
    );
    const originalSet = secureStore.set.bind(secureStore);
    let writes = 0;
    secureStore.set = async (vaultId, kind, value) => {
      writes += 1;
      if (writes === 3) return { ok: false, reason: "denied" };
      return originalSet(vaultId, kind, value);
    };

    await expect(
      saveStewardCredentials(
        {
          apiUrl: "https://new.steward.local",
          tenantId: "new-tenant",
          agentId: "new-agent",
          apiKey: "new-api-key",
          agentToken: "new-agent-token",
        },
        { secureStore },
      ),
    ).rejects.toThrow(/prior values were restored/);

    const loaded = await loadStewardCredentials({ secureStore });
    expect(loaded).toMatchObject({
      apiUrl: "https://old.steward.local",
      tenantId: "old-tenant",
      agentId: "old-agent",
      apiKey: "old-api-key",
      agentToken: "old-agent-token",
    });
  });

  it("clears optional secrets instead of leaving stale prior values", async () => {
    const secureStore = new MemorySecureStore();
    await saveStewardCredentials(
      {
        apiUrl: "https://steward.local",
        tenantId: "tenant-1",
        agentId: "agent-1",
        apiKey: "old-api-key",
        agentToken: "old-agent-token",
      },
      { secureStore },
    );
    await saveStewardCredentials(
      {
        apiUrl: "https://steward.local",
        tenantId: "tenant-1",
        agentId: "agent-1",
        apiKey: "",
        agentToken: "",
      },
      { secureStore },
    );

    const loaded = await loadStewardCredentials({ secureStore });
    expect(loaded).toMatchObject({ apiKey: "", agentToken: "" });
  });

  it("writes the metadata file atomically with owner-only permissions and no leftover temp file", async () => {
    const secureStore = new MemorySecureStore();

    await saveStewardCredentials(
      {
        apiUrl: "https://steward.local",
        tenantId: "tenant-1",
        agentId: "agent-1",
        apiKey: "tenant-api-key",
        agentToken: "agent-token",
      },
      { secureStore },
    );

    const stat = fs.statSync(credentialsPath(stateDir));
    expect(stat.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(
      fs.readFileSync(credentialsPath(stateDir), "utf8"),
    );
    expect(parsed.apiUrl).toBe("https://steward.local");
    const leftovers = fs
      .readdirSync(stateDir)
      .filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("keeps the previously saved credentials readable when a metadata write is interrupted mid-write", async () => {
    const secureStore = new MemorySecureStore();
    await saveStewardCredentials(
      {
        apiUrl: "https://steward.local",
        tenantId: "tenant-1",
        agentId: "agent-1",
        apiKey: "tenant-api-key",
        agentToken: "agent-token",
        agentName: "Agent",
      },
      { secureStore },
    );

    // Simulate the process dying halfway through writing the metadata file:
    // flush half of the payload, then crash. The real module must route the
    // write through a temp file so this interruption cannot tear the live
    // steward-credentials.json.
    const realWriteFileSync = fs.writeFileSync;
    const interrupted = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(((
      target: fs.PathOrFileDescriptor,
      data,
    ) => {
      const text =
        typeof data === "string" ? data : Buffer.from(data).toString();
      realWriteFileSync(target, text.slice(0, Math.floor(text.length / 2)), {
        mode: 0o600,
      });
      throw new Error("simulated crash mid-write");
    }) as typeof fs.writeFileSync);

    let failed = false;
    try {
      await saveStewardCredentials(
        {
          apiUrl: "https://steward.local",
          tenantId: "tenant-2",
          agentId: "agent-2",
          apiKey: "tenant-api-key",
          agentToken: "agent-token",
          agentName: "Renamed",
        },
        { secureStore },
      );
    } catch {
      failed = true;
    } finally {
      interrupted.mockRestore();
    }
    expect(failed).toBe(true);

    // The torn write must never be observable: the original setup survives.
    const loaded = await loadStewardCredentials({ secureStore });
    expect(loaded).toMatchObject({
      apiUrl: "https://steward.local",
      tenantId: "tenant-1",
      agentId: "agent-1",
      agentName: "Agent",
    });
    expect(
      JSON.parse(fs.readFileSync(credentialsPath(stateDir), "utf8")),
    ).toMatchObject({ tenantId: "tenant-1" });
    const leftovers = fs
      .readdirSync(stateDir)
      .filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
