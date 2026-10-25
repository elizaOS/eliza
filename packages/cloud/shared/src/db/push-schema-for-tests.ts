/**
 * TEST-ONLY schema-push helpers for PGlite-backed suites.
 *
 * `drizzle-kit` is a devDependency of @elizaos/cloud-shared, so a test that
 * lives in another package (e.g. cloud-api's route integration tests) cannot
 * resolve `drizzle-kit/api` from its own directory. Importing it through this
 * module resolves from cloud-shared instead. Never import this from runtime
 * code — drizzle-kit is not installed for production consumers.
 */

import { pushSchema } from "drizzle-kit/api";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { getPgliteClientForTests } from "./client";

export { pushSchema };

/**
 * Apply the given Drizzle tables' DDL to the same PGlite database the
 * exported `db`/`dbRead`/`dbWrite` proxies query. drizzle-kit's `pushSchema`
 * parameter is typed as a schema-LESS `PgDatabase`, so the repo's
 * schema-typed `Database` cannot be passed directly without a type assertion;
 * wrapping the raw PGlite client in a fresh schema-less drizzle instance
 * keeps the whole path type-checked while targeting the identical database.
 * Fails closed (via `getPgliteClientForTests`) when the ambient DATABASE_URL
 * is a shared non-PGlite Postgres.
 */
export async function pushSchemaToTestDb(tables: Record<string, unknown>): Promise<void> {
  const { apply } = await pushSchema(tables, drizzlePglite({ client: getPgliteClientForTests() }));
  await apply();
}
