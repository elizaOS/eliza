/**
 * Local Database Connection for Testing
 *
 * Uses the same DATABASE_URL as the running server.
 * No Docker, no migrations needed - just connect and create test fixtures.
 */

import { Client } from "pg";
import { resolveDatabaseUrl } from "@/db/database-url";

/** True when DATABASE_URL is set (use with describe.skipIf(!hasDatabaseUrl) for DB-dependent suites). */
export const hasDatabaseUrl = typeof resolveDatabaseUrl(process.env) === "string";

/**
 * Get the connection string from environment
 */
export function getConnectionString(): string {
  const url = resolveDatabaseUrl(process.env);
  if (!url) {
    throw new Error(
      "DATABASE_URL is not configured and local Docker Postgres fallback is unavailable.",
    );
  }
  return url;
}

/**
 * Verify database connection is working
 */
export async function verifyConnection(): Promise<boolean> {
  const connectionString = getConnectionString();
  const client = new Client({ connectionString });

  try {
    await client.connect();
    await client.query("SELECT 1");
    console.log("[LocalDB] Connection verified");
    return true;
  } catch (error) {
    console.error("[LocalDB] Connection failed:", error);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Get database info for debugging
 */
export async function getDatabaseInfo(): Promise<{
  connected: boolean;
  database?: string;
  tables?: string[];
}> {
  const connectionString = getConnectionString();
  const client = new Client({ connectionString });

  try {
    await client.connect();

    const dbResult = await client.query("SELECT current_database()");
    const database = dbResult.rows[0]?.current_database;

    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tables = tablesResult.rows.map((r) => r.table_name);

    return { connected: true, database, tables };
  } catch (error) {
    console.error("[LocalDB] Info query failed:", error);
    return { connected: false };
  } finally {
    await client.end().catch(() => {});
  }
}

const localDatabase = {
  getConnectionString,
  verifyConnection,
  getDatabaseInfo,
};

export default localDatabase;
