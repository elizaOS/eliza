/** Exact append-only migration against legacy rows, entirely in-memory. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

let pg: PGlite;
let migration: string;
const quoteId = "a".repeat(64);
const quoteVersion = "personal-dedicated-v1";
const jobId = "11111111-1111-4111-8111-111111111111";
const legacyId = "22222222-2222-4222-8222-222222222222";

async function applyMigration() {
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await pg.exec(statement);
  }
}

async function insertOrigin(values: [string | null, string | null, string | null]) {
  const result = await pg.query<{ id: string }>(
    `INSERT INTO personal_dedicated_upgrade_authorities
      (originating_activation_quote_id, originating_activation_quote_version,
       originating_provision_job_id) VALUES ($1, $2, $3) RETURNING id`,
    values,
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE personal_dedicated_upgrade_authorities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL DEFAULT gen_random_uuid(),
    source_agent_id text NOT NULL DEFAULT 'personal-shared',
    dedicated_agent_id uuid NOT NULL DEFAULT gen_random_uuid(),
    cutover_token text
  );
  CREATE TABLE jobs (id uuid PRIMARY KEY);
  INSERT INTO personal_dedicated_upgrade_authorities (id) VALUES ('${legacyId}');`);
  migration = await Bun.file(
    new URL("./0386_personal_dedicated_activation_origin.sql", import.meta.url),
  ).text();
  await applyMigration();
}, 30_000);

beforeEach(async () => {
  await pg.query("DELETE FROM personal_dedicated_upgrade_authorities WHERE id <> $1", [legacyId]);
  await pg.exec("DELETE FROM jobs");
});

afterAll(async () => {
  await pg.close();
});

describe("0386 immutable Dedicated activation origin", () => {
  test("the generated snapshot extends only this authority and preserves the metadata chain", async () => {
    const previous = await Bun.file(new URL("./meta/0368_snapshot.json", import.meta.url)).json();
    const current = await Bun.file(new URL("./meta/0369_snapshot.json", import.meta.url)).json();
    expect(current.prevId).toBe(previous.id);
    expect(current.id).not.toBe(previous.id);
    const authority = current.tables["public.personal_dedicated_upgrade_authorities"];
    for (const [column, type] of [
      ["originating_activation_quote_id", "text"],
      ["originating_activation_quote_version", "text"],
      ["originating_provision_job_id", "uuid"],
    ]) {
      expect(authority.columns[column]).toEqual({
        name: column,
        type,
        primaryKey: false,
        notNull: false,
      });
      delete authority.columns[column];
    }
    expect(
      authority.checkConstraints.personal_dedicated_upgrade_authorities_activation_origin_check,
    ).toBeTruthy();
    delete authority.checkConstraints
      .personal_dedicated_upgrade_authorities_activation_origin_check;
    expect({ ...current, id: previous.id, prevId: previous.prevId }).toEqual(previous);
  });

  test("preserves legacy rows without fabricating past consent and reapplies safely", async () => {
    const id = await insertOrigin([quoteId, quoteVersion, jobId]);
    const before = await pg.query(
      "SELECT * FROM personal_dedicated_upgrade_authorities ORDER BY id",
    );
    await applyMigration();
    expect(
      (await pg.query("SELECT * FROM personal_dedicated_upgrade_authorities ORDER BY id")).rows,
    ).toEqual(before.rows);
    const legacy = await pg.query(
      "SELECT * FROM personal_dedicated_upgrade_authorities WHERE id = $1",
      [legacyId],
    );
    expect(legacy.rows[0]).toMatchObject({
      originating_activation_quote_id: null,
      originating_activation_quote_version: null,
      originating_provision_job_id: null,
    });
    expect(id).not.toBe(legacyId);
    await expect(
      pg.query(
        `UPDATE personal_dedicated_upgrade_authorities SET
      originating_activation_quote_id = $2, originating_activation_quote_version = $3,
      originating_provision_job_id = $4 WHERE id = $1`,
        [legacyId, quoteId, quoteVersion, jobId],
      ),
    ).rejects.toThrow("Dedicated activation origin is immutable");
  });

  test("rejects every partially populated receipt and malformed identities", async () => {
    for (let mask = 1; mask < 7; mask += 1) {
      await expect(
        insertOrigin([
          mask & 1 ? quoteId : null,
          mask & 2 ? quoteVersion : null,
          mask & 4 ? jobId : null,
        ]),
      ).rejects.toThrow();
    }
    for (const invalidId of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      await expect(insertOrigin([invalidId, quoteVersion, jobId])).rejects.toThrow();
    }
    for (const invalidVersion of ["", "-v1", "v 1", "x".repeat(65)]) {
      await expect(insertOrigin([quoteId, invalidVersion, jobId])).rejects.toThrow();
    }
    await expect(insertOrigin([quoteId, quoteVersion, "not-a-uuid"])).rejects.toThrow();
    expect(await insertOrigin([null, null, null])).toBeString();
  });

  test("freezes originating consent and its tenant/source/target binding but permits cutover", async () => {
    const id = await insertOrigin([quoteId, quoteVersion, jobId]);
    for (const [column, replacement] of [
      ["originating_activation_quote_id", "b".repeat(64)],
      ["originating_activation_quote_version", "personal-dedicated-v2"],
      ["originating_provision_job_id", crypto.randomUUID()],
      ["organization_id", crypto.randomUUID()],
      ["user_id", crypto.randomUUID()],
      ["source_agent_id", "another-source"],
      ["dedicated_agent_id", crypto.randomUUID()],
    ]) {
      await expect(
        pg.query(
          `UPDATE personal_dedicated_upgrade_authorities
        SET ${column} = $2 WHERE id = $1`,
          [id, replacement],
        ),
      ).rejects.toThrow("Dedicated activation origin is immutable");
    }
    await expect(
      pg.query(
        `UPDATE personal_dedicated_upgrade_authorities SET
      originating_activation_quote_id = NULL, originating_activation_quote_version = NULL,
      originating_provision_job_id = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow("Dedicated activation origin is immutable");
    await pg.query(
      `UPDATE personal_dedicated_upgrade_authorities
      SET cutover_token = 'local-test-cutover', originating_activation_quote_id = $2 WHERE id = $1`,
      [id, quoteId],
    );
    expect(
      (
        await pg.query(
          "SELECT cutover_token FROM personal_dedicated_upgrade_authorities WHERE id = $1",
          [id],
        )
      ).rows[0],
    ).toEqual({ cutover_token: "local-test-cutover" });
  });

  test("retains the job identity when the job itself is purged", async () => {
    await pg.query("INSERT INTO jobs (id) VALUES ($1)", [jobId]);
    const id = await insertOrigin([quoteId, quoteVersion, jobId]);
    await pg.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    expect(
      (
        await pg.query(
          "SELECT originating_provision_job_id FROM personal_dedicated_upgrade_authorities WHERE id = $1",
          [id],
        )
      ).rows[0],
    ).toEqual({ originating_provision_job_id: jobId });
  });
});
