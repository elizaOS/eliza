/** Verifies complete, fail-closed user and organization FK deletion policy. */

import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schemas";
import {
  ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256,
  classifyAccountDeletionForeignKey,
  type AccountDeletionForeignKeyDescriptor,
} from "./account-deletion-foreign-key-policy";

function directAccountForeignKeys(): AccountDeletionForeignKeyDescriptor[] {
  const tableNames = new Set<string>();
  const descriptors: AccountDeletionForeignKeyDescriptor[] = [];

  for (const value of Object.values(schema)) {
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
    } catch {
      continue;
    }
    if (!config.name || tableNames.has(config.name)) continue;
    tableNames.add(config.name);

    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const targetTable = getTableConfig(reference.foreignTable).name;
      if (targetTable !== "organizations" && targetTable !== "users") continue;
      descriptors.push({
        sourceTable: config.name,
        sourceColumns: reference.columns.map((column) => column.name).join(","),
        targetTable,
        targetColumns: reference.foreignColumns
          .map((column) => column.name)
          .join(","),
        onDelete: foreignKey.onDelete ?? "no action",
      });
    }
  }

  return descriptors.sort((left, right) =>
    serializeDescriptor(left).localeCompare(serializeDescriptor(right)),
  );
}

function serializeDescriptor(
  descriptor: AccountDeletionForeignKeyDescriptor,
): string {
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
    const descriptors = directAccountForeignKeys();
    const digest = createHash("sha256")
      .update(descriptors.map(serializeDescriptor).join("\n"))
      .digest("hex");

    expect(descriptors).toHaveLength(215);
    expect(digest).toBe(ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256);
  });

  test("classifies every FK without an implicit destructive fallback", () => {
    const classified = directAccountForeignKeys().map((descriptor) => ({
      descriptor,
      action: classifyAccountDeletionForeignKey(descriptor),
    }));

    expect(classified).toHaveLength(215);
    expect(classified.every(({ action }) => Boolean(action))).toBe(true);
    expect(
      classified.filter(
        ({ action }) => action === "reconcile_external_resource",
      ).length,
    ).toBe(69);
    expect(
      classified.filter(({ action }) => action === "transfer_shared_resource")
        .length,
    ).toBe(10);
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
