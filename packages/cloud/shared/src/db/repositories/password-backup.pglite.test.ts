import { afterAll, beforeAll, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";

const { dbWrite, closeDatabaseConnectionsForTests } = await import("../client");
const { changePasswordBackup, MAX_PASSWORD_BACKUP_BYTES, readPasswordBackup } = await import(
  "./password-backup"
);

const owner = { appId: randomUUID(), organizationId: randomUUID(), userId: randomUUID() };
const anotherAccount = { ...owner, userId: randomUUID() };
const anotherApp = { ...owner, appId: randomUUID() };
const anotherOrganization = { ...owner, organizationId: randomUUID() };
const firstSnapshot = Buffer.from([2, 3, 6, 99]);
const secondSnapshot = Buffer.from([8, 4, 2, 11]);

beforeAll(async () => {
  await dbWrite.execute(sql`CREATE TABLE apps (id uuid PRIMARY KEY)`);
  await dbWrite.execute(sql`CREATE TABLE organizations (id uuid PRIMARY KEY)`);
  await dbWrite.execute(sql`CREATE TABLE users (id uuid PRIMARY KEY)`);
  const migration = await Bun.file(
    new URL("../migrations/0577_password_backup.sql", import.meta.url),
  ).text();
  await dbWrite.execute(sql.raw(migration));
  await dbWrite.execute(sql`INSERT INTO apps VALUES (${owner.appId}), (${anotherApp.appId})`);
  await dbWrite.execute(
    sql`INSERT INTO organizations VALUES (${owner.organizationId}), (${anotherOrganization.organizationId})`,
  );
  await dbWrite.execute(
    sql`INSERT INTO users VALUES (${owner.userId}), (${anotherAccount.userId})`,
  );
}, 90_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("a private backup round-trips, rejects stale devices, and retains only a deletion revision", async () => {
  expect(await readPasswordBackup(owner)).toBeNull();
  const attempts = await Promise.all([
    changePasswordBackup(owner, { kind: "save", expectedRevision: null, snapshot: firstSnapshot }),
    changePasswordBackup(owner, { kind: "save", expectedRevision: null, snapshot: firstSnapshot }),
  ]);
  expect(attempts).toContainEqual({ kind: "conflict" });
  expect(attempts).toContainEqual({ kind: "changed", revision: 1 });
  expect(await readPasswordBackup(owner)).toEqual({ revision: 1, snapshot: firstSnapshot });
  for (const scope of [anotherAccount, anotherApp, anotherOrganization]) {
    expect(await readPasswordBackup(scope)).toBeNull();
    expect(await changePasswordBackup(scope, { kind: "delete", expectedRevision: 1 })).toEqual({
      kind: "conflict",
    });
  }
  expect(
    await changePasswordBackup(owner, {
      kind: "save",
      expectedRevision: 1,
      snapshot: secondSnapshot,
    }),
  ).toEqual({ kind: "changed", revision: 2 });
  expect(await changePasswordBackup(owner, { kind: "delete", expectedRevision: 1 })).toEqual({
    kind: "conflict",
  });
  expect(
    await changePasswordBackup(owner, {
      kind: "save",
      expectedRevision: 2,
      snapshot: new Uint8Array(MAX_PASSWORD_BACKUP_BYTES + 1),
    }),
  ).toEqual({ kind: "invalid_size" });
  expect(await readPasswordBackup(owner)).toEqual({ revision: 2, snapshot: secondSnapshot });
  expect(await changePasswordBackup(owner, { kind: "delete", expectedRevision: 2 })).toEqual({
    kind: "changed",
    revision: 3,
  });
  expect(await readPasswordBackup(owner)).toEqual({ revision: 3, snapshot: null });
  expect(
    await changePasswordBackup(owner, {
      kind: "save",
      expectedRevision: null,
      snapshot: firstSnapshot,
    }),
  ).toEqual({ kind: "conflict" });
  expect(
    await changePasswordBackup(owner, {
      kind: "save",
      expectedRevision: 3,
      snapshot: secondSnapshot,
    }),
  ).toEqual({ kind: "changed", revision: 4 });
  await dbWrite.execute(sql`DELETE FROM users WHERE id = ${owner.userId}`);
  expect(await readPasswordBackup(owner)).toBeNull();
});
