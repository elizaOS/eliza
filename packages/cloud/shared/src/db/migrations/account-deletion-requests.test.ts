/** Verifies account-deletion receipt migration constraints against isolated PGlite. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("./0276_account_deletion_requests.sql", import.meta.url),
  "utf8",
);
const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("0275 account deletion requests migration", () => {
  test("enforces one open request and permits an identifier-free completion receipt", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(migration);
    await database.exec(`INSERT INTO account_deletion_requests(
      user_id, organization_id, steward_user_id, execute_after
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'steward-1', now()
    )`);
    await expect(
      database.exec(`INSERT INTO account_deletion_requests(
        user_id, organization_id, steward_user_id, execute_after
      ) VALUES (
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'steward-1', now()
      )`),
    ).rejects.toThrow();

    await database.exec(`UPDATE account_deletion_requests SET
      status = 'completed', completed_at = now(),
      user_id = NULL, organization_id = NULL, steward_user_id = NULL`);
    const completed = await database.query<{
      user_id: string | null;
      organization_id: string | null;
      steward_user_id: string | null;
    }>(`SELECT user_id, organization_id, steward_user_id
        FROM account_deletion_requests WHERE status = 'completed'`);
    expect(completed.rows).toEqual([
      { user_id: null, organization_id: null, steward_user_id: null },
    ]);

    await expect(
      database.exec(`INSERT INTO account_deletion_requests(
        user_id, organization_id, steward_user_id, execute_after, status
      ) VALUES (
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'steward-1', now(), 'invented'
      )`),
    ).rejects.toThrow();
  });
});
