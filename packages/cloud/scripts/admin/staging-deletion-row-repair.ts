/**
 * Staging-only, owner-approved repair for the single agent row that blocks
 * migration 0398 (`AGENT_DELETION_BILLING_PROVENANCE_UNRESOLVED`).
 *
 * The row is a legacy failed deletion: `deletion_failed`, no captured
 * pre-deletion status or billing status, no compute funding and no provider
 * stop record. Its provider server no longer exists, so no historical billing
 * authority can be recovered. The owner chose to retire it by setting
 * `deleted_at`, which the guard excludes. Nothing else changes: the update
 * touches only `deleted_at` and `updated_at`, so the rate-segment trigger
 * (status / tier / backup / pool columns) does not fire and no billing record
 * is written.
 *
 * Selection comes from the committed migration's own predicate, so the script
 * can only ever act on rows the guard reports. `dry-run` (default) prints the
 * guarded row IDs and lifecycle fields in a read-only transaction. `apply`
 * requires the exact agent ID and a reason, and commits only when the guard
 * reports exactly that one row, the row still has the precise failing state,
 * exactly one row changes, and the guard reports zero rows afterwards. Every
 * step runs on one session whose identity matches the pinned staging receipts.
 *
 * Runs only from `.github/workflows/cloud-staging-deletion-row-repair.yml`.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { testOutputPath } from "../../../scripts/lib/test-output";
import { unresolvedAgentSelector } from "./deletion-billing-provenance-report";
import type { IdentityQueryClient } from "./preflight-database-identity";
import {
  assertStagingDatabaseIdentity,
  assertStagingOperatorEnvironment,
  StagingDatabaseIdentityError,
} from "./staging-database-identity-pin";

export class StagingDeletionRowRepairError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StagingDeletionRowRepairError";
  }
}

export type RepairMode = "dry-run" | "apply";

export interface RepairOptions {
  mode: RepairMode;
  agentId?: string;
  reason?: string;
}

export interface GuardedAgentState {
  id: string;
  status: string;
  billingStatus: string;
  deletionPreviousStatus: string | null;
  deletionPreviousBillingStatus: string | null;
  executionTier: string;
  poolStatus: string | null;
  deleted: boolean;
  hasDeletionAttempt: boolean;
  hasFunding: boolean;
  hasStopIntent: boolean;
}

export interface RepairReceipt {
  schemaVersion: 1;
  kind: "staging-deletion-row-repair";
  mode: RepairMode;
  migrationSha256: string;
  guardedAgents: GuardedAgentState[];
  changedAgentId: string | null;
  reason: string | null;
  remainingUnresolvedAgentCount: number;
}

interface RepairClient extends IdentityQueryClient {
  query(text: string, parameters?: unknown[]): Promise<{ rows: unknown[] }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseRepairOptions(
  environment: Readonly<Record<string, string | undefined>>,
): RepairOptions {
  const mode = environment.REPAIR_MODE?.trim() || "dry-run";
  if (mode !== "dry-run" && mode !== "apply") {
    throw new StagingDeletionRowRepairError("invalid_mode");
  }
  const agentId =
    environment.REPAIR_AGENT_ID?.trim().toLowerCase() || undefined;
  if (agentId !== undefined && !UUID.test(agentId)) {
    throw new StagingDeletionRowRepairError("invalid_agent_id");
  }
  const reason = environment.REPAIR_REASON?.trim() || undefined;
  if (mode === "apply") {
    if (!agentId) throw new StagingDeletionRowRepairError("agent_id_required");
    if (!reason || reason.length < 20 || reason.length > 500) {
      throw new StagingDeletionRowRepairError("reason_required");
    }
  }
  return { mode, agentId, reason };
}

function guardedAgentsQuery(migration: string): string {
  return `
    WITH unresolved AS (${unresolvedAgentSelector(migration)})
    SELECT u.id::text AS id, u.status, u.billing_status,
      u.deletion_previous_status, u.deletion_previous_billing_status,
      u.execution_tier, u.pool_status,
      (u.deleted_at IS NOT NULL) AS deleted,
      (u.deletion_attempt_id IS NOT NULL) AS has_deletion_attempt,
      EXISTS (SELECT 1 FROM agent_compute_funding f
        WHERE f.organization_id = u.organization_id AND f.agent_id = u.id) AS has_funding,
      EXISTS (SELECT 1 FROM agent_compute_stop_intents i
        WHERE i.organization_id = u.organization_id AND i.agent_id = u.id) AS has_stop_intent
    FROM unresolved u
    ORDER BY u.id
  `;
}

function readGuardedRow(row: unknown): GuardedAgentState {
  if (!row || typeof row !== "object") {
    throw new StagingDeletionRowRepairError("guard_row_invalid");
  }
  const value = (key: string) => Reflect.get(row, key);
  const text = (key: string) => {
    const v = value(key);
    if (typeof v !== "string") {
      throw new StagingDeletionRowRepairError("guard_row_invalid");
    }
    return v;
  };
  const nullableText = (key: string) => {
    const v = value(key);
    if (v !== null && typeof v !== "string") {
      throw new StagingDeletionRowRepairError("guard_row_invalid");
    }
    return v;
  };
  const flag = (key: string) => {
    const v = value(key);
    if (typeof v !== "boolean") {
      throw new StagingDeletionRowRepairError("guard_row_invalid");
    }
    return v;
  };
  return {
    id: text("id"),
    status: text("status"),
    billingStatus: text("billing_status"),
    deletionPreviousStatus: nullableText("deletion_previous_status"),
    deletionPreviousBillingStatus: nullableText(
      "deletion_previous_billing_status",
    ),
    executionTier: text("execution_tier"),
    poolStatus: nullableText("pool_status"),
    deleted: flag("deleted"),
    hasDeletionAttempt: flag("has_deletion_attempt"),
    hasFunding: flag("has_funding"),
    hasStopIntent: flag("has_stop_intent"),
  };
}

/** The exact failing state the owner approved for retirement. */
export function isApprovedRepairState(row: GuardedAgentState): boolean {
  return (
    row.status === "deletion_failed" &&
    row.deletionPreviousStatus === null &&
    row.deletionPreviousBillingStatus === null &&
    !row.deleted &&
    !row.hasFunding &&
    !row.hasStopIntent
  );
}

export async function runStagingDeletionRowRepair(
  client: RepairClient,
  migration: string,
  options: RepairOptions,
  assertIdentity: (
    client: IdentityQueryClient,
  ) => Promise<void> = assertStagingDatabaseIdentity,
): Promise<RepairReceipt> {
  const query = guardedAgentsQuery(migration);
  const migrationSha256 = createHash("sha256").update(migration).digest("hex");
  await client.query(
    options.mode === "apply"
      ? "BEGIN ISOLATION LEVEL READ COMMITTED"
      : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  let committed = false;
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await assertIdentity(client);
    if (options.mode === "apply") {
      // Same lock set as the 0398 guard: no lifecycle or funding writer can
      // change the selected row's authority between the check and the update.
      await client.query(
        "LOCK TABLE agent_sandboxes, agent_compute_funding, agent_compute_stop_intents IN SHARE ROW EXCLUSIVE MODE",
      );
    }
    const guardedAgents = (await client.query(query)).rows.map(readGuardedRow);
    if (options.mode === "dry-run") {
      return {
        schemaVersion: 1,
        kind: "staging-deletion-row-repair",
        mode: "dry-run",
        migrationSha256,
        guardedAgents,
        changedAgentId: null,
        reason: null,
        remainingUnresolvedAgentCount: guardedAgents.length,
      };
    }

    const target = guardedAgents[0];
    if (guardedAgents.length !== 1 || !target) {
      throw new StagingDeletionRowRepairError(
        "guard_must_report_exactly_one_row",
      );
    }
    if (target.id !== options.agentId) {
      throw new StagingDeletionRowRepairError("agent_id_does_not_match_guard");
    }
    if (!isApprovedRepairState(target)) {
      throw new StagingDeletionRowRepairError("row_state_not_approved");
    }
    const updated = await client.query(
      `UPDATE agent_sandboxes a
          SET deleted_at = now(), updated_at = now()
        WHERE a.id = $1::uuid
          AND a.status = 'deletion_failed'
          AND a.deleted_at IS NULL
          AND a.deletion_previous_status IS NULL
          AND a.deletion_previous_billing_status IS NULL
          AND NOT EXISTS (SELECT 1 FROM agent_compute_funding f
            WHERE f.organization_id = a.organization_id AND f.agent_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM agent_compute_stop_intents i
            WHERE i.organization_id = a.organization_id AND i.agent_id = a.id)
        RETURNING a.id::text AS id`,
      [options.agentId],
    );
    if (
      updated.rows.length !== 1 ||
      Reflect.get(updated.rows[0] as object, "id") !== options.agentId
    ) {
      throw new StagingDeletionRowRepairError(
        "expected_exactly_one_row_changed",
      );
    }
    const remaining = (await client.query(query)).rows.length;
    if (remaining !== 0) {
      throw new StagingDeletionRowRepairError("guard_still_unresolved");
    }
    await client.query("COMMIT");
    committed = true;
    return {
      schemaVersion: 1,
      kind: "staging-deletion-row-repair",
      mode: "apply",
      migrationSha256,
      guardedAgents,
      changedAgentId: target.id,
      reason: options.reason ?? null,
      remainingUnresolvedAgentCount: remaining,
    };
  } finally {
    if (!committed) await client.query("ROLLBACK");
  }
}

function errorCode(error: unknown): string {
  if (
    error instanceof StagingDeletionRowRepairError ||
    error instanceof StagingDatabaseIdentityError
  ) {
    return error.code;
  }
  // Only the SQLSTATE: driver messages can carry host or role names.
  const sqlstate =
    error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  return typeof sqlstate === "string" && /^[0-9A-Z]{5}$/.test(sqlstate)
    ? `database_error_${sqlstate}`
    : "staging_deletion_row_repair_failed";
}

if (import.meta.main) {
  let client:
    | Awaited<
        ReturnType<
          typeof import("./preflight-database-identity").createRuntimePgClient
        >
      >
    | undefined;
  try {
    assertStagingOperatorEnvironment();
    const options = parseRepairOptions(process.env);
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new StagingDeletionRowRepairError("database_url_required");
    }
    const migration = await readFile(
      new URL(
        "../../shared/src/db/migrations/0398_provider_unconfirmed_deletion_billing.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const { createRuntimePgClient } = await import(
      "./preflight-database-identity"
    );
    client = await createRuntimePgClient(databaseUrl);
    client.on("error", () => {
      process.exitCode = 1;
    });
    await client.connect();
    const receipt = await runStagingDeletionRowRepair(
      client,
      migration,
      options,
    );
    const json = `${JSON.stringify({ ...receipt, sourceSha: process.env.GITHUB_SHA })}\n`;
    const output = testOutputPath(
      "cloud-staging-repair",
      "deletion-row-repair.json",
    );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
    process.stdout.write(json);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const lines = [
        `### Staging 0398 deletion row repair (${receipt.mode})`,
        "",
        `- Guarded rows before: ${receipt.guardedAgents.length}`,
        ...receipt.guardedAgents.map(
          (row) =>
            `  - \`${row.id}\` status=${row.status} billing=${row.billingStatus} previous_status=${row.deletionPreviousStatus ?? "null"} previous_billing=${row.deletionPreviousBillingStatus ?? "null"} funding=${row.hasFunding} stop_intent=${row.hasStopIntent} deleted=${row.deleted}`,
        ),
        `- Changed row: ${receipt.changedAgentId ? `\`${receipt.changedAgentId}\`` : "none"}`,
        `- Reason: ${receipt.reason ?? "n/a"}`,
        `- Guarded rows after: ${receipt.remainingUnresolvedAgentCount}`,
        "",
      ];
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `${lines.join("\n")}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `[staging-deletion-row-repair] failed: ${errorCode(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await client?.end();
  }
}
