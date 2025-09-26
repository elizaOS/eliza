import { sql } from 'drizzle-orm';
import { logger } from '@elizaos/core';
import type { DrizzleDB } from './types';

export class ExtensionManager {
  constructor(private db: DrizzleDB) {}

  async installRequiredExtensions(extensions: string[]): Promise<void> {
    for (const extension of extensions) {
      try {
        await this.db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS "${extension}"`));
        logger.debug(`[RuntimeMigrator] Extension installed: ${extension}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`[RuntimeMigrator] Could not install extension ${extension}: ${errorMessage}`);
        // Some extensions might not be available or already installed
        // This shouldn't stop the migration process
      }
    }
  }
}
