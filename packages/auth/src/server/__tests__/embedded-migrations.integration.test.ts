import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { runPGLiteMigrations } from "../db/pglite.ts";

test("migration failures roll back DDL and ledger, and can be retried", async () => {
  const folder = await mkdtemp(join(tmpdir(), "login-migrations-"));
  const client = new PGlite();
  try {
    await writeFile(
      join(folder, "0000_fixture.sql"),
      "CREATE TABLE fixture (id int PRIMARY KEY); --> statement-breakpoint\nINSERT INTO fixture VALUES (1); --> statement-breakpoint\nINSERT INTO fixture VALUES (1);",
    );
    await expect(runPGLiteMigrations(client, folder)).rejects.toMatchObject({
      code: "LOGIN_MIGRATION_FAILED",
      context: { tag: "0000_fixture" },
    });
    expect(
      (await client.query("SELECT tag FROM __steward_migrations")).rows,
    ).toEqual([]);
    expect(
      (await client.query("SELECT to_regclass('fixture') AS name")).rows,
    ).toEqual([{ name: null }]);
    await writeFile(
      join(folder, "0000_fixture.sql"),
      "CREATE TABLE fixture (id int PRIMARY KEY); INSERT INTO fixture VALUES (1);",
    );
    await runPGLiteMigrations(client, folder);
    await runPGLiteMigrations(client, folder);
    expect((await client.query("SELECT * FROM fixture")).rows).toEqual([
      { id: 1 },
    ]);
    expect(
      (await client.query("SELECT tag FROM __steward_migrations")).rows,
    ).toEqual([{ tag: "0000_fixture" }]);
    await writeFile(
      join(folder, "0001_conflict.sql"),
      "CREATE TABLE fixture (different int);",
    );
    await expect(runPGLiteMigrations(client, folder)).rejects.toMatchObject({
      code: "LOGIN_MIGRATION_FAILED",
      context: { tag: "0001_conflict" },
    });
    expect(
      (await client.query("SELECT tag FROM __steward_migrations")).rows,
    ).toHaveLength(1);
  } finally {
    await client.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);
