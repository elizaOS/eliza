// Verifies the fail-closed field-encryption flags (AAD-required writes, required agent-env encryption).
import { afterEach, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";
import type { OrganizationEncryptionKey } from "../../db/schemas";

const loggedErrors: unknown[][] = [];
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => {},
    error: (...args: unknown[]) => loggedErrors.push(args),
    info: () => {},
    warn: () => {},
  },
}));

const { FieldEncryptionService, isFieldEncryptionRequired } = await import("./field-encryption");
type OrgEncryptionKeyStore = import("./field-encryption").OrgEncryptionKeyStore;
const { encryptAgentEnvVarsForStorage } = await import("./agent-env-crypto");

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SAVED = {
  FIELD_ENCRYPTION_REQUIRE_AAD: process.env.FIELD_ENCRYPTION_REQUIRE_AAD,
  FIELD_ENCRYPTION_REQUIRED: process.env.FIELD_ENCRYPTION_REQUIRED,
  ENVIRONMENT: process.env.ENVIRONMENT,
  SECRETS_MASTER_KEY: process.env.SECRETS_MASTER_KEY,
  SECRETS_MASTER_KEY_PREVIOUS: process.env.SECRETS_MASTER_KEY_PREVIOUS,
};

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("FIELD_ENCRYPTION_REQUIRE_AAD", () => {
  test("rejects a coordinate-less write before touching keys or the database", async () => {
    process.env.FIELD_ENCRYPTION_REQUIRE_AAD = "true";
    delete process.env.SECRETS_MASTER_KEY;
    const error = await rejection(new FieldEncryptionService().encrypt(ORG_ID, "secret"));
    expect(error).toMatchObject({ code: "FIELD_ENCRYPTION_AAD_REQUIRED" });
  });

  test("leaves coordinate-less writes on the legacy path when unset", async () => {
    delete process.env.FIELD_ENCRYPTION_REQUIRE_AAD;
    delete process.env.SECRETS_MASTER_KEY;
    const error = await rejection(new FieldEncryptionService().encrypt(ORG_ID, "secret"));
    // Reaches key initialization (and fails there) instead of the AAD gate.
    expect((error as Error).message).toContain("SECRETS_MASTER_KEY must be set");
  });
});

describe("required agent-env encryption", () => {
  test("deployed environments and the explicit flag require encryption", () => {
    expect(isFieldEncryptionRequired({ ENVIRONMENT: "production" })).toBe(true);
    expect(isFieldEncryptionRequired({ ENVIRONMENT: "staging" })).toBe(true);
    expect(isFieldEncryptionRequired({ FIELD_ENCRYPTION_REQUIRED: "true" })).toBe(true);
    expect(isFieldEncryptionRequired({ ENVIRONMENT: "local", NODE_ENV: "development" })).toBe(
      false,
    );
    expect(isFieldEncryptionRequired({})).toBe(false);
  });

  test("throws instead of storing plaintext secrets when encryption is required", async () => {
    delete process.env.SECRETS_MASTER_KEY;
    process.env.ENVIRONMENT = "production";
    const error = await rejection(
      encryptAgentEnvVarsForStorage(ORG_ID, { OPENAI_API_KEY: "sk-live", LOG_LEVEL: "info" }),
    );
    expect(error).toMatchObject({ code: "AGENT_ENV_ENCRYPTION_REQUIRED" });
    expect((error as Error).message).not.toContain("sk-live");
  });

  test("keeps the legacy plaintext path for local development", async () => {
    delete process.env.SECRETS_MASTER_KEY;
    delete process.env.FIELD_ENCRYPTION_REQUIRED;
    process.env.ENVIRONMENT = "local";
    const stored = await encryptAgentEnvVarsForStorage(ORG_ID, { OPENAI_API_KEY: "sk-dev" });
    expect(stored).toEqual({ OPENAI_API_KEY: "sk-dev" });
  });
});

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const COORDS = { table: "llm_trajectories", rowId: "row-1", column: "payload" };

function memoryStore(): OrgEncryptionKeyStore & { rows: Map<string, OrganizationEncryptionKey> } {
  const rows = new Map<string, OrganizationEncryptionKey>();
  const byOrg = async (organizationId: string) =>
    [...rows.values()].find((row) => row.organization_id === organizationId);
  return {
    rows,
    findByOrgId: byOrg,
    findByOrgIdPrimary: byOrg,
    findById: async (keyId) => rows.get(keyId),
    insertIfAbsent: async (organizationId, encryptedDek) => {
      if (await byOrg(organizationId)) return undefined;
      const row: OrganizationEncryptionKey = {
        id: crypto.randomUUID(),
        organization_id: organizationId,
        encrypted_dek: encryptedDek,
        key_version: 1,
        algorithm: "aes-256-gcm",
        created_at: new Date(),
        rotated_at: null,
      };
      rows.set(row.id, row);
      return row;
    },
    updateWrappedDek: async (keyId, expectedVersion, encryptedDek, nextVersion) => {
      const row = rows.get(keyId);
      if (!row || row.key_version !== expectedVersion) return undefined;
      const updated = {
        ...row,
        encrypted_dek: encryptedDek,
        key_version: nextVersion,
        rotated_at: new Date(),
      };
      rows.set(keyId, updated);
      return updated;
    },
  };
}

function useMasterKeys(current: string, previous?: string): void {
  delete process.env.FIELD_ENCRYPTION_REQUIRE_AAD;
  process.env.SECRETS_MASTER_KEY = current;
  if (previous) process.env.SECRETS_MASTER_KEY_PREVIOUS = previous;
  else delete process.env.SECRETS_MASTER_KEY_PREVIOUS;
}

function unwrapDek(row: OrganizationEncryptionKey, masterHex: string): Buffer {
  const [n, t, c] = row.encrypted_dek.split(":").map((part) => Buffer.from(part, "base64"));
  const unwrap = crypto.createDecipheriv("aes-256-gcm", Buffer.from(masterHex, "hex"), n);
  unwrap.setAuthTag(t);
  return Buffer.concat([unwrap.update(c), unwrap.final()]);
}

/**
 * The pre-v2 reader, verbatim in behaviour: accepts only 6-part enc:v1 and
 * decrypts without AAD. New coordinate-less writes must stay readable by it.
 */
function oldReaderDecrypt(value: string, row: OrganizationEncryptionKey, masterHex: string) {
  const parts = value.split(":");
  if (parts.length !== 6 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error(`Unsupported encryption format: ${parts[0]}:${parts[1]}`);
  }
  const [nonce, tag, ct] = parts.slice(3).map((part) => Buffer.from(part, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", unwrapDek(row, masterHex), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Build an unbound enc:v2:...:n envelope (readable, never written by the service). */
function v2Unbound(row: OrganizationEncryptionKey, masterHex: string, plaintext: string): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", unwrapDek(row, masterHex), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([`enc:v2:${row.id}:n`])));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["enc", "v2", row.id, "n", nonce, cipher.getAuthTag(), ct]
    .map((part) => (Buffer.isBuffer(part) ? part.toString("base64") : part))
    .join(":");
}

/** Build a legacy enc:v1 envelope directly from the stored DEK. */
function legacyV1(
  row: OrganizationEncryptionKey,
  masterHex: string,
  plaintext: string,
  coords?: typeof COORDS,
): string {
  const dek = unwrapDek(row, masterHex);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dek, nonce);
  if (coords) cipher.setAAD(Buffer.from(`${coords.table}|${coords.rowId}|${coords.column}`));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["enc", "v1", row.id, nonce, cipher.getAuthTag(), ct]
    .map((part) => (Buffer.isBuffer(part) ? part.toString("base64") : part))
    .join(":");
}

describe("envelope v2", () => {
  test("coordinate-less writes keep the legacy v1 envelope that pre-v2 readers decrypt", async () => {
    useMasterKeys(KEY_A);
    const store = memoryStore();
    const service = new FieldEncryptionService(store);
    const value = await service.encrypt(ORG_ID, "secret");
    expect(value.startsWith("enc:v1:")).toBe(true);
    expect(value.split(":")).toHaveLength(6);
    expect(oldReaderDecrypt(value, [...store.rows.values()][0], KEY_A)).toBe("secret");
    expect(service.isEncrypted(value)).toBe(true);
    expect(await service.decrypt(value)).toBe("secret");
    expect(await service.decryptIfNeeded(value)).toBe("secret");
    expect(await service.encryptIfNeeded(ORG_ID, value)).toBe(value);
  });

  test("unbound v2 'n' envelopes stay readable", async () => {
    useMasterKeys(KEY_A);
    const store = memoryStore();
    const service = new FieldEncryptionService(store);
    await service.encrypt(ORG_ID, "bootstrap");
    const value = v2Unbound([...store.rows.values()][0], KEY_A, "n-value");
    expect(await service.decrypt(value)).toBe("n-value");
  });

  test("round trips with coordinates as a v2 'a' envelope and rejects mismatches", async () => {
    useMasterKeys(KEY_A);
    const service = new FieldEncryptionService(memoryStore());
    const value = await service.encrypt(ORG_ID, "phi", COORDS);
    expect(value.split(":")[3]).toBe("a");
    expect(await service.decrypt(value, COORDS)).toBe("phi");

    const moved = await rejection(service.decrypt(value, { ...COORDS, rowId: "row-2" }));
    expect(moved).toMatchObject({ code: "FIELD_ENCRYPTION_AUTH_FAILED" });
    const missing = await rejection(service.decrypt(value));
    expect(missing).toMatchObject({ code: "FIELD_ENCRYPTION_AAD_COORDS_MISSING" });
  });

  test("the AAD flag is authenticated and cannot be downgraded", async () => {
    useMasterKeys(KEY_A);
    const service = new FieldEncryptionService(memoryStore());
    const parts = (await service.encrypt(ORG_ID, "phi", COORDS)).split(":");
    parts[3] = "n";
    const error = await rejection(service.decrypt(parts.join(":")));
    expect(error).toMatchObject({ code: "FIELD_ENCRYPTION_AUTH_FAILED" });
    const relabelled = ["enc", "v1", parts[2], ...parts.slice(4)].join(":");
    expect(await rejection(service.decrypt(relabelled, COORDS))).toMatchObject({
      code: "FIELD_ENCRYPTION_AUTH_FAILED",
    });
  });

  test("rejects malformed envelopes with a typed error", async () => {
    useMasterKeys(KEY_A);
    const service = new FieldEncryptionService(memoryStore());
    for (const bad of ["enc:v2:id:x:AAAA:AAAA:AAAA", "enc:v2:id:n:AAAA", "enc:v9:a:b:c:d"]) {
      expect(await rejection(service.decrypt(bad))).toMatchObject({
        code: "FIELD_ENCRYPTION_INVALID_ENVELOPE",
      });
    }
  });

  test("legacy v1 envelopes stay readable with and without coordinates", async () => {
    useMasterKeys(KEY_A);
    const store = memoryStore();
    const service = new FieldEncryptionService(store);
    await service.encrypt(ORG_ID, "bootstrap");
    const row = [...store.rows.values()][0];
    expect(await service.decrypt(legacyV1(row, KEY_A, "old"))).toBe("old");
    expect(await service.decrypt(legacyV1(row, KEY_A, "old-aad", COORDS), COORDS)).toBe("old-aad");
    expect(service.isEncrypted(legacyV1(row, KEY_A, "x"))).toBe(true);
  });

  test("FIELD_ENCRYPTION_REQUIRE_AAD rejects v1 and v2 'n' envelopes but reads v2 'a'", async () => {
    useMasterKeys(KEY_A);
    const store = memoryStore();
    const service = new FieldEncryptionService(store);
    const bound = await service.encrypt(ORG_ID, "a", COORDS);
    const row = [...store.rows.values()][0];
    const unbound = v2Unbound(row, KEY_A, "n");
    const v1 = legacyV1(row, KEY_A, "legacy", COORDS);

    process.env.FIELD_ENCRYPTION_REQUIRE_AAD = "true";
    expect(await rejection(service.decrypt(unbound, COORDS))).toMatchObject({
      code: "FIELD_ENCRYPTION_AAD_REQUIRED",
    });
    expect(await rejection(service.decrypt(v1, COORDS))).toMatchObject({
      code: "FIELD_ENCRYPTION_AAD_REQUIRED",
    });
    expect(await service.decrypt(bound, COORDS)).toBe("a");
  });
});

describe("master key rotation", () => {
  test("unwraps DEKs with SECRETS_MASTER_KEY_PREVIOUS and rewraps them with the current key", async () => {
    useMasterKeys(KEY_A);
    const store = memoryStore();
    const value = await new FieldEncryptionService(store).encrypt(ORG_ID, "secret");

    // Operator switches to a new master key: without the previous key, reads fail closed.
    useMasterKeys(KEY_B);
    expect(await rejection(new FieldEncryptionService(store).decrypt(value))).toMatchObject({
      code: "FIELD_ENCRYPTION_DEK_UNWRAP_FAILED",
    });

    useMasterKeys(KEY_B, KEY_A);
    const rotating = new FieldEncryptionService(store);
    expect(await rotating.decrypt(value)).toBe("secret");

    const result = await rotating.rewrapOrgKeyWithCurrentMaster(ORG_ID);
    expect(result).toMatchObject({ keyVersion: 2, unwrappedWith: "previous" });
    expect([...store.rows.values()][0].key_version).toBe(2);

    // After the rewrap the previous key can be retired.
    useMasterKeys(KEY_B);
    const migrated = new FieldEncryptionService(store);
    expect(await migrated.decrypt(value)).toBe("secret");
    await migrated.rotateOrgKey(ORG_ID);
    expect([...store.rows.values()][0].key_version).toBe(3);
  });

  test("rejects malformed master keys without echoing them", async () => {
    useMasterKeys("z".repeat(64));
    const bad = await rejection(new FieldEncryptionService(memoryStore()).encrypt(ORG_ID, "x"));
    expect(bad).toMatchObject({ code: "FIELD_ENCRYPTION_MASTER_KEY_INVALID" });
    expect((bad as Error).message).not.toContain("zzzz");

    useMasterKeys(KEY_A, "123");
    const badPrevious = await rejection(
      new FieldEncryptionService(memoryStore()).encrypt(ORG_ID, "x"),
    );
    expect(badPrevious).toMatchObject({ code: "FIELD_ENCRYPTION_MASTER_KEY_INVALID" });
    expect((badPrevious as Error).message).toContain("SECRETS_MASTER_KEY_PREVIOUS");
  });
});

describe("decryptIfNeeded plaintext passthrough", () => {
  test("keeps legacy plaintext readable but logs at error level where encryption is required", async () => {
    loggedErrors.length = 0;
    process.env.ENVIRONMENT = "production";
    const service = new FieldEncryptionService(memoryStore());
    expect(await service.decryptIfNeeded("postgres://legacy")).toBe("postgres://legacy");
    expect(loggedErrors).toHaveLength(1);
    expect(JSON.stringify(loggedErrors)).not.toContain("postgres://legacy");
  });
});
