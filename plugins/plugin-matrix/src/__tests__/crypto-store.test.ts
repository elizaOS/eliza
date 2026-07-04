/**
 * Round-trips the Matrix E2E crypto store snapshot/restore (`snapshotDb` /
 * `restoreDb`) using `fake-indexeddb` and a temp dir — no real homeserver or
 * on-disk browser IndexedDB.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize as v8Deserialize, serialize as v8Serialize } from "node:v8";
import type { IAgentRuntime } from "@elizaos/core";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CryptoStoreSnapshot, MatrixService, restoreDb, snapshotDb } from "../service.js";
import type { MatrixSettings } from "../types.js";

const ACCOUNT_ID = "work";
// Non-default accounts get a per-account IndexedDB prefix so multiple encrypted
// accounts in one process don't collide on a single crypto store.
const CRYPTO_DB_NAME = `matrix-js-sdk-${ACCOUNT_ID}::matrix-sdk-crypto`;

type StoreTestState = {
  accountId: string;
  settings: MatrixSettings;
  client: Record<string, never>;
  connected: boolean;
  syncing: boolean;
  cryptoSnapshotTimer?: ReturnType<typeof setInterval>;
};

let stateRoot: string;

function openDb(
  name: string,
  version?: number,
  upgrade?: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version ? indexedDB.open(name, version) : indexedDB.open(name);
    if (upgrade) {
      request.onupgradeneeded = (event) => upgrade((event.target as IDBOpenDBRequest).result);
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getRecord(store: IDBObjectStore, key: IDBValidKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function resetIndexedDb(): void {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
}

function settings(accessToken = "token-aaa"): MatrixSettings {
  return {
    accountId: ACCOUNT_ID,
    homeserver: "https://matrix.example",
    userId: "@bot:example",
    accessToken,
    rooms: [],
    autoJoin: false,
    encryption: true,
    requireMention: false,
    enabled: true,
  };
}

function createService(accessToken = "token-aaa") {
  const runtime = { agentId: "00000000-0000-0000-0000-000000000001" } as unknown as IAgentRuntime;
  const state: StoreTestState = {
    accountId: ACCOUNT_ID,
    settings: settings(accessToken),
    client: {},
    connected: true,
    syncing: true,
  };
  const service = Object.create(MatrixService.prototype) as MatrixService;
  Object.assign(service as unknown as { runtime: IAgentRuntime; defaultAccountId: string }, {
    runtime,
    defaultAccountId: ACCOUNT_ID,
  });
  (service as unknown as { states: Map<string, StoreTestState> }).states = new Map([
    [ACCOUNT_ID, state],
  ]);
  return { service, state };
}

function callSave(service: MatrixService, state: StoreTestState): Promise<void> {
  return (
    service as unknown as { saveCryptoStore: (s: StoreTestState) => Promise<void> }
  ).saveCryptoStore(state);
}

function callRestore(service: MatrixService, state: StoreTestState): Promise<void> {
  return (
    service as unknown as { restoreCryptoStore: (s: StoreTestState) => Promise<void> }
  ).restoreCryptoStore(state);
}

function storeFilePath(): string {
  return join(stateRoot, "matrix-keys", `${ACCOUNT_ID}.enc`);
}

/** Seed the crypto db with a keyPath store (+ index) and a keyless store. */
async function seedCryptoDb(): Promise<void> {
  const db = await openDb(CRYPTO_DB_NAME, 1, (upgradeDb) => {
    const identities = upgradeDb.createObjectStore("identities", { keyPath: "id" });
    identities.createIndex("byUser", "user", { unique: false });
    upgradeDb.createObjectStore("core");
  });
  const tx = db.transaction(["identities", "core"], "readwrite");
  tx.objectStore("identities").put({
    id: "@bot:example",
    user: "@bot:example",
    ed25519: new Uint8Array([1, 2, 3, 4]),
  });
  tx.objectStore("core").put({ version: 7 }, "schema");
  await txDone(tx);
  db.close();
}

beforeEach(async () => {
  await import("fake-indexeddb/auto");
  resetIndexedDb();
  stateRoot = mkdtempSync(join(tmpdir(), "matrix-crypto-test-"));
  process.env.ELIZA_STATE_DIR = stateRoot;
});

afterEach(() => {
  delete process.env.ELIZA_STATE_DIR;
  rmSync(stateRoot, { recursive: true, force: true });
  resetIndexedDb();
});

describe("snapshotDb / restoreDb round-trip", () => {
  it("round-trips schema (keyPath + index) and records through a v8 + fresh-factory restart", async () => {
    await seedCryptoDb();

    const snapshot = await snapshotDb(CRYPTO_DB_NAME);
    // v8 round-trip mirrors the on-disk serialization path.
    const restored = v8Deserialize(v8Serialize(snapshot)) as CryptoStoreSnapshot;

    // Simulate a process restart: brand-new IndexedDB factory, empty.
    resetIndexedDb();

    await restoreDb(CRYPTO_DB_NAME, restored);

    const db = await openDb(CRYPTO_DB_NAME);
    const tx = db.transaction(["identities", "core"], "readonly");
    const identity = (await getRecord(tx.objectStore("identities"), "@bot:example")) as {
      id: string;
      ed25519: Uint8Array;
    };
    const core = (await getRecord(tx.objectStore("core"), "schema")) as { version: number };
    const indexNames = [...tx.objectStore("identities").indexNames];
    db.close();

    expect(identity.id).toBe("@bot:example");
    expect([...identity.ed25519]).toEqual([1, 2, 3, 4]);
    // Keyless store record keyed by its out-of-line key survives.
    expect(core.version).toBe(7);
    expect(indexNames).toContain("byUser");
  });
});

describe("Matrix crypto-store persistence", () => {
  it("saveCryptoStore writes an encrypted, non-plaintext, v1:-prefixed file atomically", async () => {
    await seedCryptoDb();
    const { service, state } = createService();

    await callSave(service, state);

    expect(existsSync(storeFilePath())).toBe(true);
    const onDisk = readFileSync(storeFilePath(), "utf8");
    expect(onDisk.startsWith("v1:")).toBe(true);
    expect(onDisk.split(":")).toHaveLength(4);
    // The private device key material must never appear in plaintext on disk.
    expect(onDisk).not.toContain("ed25519");
    expect(onDisk).not.toContain("@bot:example");
  });

  it("restoreCryptoStore round-trips a file written by saveCryptoStore back into IndexedDB", async () => {
    await seedCryptoDb();
    const writer = createService();
    await callSave(writer.service, writer.state);

    // Restart: fresh, empty IndexedDB factory.
    resetIndexedDb();

    const reader = createService();
    await callRestore(reader.service, reader.state);

    const db = await openDb(CRYPTO_DB_NAME);
    const identity = (await getRecord(
      db.transaction("identities", "readonly").objectStore("identities"),
      "@bot:example"
    )) as { id: string; ed25519: Uint8Array };
    db.close();
    expect(identity.id).toBe("@bot:example");
    expect([...identity.ed25519]).toEqual([1, 2, 3, 4]);
  });

  it("restoreCryptoStore with a missing file does not throw", async () => {
    const { service, state } = createService();
    await expect(callRestore(service, state)).resolves.toBeUndefined();
  });

  it("restoreCryptoStore is non-fatal on a corrupt/garbage file", async () => {
    const { service, state } = createService();
    mkdirSync(join(stateRoot, "matrix-keys"), { recursive: true });
    writeFileSync(storeFilePath(), "not-a-valid-ciphertext-at-all");
    await expect(callRestore(service, state)).resolves.toBeUndefined();
  });

  it("restoreCryptoStore is non-fatal when the token rotated (decrypt fails)", async () => {
    await seedCryptoDb();
    const writer = createService("token-aaa");
    await callSave(writer.service, writer.state);

    const reader = createService("token-bbb-rotated");
    await expect(callRestore(reader.service, reader.state)).resolves.toBeUndefined();
  });

  it("saveCryptoStore is a silent no-op when no global IndexedDB is present", async () => {
    const original = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = undefined;
    try {
      const { service, state } = createService();
      await callSave(service, state);
      expect(existsSync(storeFilePath())).toBe(false);
    } finally {
      (globalThis as { indexedDB?: IDBFactory }).indexedDB = original;
    }
  });
});
