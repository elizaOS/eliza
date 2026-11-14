import { expect, test } from "bun:test";
import {
  loadCanonicalMigrations,
  validateAppliedMigrationLedger,
} from "./canonical-migration-ledger";
import {
  admitExactGmailRecovery,
  RecoveryAdmissionError,
} from "./exact-gmail-ledger-recovery";

const migrations = await loadCanonicalMigrations();
function observed() {
  const rows = migrations
    .slice(0, 370)
    .map((m, i) => ({ id: i + 1, hash: m.hash, created_at: m.entry.when }));
  for (const [offset, tag] of [
    "0509_managed_gmail_operation_receipts",
    "0535_managed_gmail_read_state_operations",
  ].entries()) {
    const m = migrations.find((m) => m.entry.tag === tag);
    if (!m) throw Error("Missing reviewed fixture");
    rows.push({
      id: 371 + offset,
      hash: m.hash,
      created_at: migrations[370 + offset].entry.when,
    });
  }
  return rows;
}
test("exact source and observed ledger yield147 missing SQL actions and two retained effects without admitting normal readiness", () => {
  const rows = observed();
  expect(() => validateAppliedMigrationLedger(rows, migrations)).toThrow();
  const plan = admitExactGmailRecovery(migrations, rows);
  expect(plan.purpose).toBe("rehearsal_only");
  expect(plan.missingSqlCount).toBe(147);
  expect(plan.retainedEffectsCount).toBe(2);
  expect(
    plan.actions
      .filter((a) => a.action === "retain_existing_effects")
      .map((a) => a.tag),
  ).toEqual([
    "0509_managed_gmail_operation_receipts",
    "0535_managed_gmail_read_state_operations",
  ]);
  expect(() => validateAppliedMigrationLedger(rows, migrations)).toThrow();
  for (const row of rows) expect(JSON.stringify(plan)).not.toContain(row.hash);
});
test("source edits and any different ledger state fail closed with fixed errors", () => {
  const edited = structuredClone(migrations);
  edited[370].statements.push("SELECT 'PRIVATE_SQL'");
  expect(() => admitExactGmailRecovery(edited, observed())).toThrow(
    "source_mismatch",
  );
  for (const change of [
    (r: ReturnType<typeof observed>) => r.pop(),
    (r: ReturnType<typeof observed>) => {
      r[0].hash = "PRIVATE_HASH";
    },
    (r: ReturnType<typeof observed>) => {
      r[370].created_at =
        migrations.find(
          (m) => m.entry.tag === "0509_managed_gmail_operation_receipts",
        )?.entry.when ?? 0;
    },
    (r: ReturnType<typeof observed>) => {
      r[371].hash = "PRIVATE_HASH";
    },
    (r: ReturnType<typeof observed>) => {
      r[371].id = r[370].id;
    },
  ]) {
    const rows = observed();
    change(rows);
    try {
      admitExactGmailRecovery(migrations, rows);
      throw Error("admitted");
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveryAdmissionError);
      expect(String(error)).not.toContain("PRIVATE");
    }
  }
});
