/** Verifies complete, fail-closed user and organization FK deletion policy. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
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

    expect(descriptors).toHaveLength(230);
    expect(digest).toBe(ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256);
  });

  test("classifies every FK without an implicit destructive fallback", () => {
    const classified = listAccountDeletionForeignKeys().map((descriptor) => ({
      descriptor,
      action: classifyAccountDeletionForeignKey(descriptor),
    }));

    expect(classified).toHaveLength(230);
    expect(classified.every(({ action }) => Boolean(action))).toBe(true);
    expect(classified.filter(({ action }) => action === "reconcile_external_resource").length).toBe(
      70,
    );
    expect(classified.filter(({ action }) => action === "transfer_shared_resource").length).toBe(
      11,
    );
  });

  test("requires provider reconciliation before deleting sandbox replacement attempts", () => {
    const replacementAttempt = listAccountDeletionForeignKeys().find(
      ({ sourceTable, sourceColumns }) =>
        sourceTable === "agent_sandbox_replacement_attempts" && sourceColumns === "organization_id",
    );

    expect(replacementAttempt).toEqual({
      sourceTable: "agent_sandbox_replacement_attempts",
      sourceColumns: "organization_id",
      targetTable: "organizations",
      targetColumns: "id",
      onDelete: "cascade",
    });
    expect(classifyAccountDeletionForeignKey(replacementAttempt!)).toBe(
      "reconcile_external_resource",
    );
  });

  test("requires reconciliation before deleting backup admission work", () => {
    const admissionWork = listAccountDeletionForeignKeys().find(
      ({ sourceTable, sourceColumns }) =>
        sourceTable === "agent_backup_admission_work" && sourceColumns === "organization_id",
    );

    expect(admissionWork).toEqual({
      sourceTable: "agent_backup_admission_work",
      sourceColumns: "organization_id",
      targetTable: "organizations",
      targetColumns: "id",
      onDelete: "cascade",
    });
    expect(classifyAccountDeletionForeignKey(admissionWork!)).toBe("reconcile_external_resource");
  });

  test("rejects an unknown restrictive relationship", () => {
    let failure: unknown;
    try {
      classifyAccountDeletionForeignKey({
        sourceTable: "new_provider_grants",
        sourceColumns: "organization_id",
        targetTable: "organizations",
        targetColumns: "id",
        onDelete: "restrict",
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ElizaError);
    expect(failure).toMatchObject({
      code: "ACCOUNT_DELETION_FOREIGN_KEY_UNCLASSIFIED",
      severity: "fatal",
    });
  });
});
