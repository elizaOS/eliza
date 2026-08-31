/**
 * Read-only production database authority, schema, and migration-ledger audit.
 *
 * Raw Railway inventory and connection details stay in memory/private files.
 * The CLI boundary emits only fixed verdicts and allowlisted relation names.
 */
import { appendFile, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { enforceTlsForRemote } from "../../shared/src/db/postgres-tls";
import {
  type AppliedMigration,
  loadCanonicalMigrations,
  type Migration,
  validateAppliedMigrationLedger,
} from "./canonical-migration-ledger";
import { readDatabaseIdentityReceipt } from "./database-identity-receipt";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;

// Provisioning relations added here must also be considered by the worker's
// startup gate in preflight-job-execution-interruptions.ts.
export const REQUIRED_PRODUCTION_RELATIONS = [
  "public.apps",
  "public.organizations",
  "public.users",
  "public.api_keys",
  "public.mobile_app_auth_grants",
  "public.agent_sandboxes",
  "public.jobs",
  "steward.users",
  "steward.accounts",
  "steward.sessions",
  "drizzle.__drizzle_migrations",
] as const;

type RequiredRelation = (typeof REQUIRED_PRODUCTION_RELATIONS)[number];
type PresenceVerdict = "missing" | "present" | "unavailable";
type MatchVerdict = "match" | "mismatch" | "unavailable";
type LedgerVerdict =
  | "current"
  | "diverged"
  | "missing"
  | "pending"
  | "unavailable";

export interface ProductionDatabaseAuditReport {
  schemaVersion: 1;
  verdict: "fail" | "pass";
  checks: {
    railwayTarget: MatchVerdict;
    protectedDatabaseAuthority: MatchVerdict;
  };
  requiredTables: {
    canonical: Record<RequiredRelation, PresenceVerdict>;
    protected: Record<RequiredRelation, PresenceVerdict>;
  };
  migrationLedger: {
    canonical: LedgerVerdict;
    protected: LedgerVerdict;
  };
}

interface ResourceRef {
  id?: unknown;
  name?: unknown;
}

export interface RailwayTargetEvidence {
  status: {
    id?: unknown;
    environments?: { edges?: Array<{ node?: ResourceRef }> };
    services?: { edges?: Array<{ node?: ResourceRef }> };
  };
  services: Array<{
    id?: unknown;
    source?: { image?: unknown } | null;
  }>;
  variables: Record<string, unknown>;
}

export interface RailwayTargetExpectation {
  projectId: string;
  environmentId: string;
  serviceId?: string;
}

export type RailwayTargetResolution =
  | { verdict: "match"; serviceId: string }
  | { verdict: "mismatch" | "unavailable" };

export interface AuditQueryClient {
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface RuntimeAuditClient extends AuditQueryClient {
  connect(): Promise<void>;
  end(): Promise<void>;
}

interface RuntimeClientConfig {
  application_name: string;
  connectionString: string;
  connectionTimeoutMillis: number;
  options: string;
  query_timeout: number;
  ssl?: unknown;
  statement_timeout: number;
}

const { Client } = createRequire(import.meta.url)("pg") as {
  Client: new (config: RuntimeClientConfig) => RuntimeAuditClient;
};

function unavailablePresence(): Record<RequiredRelation, PresenceVerdict> {
  return Object.fromEntries(
    REQUIRED_PRODUCTION_RELATIONS.map((relation) => [relation, "unavailable"]),
  ) as Record<RequiredRelation, PresenceVerdict>;
}

export function unavailableAuditReport(
  railwayTarget: MatchVerdict = "unavailable",
): ProductionDatabaseAuditReport {
  return {
    schemaVersion: 1,
    verdict: "fail",
    checks: {
      railwayTarget,
      protectedDatabaseAuthority: "unavailable",
    },
    requiredTables: {
      canonical: unavailablePresence(),
      protected: unavailablePresence(),
    },
    migrationLedger: {
      canonical: "unavailable",
      protected: "unavailable",
    },
  };
}

function resourceMatches(
  edges: Array<{ node?: ResourceRef }> | undefined,
  id: string,
  name?: string,
): boolean {
  return (
    (edges ?? []).filter(
      ({ node }) =>
        node?.id === id && (name === undefined || node.name === name),
    ).length === 1
  );
}

function isTaggedPostgres18(image: string): boolean {
  return /(?:^|\/)postgres[^:]*:18(?:$|[-.])/.test(image);
}

function isDigestPinnedPostgres(image: string): boolean {
  return /(?:^|\/)postgres[^:@]*@sha256:[0-9a-f]{64}$/i.test(image);
}

/** Resolves exactly one production Postgres 18 service, honoring an optional pin. */
export function resolveCanonicalRailwayTarget(
  evidence: RailwayTargetEvidence,
  expected: RailwayTargetExpectation,
): RailwayTargetResolution {
  if (
    evidence.status.id !== expected.projectId ||
    !resourceMatches(
      evidence.status.environments?.edges,
      expected.environmentId,
      "production",
    )
  ) {
    return { verdict: "mismatch" };
  }

  if (expected.serviceId) {
    if (!UUID.test(expected.serviceId)) return { verdict: "mismatch" };
    const pinned = evidence.services.filter(
      ({ id }) => id === expected.serviceId,
    );
    if (pinned.length !== 1) return { verdict: "mismatch" };
    const image = pinned[0]?.source?.image;
    if (
      typeof image !== "string" ||
      (!isTaggedPostgres18(image) && !isDigestPinnedPostgres(image))
    ) {
      return { verdict: "mismatch" };
    }
    if (!resourceMatches(evidence.status.services?.edges, expected.serviceId)) {
      return { verdict: "mismatch" };
    }
    return { verdict: "match", serviceId: expected.serviceId };
  }

  const candidates = evidence.services.filter(
    ({ id, source }) =>
      typeof id === "string" &&
      UUID.test(id) &&
      typeof source?.image === "string" &&
      isTaggedPostgres18(source.image),
  );
  if (candidates.length !== 1) return { verdict: "unavailable" };
  const serviceId = candidates[0]?.id;
  if (typeof serviceId !== "string") return { verdict: "unavailable" };
  if (!resourceMatches(evidence.status.services?.edges, serviceId)) {
    return { verdict: "mismatch" };
  }
  return { verdict: "match", serviceId };
}

export function canonicalRailwayDatabaseUrl(
  variables: Record<string, unknown>,
): string {
  const value = variables.DATABASE_PUBLIC_URL;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("canonical_database_url_unavailable");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // error-policy:J3 Railway variables are untrusted evidence.
    throw new Error("canonical_database_url_invalid");
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.pathname.slice(1)
  ) {
    throw new Error("canonical_database_url_invalid");
  }
  return value;
}

async function relationPresence(
  client: AuditQueryClient,
): Promise<Record<RequiredRelation, PresenceVerdict>> {
  const result = await client.query<Record<RequiredRelation, boolean>>(`
    SELECT
      to_regclass('public.apps') IS NOT NULL AS "public.apps",
      to_regclass('public.organizations') IS NOT NULL AS "public.organizations",
      to_regclass('public.users') IS NOT NULL AS "public.users",
      to_regclass('public.api_keys') IS NOT NULL AS "public.api_keys",
      to_regclass('public.mobile_app_auth_grants') IS NOT NULL AS "public.mobile_app_auth_grants",
      to_regclass('public.agent_sandboxes') IS NOT NULL AS "public.agent_sandboxes",
      to_regclass('public.jobs') IS NOT NULL AS "public.jobs",
      to_regclass('steward.users') IS NOT NULL AS "steward.users",
      to_regclass('steward.accounts') IS NOT NULL AS "steward.accounts",
      to_regclass('steward.sessions') IS NOT NULL AS "steward.sessions",
      to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS "drizzle.__drizzle_migrations"
  `);
  const row = result.rows[0];
  return Object.fromEntries(
    REQUIRED_PRODUCTION_RELATIONS.map((relation) => [
      relation,
      row?.[relation] === true ? "present" : "missing",
    ]),
  ) as Record<RequiredRelation, PresenceVerdict>;
}

async function migrationLedgerStatus(
  client: AuditQueryClient,
  canonicalMigrations: Migration[],
  ledgerPresent: boolean,
): Promise<LedgerVerdict> {
  if (!ledgerPresent) return "missing";
  const result = await client.query<AppliedMigration>(`
    SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
     ORDER BY id ASC
  `);
  try {
    const validated = validateAppliedMigrationLedger(
      result.rows,
      canonicalMigrations,
    );
    if (validated.lastAppliedJournalIndex === canonicalMigrations.length - 1) {
      return "current";
    }
    return "pending";
  } catch {
    // error-policy:J1 translate ledger validation failures to a fixed verdict.
    return "diverged";
  }
}

async function beginReadOnly(client: AuditQueryClient): Promise<void> {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
}

async function finishReadOnly(client: AuditQueryClient): Promise<void> {
  await client.query("COMMIT");
}

async function abortReadOnly(client: AuditQueryClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // error-policy:J6 rollback is best-effort after the audit already failed.
  }
}

/** Performs only SELECTs inside database-enforced read-only transactions. */
export async function auditProductionDatabaseAuthority(input: {
  canonicalClient: AuditQueryClient;
  canonicalMigrations: Migration[];
  protectedClient: AuditQueryClient;
}): Promise<ProductionDatabaseAuditReport> {
  try {
    await beginReadOnly(input.canonicalClient);
    await beginReadOnly(input.protectedClient);
    const [canonicalIdentity, protectedIdentity] = await Promise.all([
      readDatabaseIdentityReceipt(input.canonicalClient, "production"),
      readDatabaseIdentityReceipt(input.protectedClient, "production"),
    ]);
    const authorityMatches =
      canonicalIdentity.clusterSha256 === protectedIdentity.clusterSha256 &&
      canonicalIdentity.authoritySha256 === protectedIdentity.authoritySha256 &&
      canonicalIdentity.postgresMajor === 18 &&
      protectedIdentity.postgresMajor === 18;
    const [canonicalRequiredTables, protectedRequiredTables] =
      await Promise.all([
        relationPresence(input.canonicalClient),
        relationPresence(input.protectedClient),
      ]);
    const [canonicalMigrationLedger, protectedMigrationLedger] =
      await Promise.all([
        migrationLedgerStatus(
          input.canonicalClient,
          input.canonicalMigrations,
          canonicalRequiredTables["drizzle.__drizzle_migrations"] === "present",
        ),
        migrationLedgerStatus(
          input.protectedClient,
          input.canonicalMigrations,
          protectedRequiredTables["drizzle.__drizzle_migrations"] === "present",
        ),
      ]);
    await finishReadOnly(input.protectedClient);
    await finishReadOnly(input.canonicalClient);

    const canonicalTablesPresent = Object.values(canonicalRequiredTables).every(
      (value) => value === "present",
    );
    const protectedTablesPresent = Object.values(protectedRequiredTables).every(
      (value) => value === "present",
    );
    const verdict =
      authorityMatches &&
      canonicalTablesPresent &&
      protectedTablesPresent &&
      canonicalMigrationLedger === "current" &&
      protectedMigrationLedger === "current"
        ? "pass"
        : "fail";
    return {
      schemaVersion: 1,
      verdict,
      checks: {
        railwayTarget: "match",
        protectedDatabaseAuthority: authorityMatches ? "match" : "mismatch",
      },
      requiredTables: {
        canonical: canonicalRequiredTables,
        protected: protectedRequiredTables,
      },
      migrationLedger: {
        canonical: canonicalMigrationLedger,
        protected: protectedMigrationLedger,
      },
    };
  } catch (error) {
    // error-policy:J6 roll back both read-only sessions before preserving the failure.
    await Promise.all([
      abortReadOnly(input.protectedClient),
      abortReadOnly(input.canonicalClient),
    ]);
    throw error;
  }
}

async function readPrivateJson(path: string): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_EVIDENCE_BYTES) {
    throw new Error("private_evidence_invalid");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("private_evidence_permissions");
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readPrivateServiceId(path: string): Promise<string> {
  const metadata = await stat(path);
  if (
    !metadata.isFile() ||
    metadata.size > 128 ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("private_service_identity_invalid");
  }
  return requireUuid((await readFile(path, "utf8")).trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireUuid(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw new Error("protected_target_invalid");
  return value;
}

async function runtimeClient(databaseUrl: string): Promise<RuntimeAuditClient> {
  const { url, ssl } = enforceTlsForRemote(databaseUrl);
  const client = new Client({
    connectionString: url,
    application_name: "eliza-production-database-authority-audit",
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
    query_timeout: 8_000,
    options: "-c default_transaction_read_only=on",
    ...(ssl ? { ssl } : {}),
  }) as RuntimeAuditClient;
  await client.connect();
  return client;
}

async function publishReport(
  report: ProductionDatabaseAuditReport,
): Promise<void> {
  const output = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, output, "utf8");
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      "status-json": { type: "string" },
      "services-json": { type: "string" },
      "variables-json": { type: "string" },
      "resolved-service-id-file": { type: "string" },
    },
  });
  const path = (name: keyof typeof parsed.values): string => {
    const value = parsed.values[name];
    if (typeof value !== "string" || !value)
      throw new Error("input_path_invalid");
    return value;
  };
  const protectedDatabaseUrl = process.env.DATABASE_URL;
  if (!protectedDatabaseUrl) throw new Error("protected_database_url_missing");
  const expectation: RailwayTargetExpectation = {
    projectId: requireUuid(process.env.RAILWAY_PROJECT_ID),
    environmentId: requireUuid(process.env.RAILWAY_ENVIRONMENT_ID),
    serviceId: process.env.RAILWAY_POSTGRES_SERVICE_ID?.trim()
      ? requireUuid(process.env.RAILWAY_POSTGRES_SERVICE_ID.trim())
      : undefined,
  };
  const [statusDocument, servicesDocument, variablesDocument] =
    await Promise.all([
      readPrivateJson(path("status-json")),
      readPrivateJson(path("services-json")),
      readPrivateJson(path("variables-json")),
    ]);
  if (
    !isRecord(statusDocument) ||
    !Array.isArray(servicesDocument) ||
    !isRecord(variablesDocument)
  ) {
    throw new Error("railway_evidence_invalid");
  }
  const evidence: RailwayTargetEvidence = {
    status: statusDocument,
    services: servicesDocument,
    variables: variablesDocument,
  };
  const resolution = resolveCanonicalRailwayTarget(evidence, expectation);
  if (resolution.verdict !== "match") {
    await publishReport(unavailableAuditReport(resolution.verdict));
    process.exitCode = 1;
    return;
  }
  const privatelyResolvedServiceId = await readPrivateServiceId(
    path("resolved-service-id-file"),
  );
  if (privatelyResolvedServiceId !== resolution.serviceId) {
    await publishReport(unavailableAuditReport("mismatch"));
    process.exitCode = 1;
    return;
  }

  let protectedClient: RuntimeAuditClient | undefined;
  let canonicalClient: RuntimeAuditClient | undefined;
  try {
    [protectedClient, canonicalClient] = await Promise.all([
      runtimeClient(protectedDatabaseUrl),
      runtimeClient(canonicalRailwayDatabaseUrl(variablesDocument)),
    ]);
    const report = await auditProductionDatabaseAuthority({
      protectedClient,
      canonicalClient,
      canonicalMigrations: await loadCanonicalMigrations(),
    });
    await publishReport(report);
    if (report.verdict !== "pass") process.exitCode = 1;
  } finally {
    // error-policy:J6 connection teardown must not replace the audit verdict.
    await Promise.allSettled([protectedClient?.end(), canonicalClient?.end()]);
  }
}

if (import.meta.main) {
  // error-policy:J1 the CLI emits only a fixed unavailable report on failure.
  main().catch(async () => {
    try {
      await publishReport(unavailableAuditReport());
    } catch {
      // error-policy:J1 a failed report write still terminates nonzero.
    }
    process.exitCode = 1;
  });
}
