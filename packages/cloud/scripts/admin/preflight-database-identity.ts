/**
 * Produces redacted PostgreSQL identity receipts for preparation and for the
 * migration runner's same-session enforcement boundary. The standalone entry
 * is read-only; authoritative release enforcement happens inside the migrator.
 */

import { appendFile } from "node:fs/promises";
import {
  type DatabaseIdentityReceipt,
  type IdentityQueryClient,
  readDatabaseIdentityReceipt,
} from "./database-identity-receipt";

export type {
  DatabaseIdentityReceipt,
  IdentityQueryClient,
} from "./database-identity-receipt";
export { readDatabaseIdentityReceipt } from "./database-identity-receipt";

interface ClientConfig {
  application_name?: string;
  connectionString: string;
  connectionTimeoutMillis?: number;
  query_timeout?: number;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  statement_timeout?: number;
}

export interface RuntimePgClient extends IdentityQueryClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  off(event: "error", listener: (error: Error) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface DatabaseIdentityReporterDependencies {
  createClient?: (databaseUrl: string) => Promise<RuntimePgClient>;
  markProcessFailure?: () => void;
  probeDependencies?: typeof probeDatabaseIdentityDependencies;
  publishResult?: typeof publishDatabaseIdentityResult;
  writeStdout?: (message: string) => void;
}
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type DatabaseIdentityGateMode = "off" | "report" | "enforce";

export interface DatabaseIdentityConfig {
  environment: "staging" | "production";
  expectedAuthoritySha256?: string;
  expectedClusterSha256?: string;
  ignoredExpectedDigests?: Array<"cluster" | "authority">;
  mode: DatabaseIdentityGateMode;
}

export interface IdentityPreflightResult {
  mismatches: Array<"cluster" | "authority">;
  failureCategory?: DatabaseIdentityFailureCategory;
  receipt?: DatabaseIdentityReceipt;
  status: "disabled" | "match" | "mismatch" | "reported" | "unavailable";
}

export type DatabaseIdentityFailureCategory =
  | "dependency_unavailable"
  | "database_connection_failed"
  | "database_query_failed"
  | "operator_setup_failed";

export type DatabaseIdentityDependencyLabel = "pg" | "core_edge" | "db_client";

export class DatabaseIdentityDependencyError extends Error {
  constructor(readonly dependency: DatabaseIdentityDependencyLabel) {
    super(`database_identity_dependency_${dependency}_unavailable`);
    this.name = "DatabaseIdentityDependencyError";
  }
}

class DatabaseIdentityClientEventError extends Error {
  constructor() {
    super("database_identity_client_error");
    this.name = "DatabaseIdentityClientEventError";
  }
}

const DEPENDENCY_PROBES = [
  ["pg", "pg"],
  ["core_edge", "@elizaos/core/edge"],
  ["db_client", "@elizaos/cloud-shared/db/client"],
] as const satisfies ReadonlyArray<
  readonly [DatabaseIdentityDependencyLabel, string]
>;

/** Probes the fixed runtime chain in order and discards every import exception. */
export async function probeDatabaseIdentityDependencies(
  importer: (specifier: string) => Promise<unknown> = (specifier) =>
    import(specifier),
): Promise<void> {
  for (const [label, specifier] of DEPENDENCY_PROBES) {
    try {
      await importer(specifier);
    } catch {
      // error-policy:J1 only the fixed probe label crosses the CLI boundary;
      // loader messages and paths are deliberately discarded.
      throw new DatabaseIdentityDependencyError(label);
    }
  }
}

const DEPENDENCY_ERROR_CODES = new Set([
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
]);
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "28P01",
  "3D000",
]);

/** Maps failures to a fixed non-sensitive class without retaining provider text. */
export function classifyDatabaseIdentityFailure(
  error: unknown,
): Exclude<DatabaseIdentityFailureCategory, "database_query_failed"> {
  if (error instanceof DatabaseIdentityDependencyError) {
    return "dependency_unavailable";
  }
  if (error instanceof DatabaseIdentityClientEventError) {
    return "database_connection_failed";
  }
  if (typeof error === "object" && error !== null) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string") {
      if (DEPENDENCY_ERROR_CODES.has(code)) return "dependency_unavailable";
      if (CONNECTION_ERROR_CODES.has(code)) return "database_connection_failed";
    }
  }
  return "operator_setup_failed";
}

/** Formats only bounded diagnostics suitable for public workflow logs. */
export function databaseIdentityFailureDiagnostic(error: unknown): string {
  const category = classifyDatabaseIdentityFailure(error);
  const dependency =
    error instanceof DatabaseIdentityDependencyError
      ? `; dependency=${error.dependency}`
      : "";
  return `category=${category}${dependency}`;
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
      return {
        status: "unavailable",
        mismatches: [],
        failureCategory: "database_query_failed",
      };
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

async function createRuntimePgClient(
  databaseUrl: string,
): Promise<RuntimePgClient> {
  const { Client } = await import("pg");
  return new Client(await clientConfig(databaseUrl));
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
      `::warning::database identity report unavailable; category=${result.failureCategory ?? "operator_setup_failed"}\n`,
    );
  }
  if (config.ignoredExpectedDigests?.length) {
    process.stdout.write(
      "::warning::database identity report ignored malformed protected expected digest(s)\n",
    );
  }
}

/** Runs the standalone reporter and returns its process exit status. */
export async function runDatabaseIdentityReporter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: DatabaseIdentityReporterDependencies = {},
): Promise<number> {
  const createClient = dependencies.createClient ?? createRuntimePgClient;
  const probeDependencies =
    dependencies.probeDependencies ?? probeDatabaseIdentityDependencies;
  const publishResult =
    dependencies.publishResult ?? publishDatabaseIdentityResult;
  const writeStdout =
    dependencies.writeStdout ??
    ((message: string) => process.stdout.write(message));
  const markProcessFailure =
    dependencies.markProcessFailure ??
    (() => {
      process.exitCode = 1;
    });
  const config = readDatabaseIdentityConfig(environment);
  if (config.mode === "off") {
    writeStdout(
      "[database-identity] gate disabled; no database query performed\n",
    );
    return 0;
  }
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) {
    if (config.mode === "report") {
      writeStdout(
        "::warning::database identity report unavailable: DATABASE_URL is missing\n",
      );
      return 1;
    }
    throw new Error(
      "DATABASE_URL is required when database identity enforcement is active",
    );
  }
  let client: RuntimePgClient | undefined;
  let clientErrorObserved = false;
  let lateClientErrorReported = false;
  let reporterSettled = false;
  const recordClientError = (): void => {
    clientErrorObserved = true;
    if (reporterSettled && !lateClientErrorReported) {
      lateClientErrorReported = true;
      markProcessFailure();
      writeStdout(
        "::warning::database identity report invalidated; category=database_connection_failed\n",
      );
    }
  };
  let failure: unknown;
  let failed = false;
  let result: IdentityPreflightResult | undefined;
  try {
    await probeDependencies();
    client = await createClient(databaseUrl);
    client.on("error", recordClientError);
    await client.connect();
    result = await runDatabaseIdentityPreflight(config, client);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // error-policy:J1 a sole close failure becomes a fixed boundary
        // category; an earlier gate failure remains authoritative.
        process.stderr.write(
          "[database-identity] warning: database client close failed\n",
        );
        if (!failed && result?.status !== "unavailable") {
          failed = true;
          failure = new DatabaseIdentityClientEventError();
        }
      }

      // error-policy:J1 pg can enqueue an error after end() resolves. Drain the
      // already-queued turn before publication, then deliberately retain this
      // value-discarding listener for the short-lived reporter process so a
      // still-later EventEmitter error cannot surface raw provider details.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  if (clientErrorObserved) {
    failed = true;
    failure = new DatabaseIdentityClientEventError();
  }
  if (!failed && result) {
    try {
      await publishResult(config, result, environment);
    } catch (error) {
      failed = true;
      failure = error;
    }
  }
  // No asynchronous work occurs between this transition and the final error
  // check. Earlier client errors are reflected in the returned status; any
  // later event uses the retained listener to make the process fail closed.
  reporterSettled = true;
  if (clientErrorObserved) {
    failed = true;
    failure = new DatabaseIdentityClientEventError();
  }
  if (failed) {
    // error-policy:J1 the CLI boundary emits only a generic class so provider
    // errors cannot leak connection strings, hosts, roles, or database names.
    if (config.mode === "report") {
      writeStdout(
        `::warning::database identity report unavailable; ${databaseIdentityFailureDiagnostic(failure)}\n`,
      );
      return 1;
    }
    throw failure;
  }
  if (!result) throw new Error("database identity reporter produced no result");
  return result.status === "unavailable" ? 1 : 0;
}

async function main(): Promise<number> {
  if (process.argv.includes("--probe-dependencies")) {
    await probeDatabaseIdentityDependencies();
    process.stdout.write(
      "[database-identity] dependency probes passed: pg,core_edge,db_client\n",
    );
    return 0;
  }
  return runDatabaseIdentityReporter();
}

if (import.meta.main) {
  main().then(
    (exitCode) => {
      if (process.exitCode == null || process.exitCode === 0) {
        process.exitCode = exitCode;
      }
    },
    (error) => {
      process.stderr.write(
        `[database-identity] fatal: ${databaseIdentityFailureDiagnostic(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
