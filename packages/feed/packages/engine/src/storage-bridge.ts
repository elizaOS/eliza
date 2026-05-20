/**
 * Storage Bridge
 *
 * Provides a simple interface for switching between database modes.
 * The engine uses @feed/db for all storage operations.
 *
 * ## Modes
 * - **postgres** (default): PostgreSQL database for production
 * - **json**: JSON file storage for simulation/training data generation
 * - **memory**: In-memory storage for testing (no persistence)
 *
 * ## Usage
 * ```typescript
 * import { initializeSimulationMode, db } from '@feed/engine';
 *
 * // For simulation/training - stores to JSON files
 * await initializeSimulationMode('./output');
 *
 * // Use db with ORM-style API - works in all modes
 * const user = await db.user.create({ data: { ... } });
 * const posts = await db.post.findMany({ where: { authorId: user.id } });
 * await db.user.update({ where: { id: user.id }, data: { ... } });
 * await db.user.delete({ where: { id: user.id } });
 *
 * // Save state to JSON (simulation/test mode only)
 * await saveSnapshot();
 * ```
 *
 * ## API in JSON/Memory Mode
 * Use the **ORM-style API** (`db.table.create/findMany/update/delete`):
 * - `db.table.findUnique({ where: ... })`
 * - `db.table.findFirst({ where: ..., orderBy: ... })`
 * - `db.table.findMany({ where: ..., take: ..., skip: ..., orderBy: ... })`
 * - `db.table.create({ data: ... })`
 * - `db.table.createMany({ data: [...] })`
 * - `db.table.update({ where: ..., data: ... })`
 * - `db.table.updateMany({ where: ..., data: ... })`
 * - `db.table.delete({ where: ... })`
 * - `db.table.deleteMany({ where: ... })`
 * - `db.table.upsert({ where: ..., create: ..., update: ... })`
 * - `db.table.count({ where: ... })`
 *
 * **Note**: Raw Drizzle query builder methods (`db.insert(table)`, `db.update(table)`,
 * `db.delete(table)`, `db.select()`) are NOT supported in JSON/memory mode.
 * These methods are only available in PostgreSQL mode.
 */

import {
  db,
  isSimulationMode as dbIsSimulationMode,
  exportJsonState,
  getStorageMode,
  initializeJsonMode,
  initializeMemoryMode,
  loadJsonSnapshot,
  resetToPostgresMode,
  type StorageMode,
  saveJsonSnapshot,
} from '@feed/db';

// Re-export db for convenience
// Re-export storage mode utilities
export { db, getStorageMode, type StorageMode };

/**
 * Initialize the engine in simulation mode.
 * All data will be stored in JSON files, no database required.
 */
export async function initializeSimulationMode(
  basePath = './simulation-data'
): Promise<void> {
  await initializeJsonMode(basePath);
}

/**
 * Initialize the engine in test mode.
 * All data is stored in memory and not persisted.
 */
export async function initializeTestMode(): Promise<void> {
  await initializeMemoryMode();
}

/**
 * Initialize the engine in database mode (production).
 * This is the default mode and doesn't require explicit initialization.
 */
export function initializeDatabaseMode(): void {
  resetToPostgresMode();
}

/**
 * Check if we're in database mode (production).
 */
export function isDatabaseMode(): boolean {
  return getStorageMode() === 'postgres';
}

/**
 * Check if we're in simulation mode.
 */
export function isSimulationMode(): boolean {
  return dbIsSimulationMode();
}

/**
 * Check if we're in test mode.
 */
export function isTestMode(): boolean {
  return getStorageMode() === 'memory';
}

/**
 * Save current state to JSON (simulation/test mode only).
 */
export async function saveSnapshot(): Promise<void> {
  await saveJsonSnapshot();
}

/**
 * Load state from JSON file (simulation/test mode only).
 */
export async function loadSnapshot(path: string): Promise<void> {
  await loadJsonSnapshot(path);
}

/**
 * Export state to a specific JSON file (simulation/test mode only).
 */
export async function exportState(path: string): Promise<void> {
  await exportJsonState(path);
}
