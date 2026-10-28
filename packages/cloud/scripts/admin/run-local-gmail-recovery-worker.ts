/** Synthetic-only PG18 worker. Invoked by the owned-container launcher, never production. */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import {
  type AppliedMigration,
  loadCanonicalMigrations,
  validateAppliedMigrationLedger,
} from "./canonical-migration-ledger";
import { readDatabaseIdentityReceipt } from "./database-identity-receipt";
import { admitExactGmailRecovery } from "./exact-gmail-ledger-recovery";
import { readGmailRecoveryCatalog } from "./gmail-recovery-catalog";
import { runMigrations } from "./migrate-with-diagnostics";
import {
  type RehearsalConnection,
  readGmailRowsDigest,
  rehearseExactGmailRecovery,
} from "./rehearse-exact-gmail-recovery";

const adminUrl = new URL(process.env.REHEARSAL_DATABASE_URL ?? "");
if (
  !["127.0.0.1", "[::1]", "localhost"].includes(adminUrl.hostname) ||
  adminUrl.pathname !== "/postgres" ||
  process.env.REHEARSAL_SYNTHETIC_ONLY !== "1"
)
  throw Error("owned_loopback_rehearsal_required");
const output = process.env.REHEARSAL_RECEIPT_PATH;
if (!output) throw Error("receipt_path_required");
const name = `recovery_rehearsal_${randomBytes(8).toString("hex")}`;
const admin = new pg.Client({ connectionString: adminUrl.href });
await admin.connect();
let stage = "create_database";
let connection: pg.Client | undefined;
let failureContext: unknown;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const migrations = await loadCanonicalMigrations();
  const baseline = new pg.Client({ connectionString: url.href });
  await baseline.connect();
  const baselineIdentity = await readDatabaseIdentityReceipt(
    baseline,
    "staging",
  );
  if (baselineIdentity.postgresMajor !== 18) throw Error("postgres18_required");
  stage = "canonical_370_baseline";
  await runMigrations(
    {
      backend: "postgres",
      query: async <T>(sql: string, params?: unknown[]) => {
        const r = await baseline.query(sql, params);
        return { rows: r.rows as T[] };
      },
      end: () => baseline.end(),
    },
    migrations.slice(0, 370),
    { timeoutMs: 1000, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    {
      environment: "staging",
      mode: "enforce",
      expectedAuthoritySha256: baselineIdentity.authoritySha256,
      expectedClusterSha256: baselineIdentity.clusterSha256,
    },
  );
  connection = new pg.Client({ connectionString: url.href });
  await connection.connect();
  stage = "synthetic_cherrypicks";
  for (const [offset, tag] of [
    "0509_managed_gmail_operation_receipts",
    "0535_managed_gmail_read_state_operations",
  ].entries()) {
    const migration = migrations.find((m) => m.entry.tag === tag);
    if (!migration) throw Error("fixture_missing");
    await connection.query("BEGIN");
    for (const statement of migration.statements)
      await connection.query(statement);
    await connection.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)",
      [migration.hash, migrations[370 + offset].entry.when],
    );
    await connection.query("COMMIT");
  }
  const org = randomUUID(),
    user = randomUUID();
  stage = "representative_data";
  await connection.query(
    "INSERT INTO organizations(id,name,slug,credit_balance,pay_as_you_go_from_earnings) VALUES($1,'Synthetic recovery organization',$2,42,true)",
    [org, `recovery-${org}`],
  );
  await connection.query(
    "INSERT INTO users(id,steward_user_id,organization_id) VALUES($1,$2,$3)",
    [user, `synthetic-${user}`, org],
  );
  await connection.query(
    "INSERT INTO redeemable_earnings(user_id,total_earned,total_redeemed,total_pending,available_balance,earned_from_mcps,earned_from_affiliates) VALUES($1,40,20,5,15,30,10)",
    [user],
  );
  await connection.query(
    "INSERT INTO credit_packs(name,credits,price_cents,stripe_price_id,stripe_product_id) VALUES('Synthetic retired pack',10,1000,'synthetic-price','synthetic-product')",
  );
  for (const state of [
    "prepared",
    "dispatched",
    "succeeded",
    "rejected",
    "outcome-unknown",
  ]) {
    await connection.query(
      `INSERT INTO managed_gmail_operation_receipts(organization_id,user_id,grant_id,request_id,kind,review_digest,state,provider_result,rejection_code,created_at,dispatched_at,finished_at)
   VALUES($1,$2,$3,$4,'mark-read',$5,$6,$7,$8,'2026-01-01T01:02:03.123456Z',CASE WHEN $6='prepared' THEN NULL ELSE '2026-01-01T01:02:03.123457Z'::timestamptz END,CASE WHEN $6 IN('prepared','dispatched') THEN NULL ELSE '2026-01-01T01:02:03.123458Z'::timestamptz END)`,
      [
        org,
        user,
        randomUUID(),
        randomUUID(),
        "a".repeat(64),
        state,
        state === "succeeded" ? { synthetic: true } : null,
        state === "rejected" ? "synthetic_rejected" : null,
      ],
    );
  }
  async function snapshot() {
    const client = connection as unknown as RehearsalConnection;
    await client.query("BEGIN");
    try {
      await client.query(
        "LOCK TABLE public.managed_gmail_operation_receipts,drizzle.__drizzle_migrations IN SHARE MODE",
      );
      const gmail = await readGmailRowsDigest(client);
      const ledger = await client.query<{ digest: string; count: string }>(
        `SELECT encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY id),''),'UTF8')),'hex') AS digest,count(*)::text AS count FROM drizzle.__drizzle_migrations t`,
      );
      await client.query("COMMIT");
      return { gmail, ledger: ledger.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  const before = await snapshot();
  const initial = await connection.query<AppliedMigration>(
    "SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id",
  );
  let initiallyRefused = false;
  try {
    validateAppliedMigrationLedger(initial.rows, migrations);
  } catch {
    initiallyRefused = true;
  }
  if (!initiallyRefused) throw Error("expected_original_refusal");
  stage = "source_state_preflight";
  admitExactGmailRecovery(migrations, initial.rows);
  stage = "synthetic_catalog_capture";
  await writeFile(
    `${output}.synthetic-catalog.json`,
    JSON.stringify(
      await readGmailRecoveryCatalog(
        connection as unknown as RehearsalConnection,
        { tableOwnerRole: "postgres", functionOwnerRole: "postgres" },
      ),
      null,
      2,
    ),
  );
  stage = "atomic_recovery";
  const expectedIdentity = await readDatabaseIdentityReceipt(
    connection,
    "staging",
  );
  // Fail a real SQL statement after all recovery migrations and ledger checks ran.
  // This exercises rollback of the complete archive/ledger/schema operation.
  stage = "full_recovery_rollback";
  const actual = connection;
  let injected = false;
  const failingClient: RehearsalConnection = {
    getTransactionStatus: () =>
      (actual as unknown as RehearsalConnection).getTransactionStatus(),
    query: async <T>(sql: string, parameters?: unknown[]) => {
      if (!injected && sql === "SET CONSTRAINTS ALL IMMEDIATE") {
        injected = true;
        await actual.query("SELECT 1/0");
      }
      const response = await actual.query(sql, parameters);
      return { rows: response.rows as T[], command: response.command };
    },
  };
  const rollback = await rehearseExactGmailRecovery({
    client: failingClient,
    databaseName: name,
    expectedIdentity,
    ownership: { tableOwnerRole: "postgres", functionOwnerRole: "postgres" },
    lockTimeoutMs: 1000,
    statementTimeoutMs: 30000,
  });
  if (!injected || rollback.status !== "aborted") {
    failureContext = rollback;
    throw Error("full_rollback_not_reached");
  }
  const rolledBack = await snapshot();
  const rolledBackRelations = await actual.query(
    "SELECT to_regclass('drizzle.__gmail_recovery_v1') IS NULL AND to_regclass('public.creator_monetization_retirement') IS NULL AS clean",
  );
  if (
    JSON.stringify(before) !== JSON.stringify(rolledBack) ||
    rolledBackRelations.rows[0]?.clean !== true
  )
    throw Error("full_rollback_preservation_failed");
  stage = "partial_retirement_refusal";
  await actual.query(
    "CREATE TABLE public.creator_monetization_retirement (synthetic boolean)",
  );
  const partial = await rehearseExactGmailRecovery({
    client: actual as unknown as RehearsalConnection,
    databaseName: name,
    expectedIdentity,
    ownership: { tableOwnerRole: "postgres", functionOwnerRole: "postgres" },
    lockTimeoutMs: 1000,
    statementTimeoutMs: 30000,
  });
  if (
    partial.status !== "aborted" ||
    partial.stage !== "exact_state_and_schema"
  )
    throw Error("partial_retirement_not_refused");
  await actual.query("DROP TABLE public.creator_monetization_retirement");
  stage = "atomic_recovery";
  const result = await rehearseExactGmailRecovery({
    client: connection as unknown as RehearsalConnection,
    databaseName: name,
    expectedIdentity,
    ownership: { tableOwnerRole: "postgres", functionOwnerRole: "postgres" },
    lockTimeoutMs: 1000,
    statementTimeoutMs: 30000,
  });
  if (result.status !== "committed") {
    await writeFile(
      output,
      `${JSON.stringify(
        { purpose: "synthetic_rehearsal_only", stage, result },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  } else {
    stage = "preservation_and_idempotence";
    const after = await snapshot();
    if (
      before.gmail.digest !== after.gmail.digest ||
      before.gmail.count !== after.gmail.count
    )
      throw Error("gmail_rows_changed");
    const financial = await connection.query(
      "SELECT s.unpaid_balance_usd::text AS unpaid,o.credit_balance::text AS credits,o.pay_as_you_go_from_earnings FROM creator_earnings_retirement_statements s JOIN organizations o ON o.id=s.organization_id WHERE s.user_id=$1",
      [user],
    );
    if (
      Number(financial.rows[0]?.unpaid) !== 20 ||
      Number(financial.rows[0]?.credits) !== 42 ||
      financial.rows[0]?.pay_as_you_go_from_earnings !== false
    )
      throw Error("financial_preservation_failed");
    const packs = await connection.query(
      "SELECT is_active FROM credit_packs WHERE stripe_price_id='synthetic-price'",
    );
    if (packs.rows[0]?.is_active !== false)
      throw Error("pack_retirement_failed");
    const second = await rehearseExactGmailRecovery({
      client: connection as unknown as RehearsalConnection,
      databaseName: name,
      expectedIdentity,
      ownership: { tableOwnerRole: "postgres", functionOwnerRole: "postgres" },
      lockTimeoutMs: 1000,
      statementTimeoutMs: 30000,
    });
    if (
      second.status !== "aborted" ||
      second.stage !== "exact_state_and_schema"
    )
      throw Error("repeat_not_refused");
    stage = "normal_runner_acceptance";
    const normal = new pg.Client({ connectionString: url.href });
    await normal.connect();
    await runMigrations(
      {
        backend: "postgres",
        query: async <T>(sql: string, parameters?: unknown[]) => {
          const result = await normal.query(sql, parameters);
          return { rows: result.rows as T[] };
        },
        end: () => normal.end(),
      },
      migrations,
      { timeoutMs: 1000, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      {
        environment: "staging",
        mode: "enforce",
        expectedAuthoritySha256: expectedIdentity.authoritySha256,
        expectedClusterSha256: expectedIdentity.clusterSha256,
      },
    );
    const afterNormal = await snapshot();
    if (JSON.stringify(afterNormal) !== JSON.stringify(after))
      throw Error("normal_runner_not_noop");
    await writeFile(
      output,
      `${JSON.stringify(
        {
          purpose: "synthetic_rehearsal_only",
          status: "passed",
          postgresMajor: 18,
          initiallyRefused,
          gmailRowsPreserved: true,
          financialPreservation: true,
          creditPacksRetired: true,
          repeatRefused: true,
          normalRunnerAccepts: true,
          normalRunnerNoop: true,
          fullRecoveryRollbackPreserved: true,
          partialRetirementRefused: true,
        },
        null,
        2,
      )}\n`,
    );
  }
} catch {
  await writeFile(
    output,
    `${JSON.stringify(
      {
        purpose: "synthetic_rehearsal_only",
        status: "failed",
        stage,
        failureContext,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
} finally {
  await connection?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
}
