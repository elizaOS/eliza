/** Proves destructive account-deletion database tests cannot target remote or ambiguous databases. */

import { describe, expect, test } from "bun:test";
import { resolveAccountDeletionTestDatabase } from "./account-deletion-test-database";

describe("resolveAccountDeletionTestDatabase", () => {
  test("allows in-memory PGlite without an external opt-in", () => {
    expect(resolveAccountDeletionTestDatabase({ DATABASE_URL: "pglite://memory" })).toBe("pglite");
  });

  test("allows only the explicitly armed loopback test database and user", () => {
    expect(
      resolveAccountDeletionTestDatabase({
        DATABASE_URL: "postgresql://eliza_test:local@127.0.0.1:55432/eliza_account_deletion_test",
        ELIZA_ACCOUNT_DELETION_REAL_POSTGRES_TEST: "1",
      }),
    ).toBe("loopback-postgres");
  });

  test.each([
    "postgresql://eliza_test:local@db.example.com/eliza_account_deletion_test",
    "postgresql://production:local@127.0.0.1:55432/eliza_account_deletion_test",
    "postgresql://eliza_test:local@127.0.0.1:55432/production",
  ])("rejects unsafe target %s", (databaseUrl) => {
    expect(
      resolveAccountDeletionTestDatabase({
        DATABASE_URL: databaseUrl,
        ELIZA_ACCOUNT_DELETION_REAL_POSTGRES_TEST: "1",
      }),
    ).toBeNull();
  });
});
