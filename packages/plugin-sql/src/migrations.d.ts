import { type IDatabaseAdapter } from "@elizaos/core";
/**
 * TEMPORARY MIGRATION: pre-1.6.5 → 1.6.5+ schema migration
 *
 * This migration runs automatically on startup and is idempotent.
 * It handles the migration from Owner RLS to Server RLS + Entity RLS, including:
 * - Disabling old RLS policies temporarily
 * - Renaming server_id → message_server_id in channels, worlds, rooms
 * - Converting TEXT → UUID where needed
 * - Dropping old server_id columns for RLS
 * - Cleaning up indexes
 *
 * @param adapter - Database adapter
 */
export declare function migrateToEntityRLS(
  adapter: IDatabaseAdapter,
): Promise<void>;
//# sourceMappingURL=migrations.d.ts.map
