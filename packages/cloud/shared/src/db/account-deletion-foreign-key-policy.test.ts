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
