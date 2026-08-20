/**
 * Produces redacted PostgreSQL identity receipts for preparation and for the
 * migration runner's same-session enforcement boundary. The standalone entry
 * is read-only; authoritative release enforcement happens inside the migrator.
 */

import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import pg, { type ClientConfig } from "pg";

const { Client } = pg;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDENTITY_QUERY = `
SELECT
  control.system_identifier::text AS system_identifier,
  pg_catalog.current_database()::text AS database_name,
  current_user::text AS role_name,
  pg_catalog.current_setting('server_version_num')::text AS server_version_num
FROM pg_catalog.pg_control_system() AS control
`;

export type DatabaseIdentityGateMode = "off" | "report" | "enforce";

export interface DatabaseIdentityConfig {
  environment: "staging" | "production";
  expectedAuthoritySha256?: string;
  expectedClusterSha256?: string;
  ignoredExpectedDigests?: Array<"cluster" | "authority">;
  mode: DatabaseIdentityGateMode;
}

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

export interface IdentityPreflightResult {
  mismatches: Array<"cluster" | "authority">;
  receipt?: DatabaseIdentityReceipt;
  status: "disabled" | "match" | "mismatch" | "reported" | "unavailable";
}

function readMode(value: string | undefined): DatabaseIdentityGateMode {
  const normalized = (value ?? "off").trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "report" ||
    normalized === "enforce"
  ) {
    return normalized;
  }
  throw new Error(
    "DATABASE_IDENTITY_GATE_MODE must be off, report, or enforce",
  );
}

function readOptionalDigest(
  value: string | undefined,
  name: string,
  strict: boolean,
): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!SHA256_PATTERN.test(normalized)) {
    if (!strict) return undefined;
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

/** Reads the nonsecret identity authority and its explicit activation mode. */
export function readDatabaseIdentityConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseIdentityConfig {
  const mode = readMode(environment.DATABASE_IDENTITY_GATE_MODE);
  const target =
    environment.DATABASE_IDENTITY_ENVIRONMENT?.trim().toLowerCase();
  if (target !== "staging" && target !== "production") {
    throw new Error(
      "DATABASE_IDENTITY_ENVIRONMENT must be staging or production",
    );
  }
  const config: DatabaseIdentityConfig = {
    environment: target,
    expectedAuthoritySha256: undefined,
    expectedClusterSha256: undefined,
    mode,
  };
  // Off mode must remain inert even while operators prepare or rotate the
  // protected expected receipts.
  if (mode === "off") return config;

  const strict = mode === "enforce";
  config.expectedClusterSha256 = readOptionalDigest(
    environment.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256,
    "DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256",
    strict,
  );
  config.expectedAuthoritySha256 = readOptionalDigest(
    environment.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256,
    "DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256",
    strict,
  );
  if (mode === "report") {
    const ignoredExpectedDigests: Array<"cluster" | "authority"> = [];
    if (
      environment.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256?.trim() &&
      !config.expectedClusterSha256
    ) {
      ignoredExpectedDigests.push("cluster");
    }
    if (
      environment.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256?.trim() &&
      !config.expectedAuthoritySha256
    ) {
      ignoredExpectedDigests.push("authority");
    }
    if (ignoredExpectedDigests.length > 0) {
      config.ignoredExpectedDigests = ignoredExpectedDigests;
    }
  }
  if (
    mode === "enforce" &&
    (!config.expectedClusterSha256 || !config.expectedAuthoritySha256)
  ) {
    throw new Error(
      "enforce mode requires both expected database identity SHA-256 digests",
    );
  }
  return config;
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

/** Queries only stable, nonsecret PostgreSQL identity fields and hashes raw names. */
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

/** Evaluates the receipt without exposing the underlying server, role, or database names. */
export async function runDatabaseIdentityPreflight(
  config: DatabaseIdentityConfig,
  client?: IdentityQueryClient,
): Promise<IdentityPreflightResult> {
  if (config.mode === "off") return { status: "disabled", mismatches: [] };
  if (!client)
    throw new Error(
      "database identity client is required when the gate is active",
    );
  let receipt: DatabaseIdentityReceipt;
  try {
    receipt = await readDatabaseIdentityReceipt(client, config.environment);
  } catch (error) {
    if (config.mode === "report") {
      return { status: "unavailable", mismatches: [] };
    }
    throw error;
  }
  const mismatches: Array<"cluster" | "authority"> = [];
  if (
    config.expectedClusterSha256 &&
    receipt.clusterSha256 !== config.expectedClusterSha256
  ) {
    mismatches.push("cluster");
  }
  if (
    config.expectedAuthoritySha256 &&
    receipt.authoritySha256 !== config.expectedAuthoritySha256
  ) {
    mismatches.push("authority");
  }
  if (config.mode === "enforce" && mismatches.length > 0) {
    throw new Error(`database identity mismatch: ${mismatches.join(",")}`);
  }
  const hasCompleteExpectedIdentity = Boolean(
    config.expectedClusterSha256 && config.expectedAuthoritySha256,
  );
  return {
    status:
      mismatches.length > 0
        ? "mismatch"
        : hasCompleteExpectedIdentity
          ? "match"
          : "reported",
    mismatches,
    receipt,
  };
}

async function clientConfig(databaseUrl: string): Promise<ClientConfig> {
  // Keep the heavy Cloud database module outside the pure receipt/test path.
  const { enforceTlsForRemote } = await import(
    "@elizaos/cloud-shared/db/client"
  );
  const { url, ssl } = enforceTlsForRemote(databaseUrl);
  return {
    connectionString: url,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 5_000,
    application_name: "eliza-database-identity-preflight",
    ...(ssl ? { ssl } : {}),
  };
}

/** Formats a redacted receipt for operator logs and GitHub step summaries. */
function formatDatabaseIdentitySummary(
  result: IdentityPreflightResult,
): string {
  const lines = [
    "### PostgreSQL identity preflight",
    "",
    `- Status: \`${result.status}\``,
  ];
  if (result.receipt) {
    lines.push(
      `- Environment: \`${result.receipt.environment}\``,
      `- PostgreSQL major: \`${result.receipt.postgresMajor}\``,
      `- Cluster receipt: \`${result.receipt.clusterSha256}\``,
      `- Authority receipt: \`${result.receipt.authoritySha256}\``,
    );
  }
  if (result.mismatches.length > 0) {
    lines.push(`- Mismatch classes: \`${result.mismatches.join(",")}\``);
  }
  return `${lines.join("\n")}\n`;
}

/** Publishes only redacted identity results and generic diagnostic classes. */
export async function publishDatabaseIdentityResult(
  config: DatabaseIdentityConfig,
  result: IdentityPreflightResult,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const output = formatDatabaseIdentitySummary(result);
  process.stdout.write(output);
  if (environment.GITHUB_STEP_SUMMARY) {
    await appendFile(environment.GITHUB_STEP_SUMMARY, output, "utf8");
  }
  if (result.status === "mismatch" && config.mode === "report") {
    process.stdout.write(
      "::warning::database identity report differs from the protected authority\n",
    );
  }
  if (result.status === "unavailable") {
    process.stdout.write(
      "::warning::database identity report unavailable; inspect protected operator logs\n",
    );
  }
  if (config.ignoredExpectedDigests?.length) {
    process.stdout.write(
      "::warning::database identity report ignored malformed protected expected digest(s)\n",
    );
  }
}

async function main(): Promise<void> {
  const environment: Readonly<Record<string, string | undefined>> = process.env;
  const config = readDatabaseIdentityConfig(environment);
  if (config.mode === "off") {
    process.stdout.write(
      "[database-identity] gate disabled; no database query performed\n",
    );
    return;
  }
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    if (config.mode === "report") {
      process.stdout.write(
        "::warning::database identity report unavailable: DATABASE_URL is missing\n",
      );
      return;
    }
    throw new Error(
      "DATABASE_URL is required when database identity enforcement is active",
    );
  }
  let client: InstanceType<typeof Client> | undefined;
  try {
    client = new Client(await clientConfig(databaseUrl));
    await client.connect();
    const result = await runDatabaseIdentityPreflight(config, client);
    await publishDatabaseIdentityResult(config, result, environment);
  } catch (error) {
    // error-policy:J1 the CLI boundary emits only a generic class so provider
    // errors cannot leak connection strings, hosts, roles, or database names.
    if (config.mode === "report") {
      process.stdout.write(
        "::warning::database identity report unavailable; inspect protected operator logs\n",
      );
      return;
    }
    throw error;
  } finally {
    await client?.end().catch(() => {
      // error-policy:J6 teardown failure cannot replace the primary gate result.
      process.stderr.write(
        "[database-identity] warning: database client close failed\n",
      );
    });
  }
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write(
      "[database-identity] fatal: identity enforcement failed\n",
    );
    process.exit(1);
  });
}
