/** Verifies complete, fail-closed user and organization FK deletion policy. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256,
  type AccountDeletionForeignKeyDescriptor,
  classifyAccountDeletionForeignKey,
  listAccountDeletionForeignKeys,
} from "./account-deletion-foreign-key-policy";

function serializeDescriptor(descriptor: AccountDeletionForeignKeyDescriptor): string {
  return [
    descriptor.sourceTable,
    descriptor.sourceColumns,
    descriptor.targetTable,
    descriptor.targetColumns,
    descriptor.onDelete,
  ].join("|");
}

describe("account deletion full-schema foreign-key policy", () => {
  test("pins the exact direct user and organization FK inventory", () => {
    const descriptors = listAccountDeletionForeignKeys();
    const digest = createHash("sha256")
      .update(descriptors.map(serializeDescriptor).join("\n"))
      .digest("hex");

    expect(descriptors).toHaveLength(219);
    expect(digest).toBe(ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256);
  });

  test("classifies every FK without an implicit destructive fallback", () => {
    const classified = listAccountDeletionForeignKeys().map((descriptor) => ({
      descriptor,
      action: classifyAccountDeletionForeignKey(descriptor),
    }));

    expect(classified).toHaveLength(219);
    expect(classified.every(({ action }) => Boolean(action))).toBe(true);
    expect(classified.filter(({ action }) => action === "reconcile_external_resource").length).toBe(
      69,
    );
    expect(classified.filter(({ action }) => action === "transfer_shared_resource").length).toBe(
      10,
    );
  });

  test("rejects an unknown restrictive relationship", () => {
    expect(() =>
      classifyAccountDeletionForeignKey({
        sourceTable: "new_provider_grants",
        sourceColumns: "organization_id",
        targetTable: "organizations",
        targetColumns: "id",
        onDelete: "restrict",
      }),
    ).toThrow("Unclassified account-deletion foreign key");
  });
});
