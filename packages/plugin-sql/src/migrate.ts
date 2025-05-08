import { logger, stringToUuid } from '@elizaos/core';
import { config } from 'dotenv';
import { PGliteClientManager } from './pglite/manager.js';
import { PostgresConnectionManager } from './pg/manager.js';
import os from 'node:os';
import path from 'node:path';

config({ path: '../../.env' });

/**
 * Runs the database migrations based on the environment variable POSTGRES_URL.
 * If the POSTGRES_URL is provided, it indicates the use of a PostgreSQL database and the corresponding migration logic needs to be implemented.
 * If POSTGRES_URL is not provided, it uses a PGlite database and runs the migrations on it.
 * @returns {Promise<void>} A promise that resolves once the migrations are completed successfully or rejects if an error occurs.
 */
async function runMigrations() {
  if (process.env.POSTGRES_URL) {
    try {
      const connectionManager = new PostgresConnectionManager(process.env.POSTGRES_URL);
      await connectionManager.initialize();
      await connectionManager.runMigrations();
      // await connectionManager.close();
      logger.success('PostgreSQL migrations completed successfully');
      process.exit(0);
    } catch (error) {
      logger.warn('PostgreSQL migration failed:', error);
      process.exit(1);
    }
  } else {
    let elizaDbDir = process.env.PGLITE_DATA_DIR;
    if (!elizaDbDir) {
      const homeDir = os.homedir();
      const elizaDir = path.join(homeDir, '.eliza');
      // Construct project-specific path
      elizaDbDir = path.join(elizaDir, 'projects', stringToUuid(process.cwd()), 'pglite');
      logger.info(`PGLITE_DATA_DIR not set, defaulting to project-specific path: ${elizaDbDir}`);
    } else {
      logger.info(`Using PGLITE_DATA_DIR: ${elizaDbDir}`);
    }

    logger.info('Using PGlite database at:', elizaDbDir);
    const clientManager = new PGliteClientManager({
      dataDir: elizaDbDir,
    });

    try {
      await clientManager.initialize();
      await clientManager.runMigrations();
      logger.success('PGlite migrations completed successfully');
      await clientManager.close();
      process.exit(0);
    } catch (error) {
      logger.error('PGlite migration failed:', error);
      try {
        await clientManager.close();
      } catch (closeError) {
        logger.error('Failed to close PGlite connection:', closeError);
      }
      process.exit(1);
    }
  }
}

runMigrations().catch((error) => {
  logger.error('Unhandled error in migrations:', error);
  process.exit(1);
});
