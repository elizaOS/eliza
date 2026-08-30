/** Dependency-light, read-only PostgreSQL identity receipt generation. */
import { createHash } from "node:crypto";

const IDENTITY_QUERY = `
SELECT
  control.system_identifier::text AS system_identifier,
  pg_catalog.current_database()::text AS database_name,
  current_user::text AS role_name,
  pg_catalog.current_setting('server_version_num')::text AS server_version_num
FROM pg_catalog.pg_control_system() AS control
`;

interface DatabaseIdentityRow {
  database_name: string;
  role_name: string;
  server_version_num: string;
  system_identifier: string;
}

export interface DatabaseIdentityReceipt {
  authoritySha256: string;
  clusterSha256: string;
  environment: "staging" | "production";
  postgresMajor: number;
  version: 1;
}

export interface IdentityQueryClient {
  query(text: string): Promise<{ rows: unknown[] }>;
}

function isIdentityRow(value: unknown): value is DatabaseIdentityRow {
  return (
    value !== null &&
    typeof value === "object" &&
    "system_identifier" in value &&
    typeof value.system_identifier === "string" &&
    /^\d+$/.test(value.system_identifier) &&
    "database_name" in value &&
    typeof value.database_name === "string" &&
    value.database_name.length > 0 &&
    "role_name" in value &&
    typeof value.role_name === "string" &&
    value.role_name.length > 0 &&
    "server_version_num" in value &&
    typeof value.server_version_num === "string" &&
    /^\d+$/.test(value.server_version_num)
  );
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

/** Queries only stable PostgreSQL identity fields and hashes every raw name. */
export async function readDatabaseIdentityReceipt(
  client: IdentityQueryClient,
  environment: "staging" | "production",
): Promise<DatabaseIdentityReceipt> {
  const result = await client.query(IDENTITY_QUERY);
  if (result.rows.length !== 1 || !isIdentityRow(result.rows[0])) {
    throw new Error("database identity query returned an invalid row");
  }
  const row = result.rows[0];
  const postgresMajor = Math.floor(Number(row.server_version_num) / 10_000);
  if (!Number.isSafeInteger(postgresMajor) || postgresMajor < 10) {
    throw new Error(
      "database identity query returned an invalid PostgreSQL version",
    );
  }
  return {
    version: 1,
    environment,
    postgresMajor,
    clusterSha256: digest(["eliza-postgres-cluster-v1", row.system_identifier]),
    authoritySha256: digest([
      "eliza-postgres-authority-v1",
      environment,
      row.system_identifier,
      row.role_name,
      row.database_name,
    ]),
  };
}
