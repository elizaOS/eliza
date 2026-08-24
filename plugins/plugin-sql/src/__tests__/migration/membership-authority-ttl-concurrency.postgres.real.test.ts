/**
 * Real-PostgreSQL proof for the membership TTL post-schema guard. Independent
 * pools exercise concurrent process startup, durable restart no-op behavior,
 * and transactional rollback when the one-time repair fails.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMembershipAuthorityTtlConstraints } from "../../membership-authority-ttl-constraints";

interface SnapshotRow extends Record<string, unknown> {
  authority_constraint_id: number;
  authority_expiry_ms: number | string;
  authority_xmin: string;
  scope_constraint_id: number;
  scope_expiry_ms: number | string;
  scope_xmin: string;
  tagged_constraints: number | string;
}

const postgresUrl = process.env.POSTGRES_URL;

describe.skipIf(!postgresUrl)("membership authority TTL PostgreSQL concurrency", () => {
  const firstPool = new Pool({ connectionString: postgresUrl, max: 4 });
  const secondPool = new Pool({ connectionString: postgresUrl, max: 4 });
  const firstDb = drizzle(firstPool);
  const secondDb = drizzle(secondPool);

  async function installLegacySchema(): Promise<void> {
    await firstDb.execute(sql`
      DROP TABLE IF EXISTS membership_authority CASCADE;
      DROP TABLE IF EXISTS membership_authority_scopes CASCADE;
      CREATE TABLE membership_authority_scopes (
        id integer PRIMARY KEY,
        health text NOT NULL,
        valid_until timestamptz,
        observed_at timestamptz NOT NULL,
        publisher_instance_id text,
        source_version integer NOT NULL,
        source_cursor text,
        CONSTRAINT membership_authority_scope_current_check CHECK (
          health <> 'current'
          OR (
            valid_until IS NOT NULL
            AND valid_until > observed_at
            AND publisher_instance_id IS NOT NULL
            AND source_version >= 0
            AND source_cursor IS NOT NULL
          )
        )
      );
      CREATE TABLE membership_authority (
        id integer PRIMARY KEY,
        generation integer NOT NULL,
        source_version integer NOT NULL,
        valid_until timestamptz NOT NULL,
        observed_at timestamptz NOT NULL,
        CONSTRAINT membership_authority_version_check CHECK (
          generation > 0 AND source_version >= 0 AND valid_until > observed_at
        )
      );
      INSERT INTO membership_authority_scopes
        (id, health, valid_until, observed_at, publisher_instance_id, source_version, source_cursor)
      VALUES
        (1, 'current', TIMESTAMPTZ '2026-08-25 00:00:00+00',
         TIMESTAMPTZ '2026-08-23 00:00:00+00', 'publisher', 0, 'cursor');
      INSERT INTO membership_authority
        (id, generation, source_version, valid_until, observed_at)
      VALUES
        (1, 1, 0, TIMESTAMPTZ '2026-08-25 00:00:00+00',
         TIMESTAMPTZ '2026-08-23 00:00:00+00');
    `);
  }

  async function snapshot(): Promise<SnapshotRow> {
    const result = await firstDb.execute<SnapshotRow>(sql`
      SELECT scope_constraint.oid::integer AS scope_constraint_id,
             authority_constraint.oid::integer AS authority_constraint_id,
             EXTRACT(EPOCH FROM scope.valid_until) * 1000 AS scope_expiry_ms,
             EXTRACT(EPOCH FROM authority.valid_until) * 1000 AS authority_expiry_ms,
             scope.xmin::text AS scope_xmin,
             authority.xmin::text AS authority_xmin,
             (
               SELECT COUNT(*)
                 FROM pg_constraint AS tagged
                 JOIN pg_class AS relation ON relation.oid = tagged.conrelid
                WHERE relation.relname IN (
                        'membership_authority_scopes',
                        'membership_authority'
                      )
                  AND tagged.conname IN (
                        'membership_authority_scope_current_check',
                        'membership_authority_version_check'
                      )
                  AND obj_description(tagged.oid, 'pg_constraint') =
                        'elizaos:membership-authority-ttl:v1'
             ) AS tagged_constraints
        FROM membership_authority_scopes AS scope
        CROSS JOIN membership_authority AS authority
        CROSS JOIN pg_constraint AS scope_constraint
        CROSS JOIN pg_constraint AS authority_constraint
       WHERE scope.id = 1
         AND authority.id = 1
         AND scope_constraint.conname = 'membership_authority_scope_current_check'
         AND authority_constraint.conname = 'membership_authority_version_check'
    `);
    const row = result.rows[0];
    if (!row) throw new Error("membership TTL snapshot was unavailable");
    return row;
  }

  beforeAll(async () => {
    await Promise.all([
      firstDb.execute(sql`SET statement_timeout = '15s'; SET lock_timeout = '10s'`),
      secondDb.execute(sql`SET statement_timeout = '15s'; SET lock_timeout = '10s'`),
    ]);
  });

  afterAll(async () => {
    await firstDb.execute(sql`
      DROP TABLE IF EXISTS membership_authority CASCADE;
      DROP TABLE IF EXISTS membership_authority_scopes CASCADE;
      DROP FUNCTION IF EXISTS slow_membership_ttl_upgrade();
      DROP FUNCTION IF EXISTS reject_membership_ttl_upgrade()
    `);
    await Promise.all([firstPool.end(), secondPool.end()]);
  });

  it("serializes concurrent startups and makes every later startup a durable no-op", async () => {
    await installLegacySchema();
    await firstDb.execute(sql`
      CREATE OR REPLACE FUNCTION slow_membership_ttl_upgrade() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.15);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER slow_membership_ttl_upgrade
        BEFORE UPDATE ON membership_authority_scopes
        FOR EACH ROW EXECUTE FUNCTION slow_membership_ttl_upgrade()
    `);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        applyMembershipAuthorityTtlConstraints(index % 2 === 0 ? firstDb : secondDb, "postgres")
      )
    );
    expect(results).toEqual(Array.from({ length: 8 }, () => true));

    const settled = await snapshot();
    expect(Number(settled.tagged_constraints)).toBe(2);
    expect(Number(settled.scope_expiry_ms)).toBe(new Date("2026-08-24T00:00:00.000Z").getTime());
    expect(Number(settled.authority_expiry_ms)).toBe(
      new Date("2026-08-24T00:00:00.000Z").getTime()
    );

    await applyMembershipAuthorityTtlConstraints(secondDb, "postgres");
    expect(await snapshot()).toEqual(settled);
  }, 30_000);

  it("rolls back row clamps and DDL when the one-time repair fails", async () => {
    await installLegacySchema();
    await firstDb.execute(sql`
      CREATE OR REPLACE FUNCTION reject_membership_ttl_upgrade() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced membership TTL upgrade failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_membership_ttl_upgrade
        BEFORE UPDATE ON membership_authority
        FOR EACH ROW EXECUTE FUNCTION reject_membership_ttl_upgrade()
    `);

    let failure: unknown;
    try {
      await applyMembershipAuthorityTtlConstraints(firstDb, "postgres");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { cause?: Error }).cause?.message).toContain(
      "forced membership TTL upgrade failure"
    );

    const rolledBack = await snapshot();
    expect(Number(rolledBack.tagged_constraints)).toBe(0);
    expect(Number(rolledBack.scope_expiry_ms)).toBe(new Date("2026-08-25T00:00:00.000Z").getTime());
    expect(Number(rolledBack.authority_expiry_ms)).toBe(
      new Date("2026-08-25T00:00:00.000Z").getTime()
    );

    await firstDb.execute(sql`DROP TRIGGER reject_membership_ttl_upgrade ON membership_authority`);
    expect(await applyMembershipAuthorityTtlConstraints(secondDb, "postgres")).toBe(true);

    const recovered = await snapshot();
    expect(Number(recovered.tagged_constraints)).toBe(2);
    expect(Number(recovered.scope_expiry_ms)).toBe(new Date("2026-08-24T00:00:00.000Z").getTime());
    expect(Number(recovered.authority_expiry_ms)).toBe(
      new Date("2026-08-24T00:00:00.000Z").getTime()
    );
    await expect(
      firstDb.execute(sql`
        UPDATE membership_authority
           SET valid_until = observed_at + INTERVAL '48 hours'
         WHERE id = 1
      `)
    ).rejects.toThrow();

    await applyMembershipAuthorityTtlConstraints(firstDb, "postgres");
    expect(await snapshot()).toEqual(recovered);
  }, 30_000);
});
