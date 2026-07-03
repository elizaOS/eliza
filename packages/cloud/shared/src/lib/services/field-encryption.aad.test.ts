/**
 * L6 (#12229): `FieldEncryptionService` binds an optional `table|rowId|column`
 * AAD into AES-256-GCM so a ciphertext cannot be relocated to a different
 * row/column and still decrypt.
 *
 * The crypto exercised is the REAL FieldEncryptionService (AES-256-GCM, org DEK
 * wrapped by SECRETS_MASTER_KEY); only the org-key persistence (the db helpers)
 * is swapped for an in-memory store — the same boundary the sibling
 * `agent-env-crypto.test.ts` already mocks.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";

import * as realHelpersNs from "../../db/helpers";

interface OrgKeyRow {
  id: string;
  organization_id: string;
  encrypted_dek: string;
  key_version: number;
  created_at: Date;
  rotated_at: Date | null;
}
const orgKeyRows: OrgKeyRow[] = [];

const orgKeyDb = {
  query: {
    organizationEncryptionKeys: {
      findFirst: async () => orgKeyRows[0],
    },
  },
  insert: () => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          const row: OrgKeyRow = {
            id: randomUUID(),
            key_version: 1,
            created_at: new Date(),
            rotated_at: null,
            organization_id: v.organization_id as string,
            encrypted_dek: v.encrypted_dek as string,
          };
          orgKeyRows.push(row);
          return [row];
        },
      }),
    }),
  }),
};

const realHelpers = { ...realHelpersNs };
mock.module("../../db/helpers", () => ({
  ...realHelpers,
  dbRead: orgKeyDb,
  dbWrite: orgKeyDb,
}));

const prevKey = process.env.SECRETS_MASTER_KEY;
process.env.SECRETS_MASTER_KEY = "b".repeat(64);

afterAll(() => {
  if (prevKey === undefined) delete process.env.SECRETS_MASTER_KEY;
  else process.env.SECRETS_MASTER_KEY = prevKey;
});

// Import AFTER the mock + env are in place.
const { FieldEncryptionService } = await import("./field-encryption");

const ORG = "11111111-1111-1111-1111-111111111111";

describe("L6 — FieldEncryptionService AAD coordinate binding", () => {
  let svc: InstanceType<typeof FieldEncryptionService>;

  beforeEach(() => {
    svc = new FieldEncryptionService();
  });

  test("round-trips with matching coordinates", async () => {
    const coords = { table: "user_databases", rowId: "row-1", column: "user_database_uri" };
    const enc = await svc.encrypt(ORG, "postgres://secret", coords);
    expect(await svc.decrypt(enc, coords)).toBe("postgres://secret");
  });

  test("a ciphertext moved to another row fails to decrypt", async () => {
    const enc = await svc.encrypt(ORG, "postgres://secret", {
      table: "user_databases",
      rowId: "row-1",
      column: "user_database_uri",
    });
    await expect(
      svc.decrypt(enc, { table: "user_databases", rowId: "row-2", column: "user_database_uri" }),
    ).rejects.toThrow();
  });

  test("a ciphertext moved to another column fails to decrypt", async () => {
    const enc = await svc.encrypt(ORG, "postgres://secret", {
      table: "user_databases",
      rowId: "row-1",
      column: "user_database_uri",
    });
    await expect(
      svc.decrypt(enc, { table: "user_databases", rowId: "row-1", column: "backup_uri" }),
    ).rejects.toThrow();
  });

  test("an AAD-bound ciphertext cannot be read without the coordinates", async () => {
    const enc = await svc.encrypt(ORG, "postgres://secret", {
      table: "user_databases",
      rowId: "row-1",
      column: "user_database_uri",
    });
    await expect(svc.decrypt(enc)).rejects.toThrow();
  });

  test("no-coords path is unchanged (backward compatible with pre-AAD rows)", async () => {
    const enc = await svc.encrypt(ORG, "legacy-plaintext");
    expect(await svc.decrypt(enc)).toBe("legacy-plaintext");
  });
});
