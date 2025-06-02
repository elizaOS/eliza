import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { SqliteClientManager } from '../src/sqlite/manager';

export function setupMockedMigrations(): void {
  vi.spyOn(SqliteClientManager.prototype, 'runMigrations').mockImplementation(async function () {
    // 'this' refers to the instance of SqliteClientManager.
    const sqliteInstance = (this as any).client;

    console.log('[TEST MOCK HELPER] SqliteClientManager.runMigrations: Starting mocked migration.');

    try {
      const db = drizzle(sqliteInstance);

      const helperFilePath = fileURLToPath(import.meta.url);
      const testsDir = path.dirname(helperFilePath);
      const packageRoot = path.resolve(testsDir, '..');
      const migrationsPath = path.resolve(packageRoot, 'drizzle/migrations');

      console.log(
        `[TEST MOCK HELPER] SqliteClientManager.runMigrations: Resolved migrations path to: ${migrationsPath}`
      );

      await migrate(db, {
        migrationsFolder: migrationsPath,
        migrationsSchema: 'public',
      });

      console.log(
        '[TEST MOCK HELPER] SqliteClientManager.runMigrations: Mocked migration successful.'
      );
    } catch (error) {
      console.error(
        '[TEST MOCK HELPER] SqliteClientManager.runMigrations: Error during mocked migration:',
        error
      );
      throw error;
    }
  });
}
