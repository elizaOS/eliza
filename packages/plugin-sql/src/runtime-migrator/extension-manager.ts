import { sql } from 'drizzle-orm';
import { logger } from '@elizaos/core';
import type { DrizzleDB } from './types';

export class ExtensionManager {
  constructor(private db: DrizzleDB) {}

  async installRequiredExtensions(extensions: string[]): Promise<void> {
    for (const extension of extensions) {
      try {
        // Validate extension name to prevent SQL injection
        // Extension names should only contain alphanumeric characters, underscores, and hyphens
        if (!/^[a-zA-Z0-9_-]+$/.test(extension)) {
          logger.warn(
            { src: 'plugin:sql', extension },
            'Invalid extension name - contains invalid characters'
          );
          continue;
        }

        // Use sql.identifier for safe escaping of SQL identifiers
        await this.db.execute(sql`CREATE EXTENSION IF NOT EXISTS ${sql.identifier(extension)}`);
        logger.debug({ src: 'plugin:sql', extension }, 'Extension installed');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(
          { src: 'plugin:sql', extension, error: errorMessage },
          'Could not install extension'
        );
        // Some extensions might not be available or already installed
        // This shouldn't stop the migration process
      }
    }
  }
}
