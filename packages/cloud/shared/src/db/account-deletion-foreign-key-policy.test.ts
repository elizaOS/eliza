import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256,
  classifyAccountDeletionForeignKey,
  listAccountDeletionForeignKeys,
} from "./account-deletion-foreign-key-policy";

test("account export schema authority matches the current foreign-key inventory", () => {
  const descriptors = listAccountDeletionForeignKeys();
  const serialized = descriptors
    .map((d) =>
      [d.sourceTable, d.sourceColumns, d.targetTable, d.targetColumns, d.onDelete].join("|"),
    )
    .join("\n");
  expect(createHash("sha256").update(serialized).digest("hex")).toBe(
    ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256,
  );
});

test("reviewed renewal receipts retain the same financial handling as commands", () => {
  const receipts = listAccountDeletionForeignKeys().filter(
    (d) => d.sourceTable === "billing_subscription_renewal_reviews",
  );
  expect(receipts).toHaveLength(1);
  expect(classifyAccountDeletionForeignKey(receipts[0]!)).toBe("anonymize_retained_record");
});

test("organization plan quotes retain anonymized financial review history", () => {
  const quotes = listAccountDeletionForeignKeys().filter(
    (d) => d.sourceTable === "organization_plan_change_quotes",
  );
  expect(quotes).toHaveLength(1);
  expect(classifyAccountDeletionForeignKey(quotes[0]!)).toBe("anonymize_retained_record");
});

test("organization upgrade invoice origins retain anonymized financial provenance", () => {
  const receipts = listAccountDeletionForeignKeys().filter(
    (d) => d.sourceTable === "organization_upgrade_invoice_origins",
  );
  expect(receipts).toHaveLength(1);
  expect(classifyAccountDeletionForeignKey(receipts[0]!)).toBe("anonymize_retained_record");
});

for (const table of [
  "organization_upgrade_historical_targets",
  "organization_schedule_effects",
  "organization_schedule_quote_terms",
]) {
  test(`${table} retains anonymized original billing evidence`, () => {
    const references = listAccountDeletionForeignKeys().filter((d) => d.sourceTable === table);
    expect(references).toHaveLength(1);
    expect(classifyAccountDeletionForeignKey(references[0]!)).toBe("anonymize_retained_record");
  });
}
