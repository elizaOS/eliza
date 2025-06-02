import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { PGliteClientManager } from '../src/pglite/manager';

export function setupMockedMigrations(): void {
  vi.spyOn(PGliteClientManager.prototype, 'runMigrations').mockImplementation(async function () {
    // 'this' refers to the instance of PGliteClientManager.
    const pgliteInstance = (this as any).client;

    console.log('[TEST MOCK HELPER] PGliteClientManager.runMigrations: Starting mocked migration.');

    try {
      const db = drizzle(pgliteInstance);

      const helperFilePath = fileURLToPath(import.meta.url);
      const testsDir = path.dirname(helperFilePath);
      const packageRoot = path.resolve(testsDir, '..');
      const migrationsPath = path.resolve(packageRoot, 'drizzle/migrations');

      console.log(
        `[TEST MOCK HELPER] PGliteClientManager.runMigrations: Resolved migrations path to: ${migrationsPath}`
      );

      await migrate(db, {
        migrationsFolder: migrationsPath,
        migrationsSchema: 'public',
      });

      console.log(
        '[TEST MOCK HELPER] PGliteClientManager.runMigrations: Mocked migration successful.'
      );
    } catch (error) {
      console.error(
        '[TEST MOCK HELPER] PGliteClientManager.runMigrations: Error during mocked migration:',
        error
      );
      throw error;
    }
  });
}
