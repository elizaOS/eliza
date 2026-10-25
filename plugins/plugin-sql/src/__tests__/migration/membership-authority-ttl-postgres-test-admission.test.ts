/**
 * Deterministic admission coverage proves ordinary PostgreSQL configuration
 * cannot reach the destructive membership-TTL test setup.
 */
import { describe, expect, it, vi } from "vitest";
import {
  admitMembershipTtlPostgresScratch,
  MEMBERSHIP_TTL_DESTRUCTIVE_TEST_ENV,
  MEMBERSHIP_TTL_SCRATCH_DATABASE_ENV,
  type PostgresMetadataQuery,
} from "./membership-authority-ttl-postgres-test-admission";

const scratchDatabase = "eliza_membership_ttl_test_0123456789abcdef";

function queryReturning(rows: Record<string, unknown>[]): PostgresMetadataQuery {
  return vi.fn(async () => ({ rows })) as PostgresMetadataQuery;
}

describe("membership TTL destructive PostgreSQL test admission", () => {
  it("rejects an ordinary POSTGRES_URL before executing any database query or DDL", async () => {
    const query = queryReturning([]);

    await expect(
      admitMembershipTtlPostgresScratch({ POSTGRES_URL: "postgres://shared.example/eliza" }, query)
    ).rejects.toThrow(`${MEMBERSHIP_TTL_DESTRUCTIVE_TEST_ENV}=1 is required`);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a missing or unsafe scratch database before querying PostgreSQL", async () => {
    for (const databaseName of [undefined, "postgres", "eliza_membership_ttl_test_short"]) {
      const query = queryReturning([]);
      await expect(
        admitMembershipTtlPostgresScratch(
          {
            [MEMBERSHIP_TTL_DESTRUCTIVE_TEST_ENV]: "1",
            [MEMBERSHIP_TTL_SCRATCH_DATABASE_ENV]: databaseName,
          },
          query
        )
      ).rejects.toThrow(`${MEMBERSHIP_TTL_SCRATCH_DATABASE_ENV} must match`);
      expect(query).not.toHaveBeenCalled();
    }
  });

  it("requires the exact owner-operated database with no authority relations", async () => {
    const base = {
      current_database_name: scratchDatabase,
      current_schema_name: "public",
      current_user_name: "scratch_owner",
      database_owner: "scratch_owner",
      protected_relations: 0,
    };
    const environment = {
      [MEMBERSHIP_TTL_DESTRUCTIVE_TEST_ENV]: "1",
      [MEMBERSHIP_TTL_SCRATCH_DATABASE_ENV]: scratchDatabase,
    };

    await expect(
      admitMembershipTtlPostgresScratch(
        environment,
        queryReturning([{ ...base, current_database_name: "shared_database" }])
      )
    ).rejects.toThrow("does not match the admitted scratch database");
    await expect(
      admitMembershipTtlPostgresScratch(
        environment,
        queryReturning([{ ...base, current_schema_name: "shared" }])
      )
    ).rejects.toThrow("must resolve DDL to public");
    await expect(
      admitMembershipTtlPostgresScratch(
        environment,
        queryReturning([{ ...base, database_owner: "other_owner" }])
      )
    ).rejects.toThrow("current user to own the scratch database");
    await expect(
      admitMembershipTtlPostgresScratch(
        environment,
        queryReturning([{ ...base, protected_relations: 1 }])
      )
    ).rejects.toThrow("already contains membership authority relations");
  });

  it("admits only the verified empty scratch database", async () => {
    const admission = await admitMembershipTtlPostgresScratch(
      {
        [MEMBERSHIP_TTL_DESTRUCTIVE_TEST_ENV]: "1",
        [MEMBERSHIP_TTL_SCRATCH_DATABASE_ENV]: scratchDatabase,
      },
      queryReturning([
        {
          current_database_name: scratchDatabase,
          current_schema_name: "public",
          current_user_name: "scratch_owner",
          database_owner: "scratch_owner",
          protected_relations: "0",
        },
      ])
    );

    expect(admission).toEqual({ databaseName: scratchDatabase });
  });
});
