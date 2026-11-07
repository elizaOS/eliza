import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { assertGmailRecoveryCatalog } from "./gmail-recovery-catalog";

test("authentic0509+0535 complete catalog matches; partial or hidden drift rejects without stored definitions", async () => {
  const db = new PGlite("memory://");
  try {
    await db.exec(
      "CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY)",
    );
    await db.exec(
      await readFile(
        new URL(
          "../../shared/src/db/migrations/0509_managed_gmail_operation_receipts.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await expect(
      assertGmailRecoveryCatalog(db, {
        tableOwnerRole: "postgres",
        functionOwnerRole: "postgres",
      }),
    ).rejects.toThrow("gmail_recovery_catalog_mismatch");
    await db.exec(
      await readFile(
        new URL(
          "../../shared/src/db/migrations/0535_managed_gmail_read_state_operations.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await assertGmailRecoveryCatalog(db, {
      tableOwnerRole: "postgres",
      functionOwnerRole: "postgres",
    });
    await expect(
      assertGmailRecoveryCatalog(db, {
        tableOwnerRole: "unapproved_role",
        functionOwnerRole: "postgres",
      }),
    ).rejects.toThrow("gmail_recovery_catalog_mismatch");
    for (const change of [
      "CREATE RULE private_rule AS ON DELETE TO managed_gmail_operation_receipts DO INSTEAD NOTHING",
      "CREATE TABLE private_child() INHERITS(managed_gmail_operation_receipts)",
      "ALTER TABLE managed_gmail_operation_receipts DISABLE TRIGGER ALL",
      "GRANT SELECT (provider_result) ON managed_gmail_operation_receipts TO PUBLIC",
      "ALTER TABLE managed_gmail_operation_receipts ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE managed_gmail_operation_receipts ADD COLUMN private_extra text DEFAULT 'PRIVATE_VALUE'",
      "ALTER TABLE managed_gmail_operation_receipts DROP CONSTRAINT managed_gmail_operation_receipts_user_id_fkey",
      "ALTER TABLE managed_gmail_operation_receipts DISABLE TRIGGER managed_gmail_operation_receipt_guard",
      "CREATE FUNCTION guard_managed_gmail_operation_receipt(integer) RETURNS integer LANGUAGE sql AS 'SELECT 1'",
    ]) {
      await db.exec("BEGIN");
      await db.exec(change);
      try {
        await assertGmailRecoveryCatalog(db, {
          tableOwnerRole: "postgres",
          functionOwnerRole: "postgres",
        });
        throw Error("admitted");
      } catch (error) {
        expect(String(error)).toBe("Error: gmail_recovery_catalog_mismatch");
        expect(String(error)).not.toContain("PRIVATE_VALUE");
      }
      await db.exec("ROLLBACK");
      await assertGmailRecoveryCatalog(db, {
        tableOwnerRole: "postgres",
        functionOwnerRole: "postgres",
      });
    }
  } finally {
    await db.close();
  }
});
