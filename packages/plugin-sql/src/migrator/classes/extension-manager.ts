import { sql } from 'drizzle-orm';
import { logger } from '@elizaos/core';
import type { DrizzleDB } from '../types';
import { extractErrorDetails } from '../utils';

export class ExtensionManager {
  constructor(private db: DrizzleDB) {}

  async installRequiredExtensions(requiredExtensions: string[]): Promise<void> {
    for (const extension of requiredExtensions) {
      try {
        await this.db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS "${extension}"`));
      } catch (error) {
        const errorDetails = extractErrorDetails(error);
        logger.warn(`Could not install extension ${extension}: ${errorDetails.message}`);
        if (errorDetails.stack) {
          logger.debug(
            `[CUSTOM MIGRATOR] Extension installation stack trace: ${errorDetails.stack}`
          );
        }
      }
    }
  }
}
