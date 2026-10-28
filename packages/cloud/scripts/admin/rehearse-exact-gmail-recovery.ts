/** Rehearsal-only transaction orchestration. No production CLI or URL input. */
import {
  type AppliedMigration,
  assertAppliedLedgerHasCanonicalRelations,
  loadCanonicalMigrations,
  validateAppliedMigrationLedger,
} from "./canonical-migration-ledger";
import {
  type DatabaseIdentityReceipt,
  readDatabaseIdentityReceipt,
} from "./database-identity-receipt";
import {
  admitExactGmailRecovery,
  assertRetirementUnapplied,
} from "./exact-gmail-ledger-recovery";
import {
  assertGmailRecoveryCatalog,
  type GmailOwnershipPolicy,
} from "./gmail-recovery-catalog";
import {
  MIGRATION_ADVISORY_LOCK_KEY,
  planMigrationExecution,
} from "./migrate-with-diagnostics";
import {
  type RecoveryTransactionClient,
  runRecoveryTransaction,
} from "./recovery-transaction-boundary";

export interface RehearsalConnection extends RecoveryTransactionClient {
  query<T = unknown>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[]; command: string }>;
}
/** Private lossless PostgreSQL representation; never include this result in receipts. */
export async function readGmailRowsDigest(client: RehearsalConnection) {
  const result = await client.query<{ digest: string; count: string }>(
    `SELECT encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY organization_id,user_id,grant_id,request_id),''),'UTF8')),'hex') AS digest,count(*)::text AS count FROM public.managed_gmail_operation_receipts t`,
  );
  if (result.rows.length !== 1) throw Error("row_digest_unavailable");
  return result.rows[0];
}

function identityMatches(
  actual: DatabaseIdentityReceipt,
  expected: DatabaseIdentityReceipt,
) {
  return (
    actual.environment === "staging" &&
    expected.environment === "staging" &&
    actual.postgresMajor === 18 &&
    expected.postgresMajor === 18 &&
    actual.clusterSha256 === expected.clusterSha256 &&
    actual.authoritySha256 === expected.authoritySha256
  );
}

/** Caller creates a fresh loopback PG18 database; this hard gate excludes normal databases. */
export async function rehearseExactGmailRecovery(input: {
  client: RehearsalConnection;
  databaseName: string;
  expectedIdentity: DatabaseIdentityReceipt;
  ownership: GmailOwnershipPolicy;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}) {
  const { client } = input;
  let stage = "admission";
  try {
    if (!/^recovery_rehearsal_[a-f0-9]{16}$/.test(input.databaseName))
      throw Error("rehearsal_database_required");
    for (const value of [input.lockTimeoutMs, input.statementTimeoutMs])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw Error("timeout_required");
    const database = await client.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    if (
      database.rows.length !== 1 ||
      database.rows[0].name !== input.databaseName
    )
      throw Error("rehearsal_database_required");
    if (
      !identityMatches(
        await readDatabaseIdentityReceipt(client, "staging"),
        input.expectedIdentity,
      )
    )
      throw Error("identity_mismatch");
    const migrations = await loadCanonicalMigrations();
    const outcome = await runRecoveryTransaction(client, async () => {
      stage = "identity_and_locks";
      await client.query(
        "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
        [`${input.lockTimeoutMs}ms`, `${input.statementTimeoutMs}ms`],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [MIGRATION_ADVISORY_LOCK_KEY],
      );
      await client.query(
        "LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE",
      );
      await client.query(
        "LOCK TABLE public.managed_gmail_operation_receipts IN ACCESS EXCLUSIVE MODE",
      );
      if (
        !identityMatches(
          await readDatabaseIdentityReceipt(client, "staging"),
          input.expectedIdentity,
        )
      )
        throw Error("identity_mismatch");
      stage = "exact_state_and_schema";
      const initial = await client.query<AppliedMigration>(
        "SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC LIMIT 373",
      );
      const plan = admitExactGmailRecovery(migrations, initial.rows);
      await assertRetirementUnapplied(client);
      await assertGmailRecoveryCatalog(client, input.ownership);
      const originalGmailRows = await readGmailRowsDigest(client);
      for (const migration of migrations.slice(plan.prefixLength))
        if (planMigrationExecution(migration).mode !== "transactional")
          throw Error("nontransactional_recovery_forbidden");
      stage = "private_exception_archive";
      // Existing archive is a different state and must not be overwritten or silently reused.
      await client.query(
        "CREATE TABLE drizzle.__gmail_recovery_v1 (original_id integer PRIMARY KEY, original_hash text NOT NULL, original_time bigint NOT NULL, canonical_tag text NOT NULL UNIQUE, source_sha256 text NOT NULL)",
      );
      const retained = plan.actions.filter(
        (a) => a.action === "retain_existing_effects",
      );
      for (const [index, action] of retained.entries()) {
        const original = initial.rows[plan.prefixLength + index];
        await client.query(
          "INSERT INTO drizzle.__gmail_recovery_v1 VALUES($1,$2,$3,$4,$5)",
          [
            original.id,
            original.hash,
            original.created_at,
            action.tag,
            plan.sourceSha256,
          ],
        );
      }
      const removed = await client.query<{ id: number }>(
        "DELETE FROM drizzle.__drizzle_migrations WHERE id IN($1,$2) RETURNING id",
        initial.rows.slice(plan.prefixLength).map((row) => row.id),
      );
      if (removed.rows.length !== 2) throw Error("exception_state_changed");
      for (const action of plan.actions) {
        stage = action.tag;
        const migration = migrations.find((m) => m.entry.tag === action.tag);
        if (!migration) throw Error("source_mismatch");
        if (action.action === "apply_sql")
          for (const statement of migration.statements)
            await client.query(statement);
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)",
          [migration.hash, migration.entry.when],
        );
      }
      stage = "final_validation";
      const final = await client.query<AppliedMigration>(
        "SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC",
      );
      if (final.rows.length !== migrations.length)
        throw Error("final_ledger_shape");
      validateAppliedMigrationLedger(final.rows, migrations);
      await assertAppliedLedgerHasCanonicalRelations(client);
      await assertGmailRecoveryCatalog(client, input.ownership);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      if (
        !identityMatches(
          await readDatabaseIdentityReceipt(client, "staging"),
          input.expectedIdentity,
        )
      )
        throw Error("identity_mismatch");
      const finalGmailRows = await readGmailRowsDigest(client);
      if (
        originalGmailRows.digest !== finalGmailRows.digest ||
        originalGmailRows.count !== finalGmailRows.count
      )
        throw Error("gmail_rows_changed");
      stage = "commit";
    });
    return { purpose: "rehearsal_only" as const, ...outcome, stage };
  } catch {
    // error-policy:J1 only fixed stages or reviewed canonical tags leave rehearsal.
    return {
      purpose: "rehearsal_only" as const,
      status: "not_started" as const,
      stage,
    };
  }
}
