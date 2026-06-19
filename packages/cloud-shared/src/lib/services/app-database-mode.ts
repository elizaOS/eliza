/**
 * App database mode (Apps / Product 2) — whether a hosted app gets its OWN
 * isolated per-tenant Postgres, or runs stateless with no database.
 *
 * Stored on `apps.metadata.databaseMode` (jsonb — no schema migration, additive)
 * and read at deploy time by the deploy orchestrator:
 *   - "none" (DEFAULT): a stateless app (static SPA + stateless API, e.g.
 *     elocute). No tenant DB is provisioned and NO `DATABASE_URL` is injected —
 *     so there's never a silent fallback to a shared/throwaway store.
 *   - "isolated": the app gets its OWN isolated tenant Postgres (DATABASE +
 *     ROLE + REVOKE CONNECT); the DSN is injected as `DATABASE_URL` +
 *     `POSTGRES_URL`.
 *
 * Switchable later, seamlessly: flip `none -> isolated` and redeploy and the DB
 * is materialized + wired in (the provision step is create-if-not-exists, so it
 * is idempotent). Flipping `isolated -> none` stops injecting the DSN but leaves
 * the database intact (destroying tenant data is a separate, explicit action).
 */

export type AppDatabaseMode = "none" | "isolated";

export const APP_DATABASE_MODES: readonly AppDatabaseMode[] = ["none", "isolated"];

export const DEFAULT_APP_DATABASE_MODE: AppDatabaseMode = "none";

/** Type guard for an `AppDatabaseMode` (e.g. validating request input). */
export function isAppDatabaseMode(value: unknown): value is AppDatabaseMode {
  return value === "none" || value === "isolated";
}

/**
 * Resolve an app's database mode from its `metadata` jsonb. Unknown / missing /
 * malformed values fall back to the default ("none"), so an app is never
 * accidentally handed an isolated DB it didn't ask for.
 */
export function resolveAppDatabaseMode(
  metadata: Record<string, unknown> | null | undefined,
): AppDatabaseMode {
  const raw = metadata?.databaseMode;
  return isAppDatabaseMode(raw) ? raw : DEFAULT_APP_DATABASE_MODE;
}
