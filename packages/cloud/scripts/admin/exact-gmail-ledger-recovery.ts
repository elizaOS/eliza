/** Source/state admission for the one observed370-prefix + two Gmail recovery.
 * This module has no production entry point and does not execute SQL.
 */
import { createHash } from "node:crypto";
import {
  type AppliedMigration,
  createdAtValue,
  type Migration,
  validateAppliedMigrationLedger,
} from "./canonical-migration-ledger";

const SOURCE_SHA256 =
  "80b7debe2ff3dace57880983b81563fca388bda065765b7e0fc999735b593261";
const PREFIX_LENGTH = 370;
const PREAPPLIED_TAGS = [
  "0509_managed_gmail_operation_receipts",
  "0535_managed_gmail_read_state_operations",
] as const;
export type RecoveryRefusal =
  | "source_mismatch"
  | "ledger_shape_mismatch"
  | "prefix_mismatch"
  | "exception_mismatch";
export class RecoveryAdmissionError extends Error {
  constructor(readonly reason: RecoveryRefusal) {
    super(reason);
  }
}

export interface ExactRecoveryPlan {
  purpose: "rehearsal_only";
  sourceSha256: string;
  prefixLength: number;
  actions: Array<{
    tag: string;
    action: "apply_sql" | "retain_existing_effects";
  }>;
  missingSqlCount: number;
  retainedEffectsCount: number;
}

export function admitExactGmailRecovery(
  migrations: Migration[],
  rows: AppliedMigration[],
): ExactRecoveryPlan {
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        migrations.map((x) => ({
          entry: x.entry,
          hash: x.hash,
          statements: x.statements,
        })),
      ),
    )
    .digest("hex");
  if (digest !== SOURCE_SHA256 || migrations.length !== 519)
    throw new RecoveryAdmissionError("source_mismatch");
  // No source relabeling: pin statements as well as hashes and journal entries.
  if (
    rows.length !== PREFIX_LENGTH + PREAPPLIED_TAGS.length ||
    rows.some(
      (row, index) =>
        !Number.isSafeInteger(row.id) ||
        row.id < 1 ||
        (index > 0 && row.id <= rows[index - 1].id),
    )
  )
    throw new RecoveryAdmissionError("ledger_shape_mismatch");
  for (let i = 0; i < PREFIX_LENGTH; i++) {
    if (
      rows[i].hash !== migrations[i].hash ||
      createdAtValue(rows[i]) !== migrations[i].entry.when
    )
      throw new RecoveryAdmissionError("prefix_mismatch");
  }
  // Preserve the unchanged canonical validator; it must accept the exact prefix.
  try {
    validateAppliedMigrationLedger(rows.slice(0, PREFIX_LENGTH), migrations);
  } catch {
    throw new RecoveryAdmissionError("prefix_mismatch");
  }
  for (let i = 0; i < PREAPPLIED_TAGS.length; i++) {
    const expected = migrations.find((m) => m.entry.tag === PREAPPLIED_TAGS[i]);
    if (
      !expected ||
      rows[PREFIX_LENGTH + i].hash !== expected.hash ||
      createdAtValue(rows[PREFIX_LENGTH + i]) !==
        migrations[PREFIX_LENGTH + i].entry.when
    )
      throw new RecoveryAdmissionError("exception_mismatch");
  }
  const actions = migrations.slice(PREFIX_LENGTH).map((m) => ({
    tag: m.entry.tag,
    action: PREAPPLIED_TAGS.some((tag) => tag === m.entry.tag)
      ? ("retain_existing_effects" as const)
      : ("apply_sql" as const),
  }));
  return {
    purpose: "rehearsal_only",
    sourceSha256: SOURCE_SHA256,
    prefixLength: PREFIX_LENGTH,
    actions,
    missingSqlCount: actions.filter((a) => a.action === "apply_sql").length,
    retainedEffectsCount: PREAPPLIED_TAGS.length,
  };
}

/** This recovery has no0500 ledger evidence; never inherit partial retirement. */
export async function assertRetirementUnapplied(client: {
  query<T>(sql: string): Promise<{ rows: T[] }>;
}): Promise<void> {
  const result = await client.query<{
    sentinel: boolean;
    statements: boolean;
  }>(`SELECT
    to_regclass('public.creator_monetization_retirement') IS NOT NULL AS sentinel,
    to_regclass('public.creator_earnings_retirement_statements') IS NOT NULL AS statements`);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.sentinel !== false ||
    row?.statements !== false
  )
    throw new Error("retirement_preexisting_state");
}
