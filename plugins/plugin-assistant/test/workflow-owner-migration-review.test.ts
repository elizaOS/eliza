import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";
import { calculateDiff } from "../../plugin-sql/src/runtime-migrator/drizzle-adapters/diff-calculator";
import { generateSnapshot } from "../../plugin-sql/src/runtime-migrator/drizzle-adapters/snapshot-generator";
import {
  checkForDataLoss,
  generateMigrationSQL,
} from "../../plugin-sql/src/runtime-migrator/drizzle-adapters/sql-generator";
import { clientDeviceTable } from "../../plugin-sql/src/schema/clientDevices";

test("runtime migration adds nullable workflow ownership without changing a legacy enrollment", async () => {
  const current = await generateSnapshot({ clientDeviceTable }),
    before = structuredClone(current);
  const name = Object.keys(before.tables).find(
    (k) => before.tables[k].name === "client_devices",
  )!;
  expect(name).toBeTruthy();
  delete before.tables[name].columns.workflow_owner_id;
  const diff = await calculateDiff(before, current),
    risk = checkForDataLoss(diff),
    statements = await generateMigrationSQL(before, current, diff);
  expect(risk.hasDataLoss).toBe(false);
  expect(risk.requiresConfirmation).toBe(false);
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain("ADD COLUMN IF NOT EXISTS");
  expect(statements[0]).toContain("workflow_owner_id");
  const pg = new PGlite();
  try {
    await pg.exec(
      "CREATE TABLE client_devices(subject_user_id text,key_hash text,enrollment_id text); INSERT INTO client_devices VALUES('legacy-paired-subject','retained-key-hash','retained-enrollment');",
    );
    for (const statement of statements) await pg.exec(statement);
    expect((await pg.query("SELECT * FROM client_devices")).rows).toEqual([
      {
        subject_user_id: "legacy-paired-subject",
        key_hash: "retained-key-hash",
        enrollment_id: "retained-enrollment",
        workflow_owner_id: null,
      },
    ]);
    for (const statement of statements) await pg.exec(statement);
    expect(
      (await pg.query("SELECT count(*)::int AS count FROM client_devices"))
        .rows[0],
    ).toEqual({ count: 1 });
  } finally {
    await pg.close();
  }
}, 120000);

test("runtime migration adds nullable view profile without changing a legacy enrollment", async () => {
  const current = await generateSnapshot({ clientDeviceTable }),
    before = structuredClone(current);
  const name = Object.keys(before.tables).find(
    (k) => before.tables[k].name === "client_devices",
  )!;
  expect(name).toBeTruthy();
  delete before.tables[name].columns.view_profile;
  const diff = await calculateDiff(before, current),
    risk = checkForDataLoss(diff),
    statements = await generateMigrationSQL(before, current, diff);
  expect(risk.hasDataLoss).toBe(false);
  expect(risk.requiresConfirmation).toBe(false);
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain("ADD COLUMN IF NOT EXISTS");
  expect(statements[0]).toContain("view_profile");
  const pg = new PGlite();
  try {
    await pg.exec(
      "CREATE TABLE client_devices(subject_user_id text,key_hash text,enrollment_id text); INSERT INTO client_devices VALUES('legacy-paired-subject','retained-key-hash','retained-enrollment');",
    );
    for (const statement of statements) await pg.exec(statement);
    expect((await pg.query("SELECT * FROM client_devices")).rows).toEqual([
      {
        subject_user_id: "legacy-paired-subject",
        key_hash: "retained-key-hash",
        enrollment_id: "retained-enrollment",
        view_profile: null,
      },
    ]);
    for (const statement of statements) await pg.exec(statement);
    expect(
      (await pg.query("SELECT count(*)::int AS count FROM client_devices"))
        .rows[0],
    ).toEqual({ count: 1 });
  } finally {
    await pg.close();
  }
}, 120000);
