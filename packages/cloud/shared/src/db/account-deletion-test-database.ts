/** Restricts destructive account-deletion integration tests to isolated local databases. */

export type AccountDeletionTestDatabase = "pglite" | "loopback-postgres";

export function resolveAccountDeletionTestDatabase(
  env: Record<string, string | undefined> = process.env,
): AccountDeletionTestDatabase | null {
  const rawUrl = env.TEST_DATABASE_URL || env.DATABASE_URL || "";
  if (rawUrl === "" || rawUrl.startsWith("pglite:")) return "pglite";
  if (env.ELIZA_ACCOUNT_DELETION_REAL_POSTGRES_TEST !== "1") return null;

  try {
    const url = new URL(rawUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    const expectedDatabase = url.pathname === "/eliza_account_deletion_test";
    const expectedUser = decodeURIComponent(url.username) === "eliza_test";
    const postgres = url.protocol === "postgres:" || url.protocol === "postgresql:";
    return loopback && expectedDatabase && expectedUser && postgres ? "loopback-postgres" : null;
  } catch {
    return null;
  }
}
