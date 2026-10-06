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

test("current billing foreign keys retain their resource, grant and financial policies", () => {
  const policies = {
    app_billing_application_slots: "reconcile_external_resource",
    app_billing_notification_endpoints: "reconcile_external_resource",
    app_billing_scopes: "reconcile_external_resource",
    billing_merchants: "reconcile_external_resource",
    app_billing_members: "delete_private_data",
    subscription_adjustment_attempts: "anonymize_retained_record",
    subscription_adjustment_observations: "anonymize_retained_record",
    subscription_adjustment_scans: "anonymize_retained_record",
  } as const;
  const inventory = listAccountDeletionForeignKeys();
  for (const [table, policy] of Object.entries(policies)) {
    const references = inventory.filter((entry) => entry.sourceTable === table);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(classifyAccountDeletionForeignKey(reference)).toBe(policy);
    }
  }
  for (const reference of inventory) {
    expect(() => classifyAccountDeletionForeignKey(reference)).not.toThrow();
  }
  expect(() =>
    classifyAccountDeletionForeignKey({
      sourceTable: "unreviewed_billing_resource",
      sourceColumns: "organization_id",
      targetTable: "organizations",
      targetColumns: "id",
      onDelete: "restrict",
    }),
  ).toThrow("Unclassified account-deletion foreign key");
});
