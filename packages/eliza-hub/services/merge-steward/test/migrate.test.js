import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { migrate } from "../src/migrate.js";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

describe("merge steward migrations", () => {
  it("applies pending migrations and records checksums", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-migrations-");
    const client = new FakeMigrationClient();
    try {
      await writeFile(
        join(dir, "001_first.sql"),
        "CREATE TABLE first_table (id text PRIMARY KEY);\n",
      );
      await writeFile(
        join(dir, "002_second.sql"),
        "CREATE TABLE second_table (id text PRIMARY KEY);\n",
      );

      const result = await migrate({
        migrationsDir: dir,
        pool: fakePool(client),
        logger: silentLogger,
      });

      assert.deepEqual(result.applied, ["001_first.sql", "002_second.sql"]);
      assert.deepEqual(result.skipped, []);
      assert.equal(client.appliedSql.length, 2);
      assert.equal(client.recorded.size, 2);
      assert.equal(client.released, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips already applied migrations and rejects checksum drift", async () => {
    const dir = await mkdtempInTestRoot("merge-steward-migrations-");
    const client = new FakeMigrationClient();
    try {
      await writeFile(
        join(dir, "001_first.sql"),
        "CREATE TABLE first_table (id text PRIMARY KEY);\n",
      );
      const first = await migrate({
        migrationsDir: dir,
        pool: fakePool(client),
        logger: silentLogger,
      });
      const second = await migrate({
        migrationsDir: dir,
        pool: fakePool(client),
        logger: silentLogger,
      });

      assert.deepEqual(first.applied, ["001_first.sql"]);
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.skipped, ["001_first.sql"]);

      await writeFile(
        join(dir, "001_first.sql"),
        "CREATE TABLE drifted_table (id text PRIMARY KEY);\n",
      );
      await assert.rejects(
        () =>
          migrate({
            migrationsDir: dir,
            pool: fakePool(client),
            logger: silentLogger,
          }),
        /checksum mismatch/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const silentLogger = Object.freeze({
  info() {},
});

function fakePool(client) {
  return {
    async connect() {
      return client;
    },
  };
}

class FakeMigrationClient {
  recorded = new Map();
  appliedSql = [];
  released = false;

  async query(sql, values = []) {
    if (/CREATE TABLE IF NOT EXISTS steward_schema_migrations/.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT checksum FROM steward_schema_migrations/.test(sql)) {
      const checksum = this.recorded.get(values[0]);
      return { rows: checksum ? [{ checksum }] : [] };
    }
    if (/INSERT INTO steward_schema_migrations/.test(sql)) {
      this.recorded.set(values[0], values[1]);
      return { rows: [] };
    }

    this.appliedSql.push(sql);
    return { rows: [] };
  }

  release() {
    this.released = true;
  }
}
