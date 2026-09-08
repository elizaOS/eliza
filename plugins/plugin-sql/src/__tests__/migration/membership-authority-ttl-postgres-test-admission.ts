/**
 * Admits the destructive membership-TTL PostgreSQL proof only into an
 * explicitly named, owner-operated scratch database with no authority tables.
 */

export const MEMBERSHIP_TTL_DESTRUCTIVE_TEST_ENV = "ELIZA_MEMBERSHIP_TTL_DESTRUCTIVE_TEST";
export const MEMBERSHIP_TTL_SCRATCH_DATABASE_ENV = "ELIZA_MEMBERSHIP_TTL_SCRATCH_DATABASE";

const SCRATCH_DATABASE_PATTERN = /^eliza_membership_ttl_test_[a-f0-9]{16,32}$/;

interface ScratchDatabaseMetadata extends Record<string, unknown> {
  current_database_name: string;
  current_schema_name: string;
  current_user_name: string;
  database_owner: string;
  protected_relations: number | string;
}

export type PostgresMetadataQuery = <Row extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[]
) => Promise<{ rows: Row[] }>;

export interface MembershipTtlPostgresScratchAdmission {
  databaseName: string;
}

/** Fails before querying PostgreSQL unless destructive execution is explicit. */
export async function admitMembershipTtlPostgresScratch(
  environment: NodeJS.ProcessEnv,
  query: PostgresMetadataQuery
): Promise<MembershipTtlPostgresScratchAdmission> {
  if (environment[MEMBERSHIP_TTL_DESTRUCTIVE_TEST_ENV] !== "1") {
    throw new Error(
      `${MEMBERSHIP_TTL_DESTRUCTIVE_TEST_ENV}=1 is required for the destructive membership TTL PostgreSQL test`
    );
  }

  const databaseName = environment[MEMBERSHIP_TTL_SCRATCH_DATABASE_ENV];
  if (!databaseName || !SCRATCH_DATABASE_PATTERN.test(databaseName)) {
    throw new Error(
      `${MEMBERSHIP_TTL_SCRATCH_DATABASE_ENV} must match ${SCRATCH_DATABASE_PATTERN.source}`
    );
  }

  const result = await query<ScratchDatabaseMetadata>(
    `SELECT current_database() AS current_database_name,
            current_schema() AS current_schema_name,
            current_user AS current_user_name,
            pg_get_userbyid(database.datdba) AS database_owner,
            (
              SELECT COUNT(*)
                FROM pg_class AS relation
                JOIN pg_namespace AS namespace
                  ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname = 'public'
                 AND relation.relname IN (
                   'membership_authority',
                   'membership_authority_scopes'
                 )
            ) AS protected_relations
       FROM pg_database AS database
      WHERE database.datname = current_database()`,
    []
  );
  const metadata = result.rows[0];
  if (!metadata) {
    throw new Error("scratch database metadata was unavailable");
  }
  if (metadata.current_database_name !== databaseName) {
    throw new Error("connected PostgreSQL database does not match the admitted scratch database");
  }
  if (metadata.current_schema_name !== "public") {
    throw new Error("membership TTL PostgreSQL scratch database must resolve DDL to public");
  }
  if (metadata.current_user_name !== metadata.database_owner) {
    throw new Error(
      "membership TTL PostgreSQL test requires the current user to own the scratch database"
    );
  }
  if (Number(metadata.protected_relations) !== 0) {
    throw new Error(
      "membership TTL PostgreSQL scratch database already contains membership authority relations"
    );
  }

  return { databaseName };
}
