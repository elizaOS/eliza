import { logger } from '@elizaos/core';
import { config } from 'dotenv';
import { PostgresConnectionManager } from './pg/manager';
import { SqliteClientManager } from './sqlite/manager';
import { resolveSqliteDir } from './utils';

config({ path: '../../.env' });

/**
 * Executes database migrations using either PostgreSQL or SQLite, depending on environment configuration.
 *
 * If the `POSTGRES_URL` environment variable is set, migrations are run against the specified PostgreSQL database. Otherwise, migrations are run using a SQLite database, with the data directory determined by the `SQLITE_DATA_DIR` environment variable or a project-specific default path.
 *
 * @remark This function terminates the Node.js process upon completion or failure.
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
    const elizaDbDir = resolveSqliteDir();

    if (!process.env.SQLITE_DATA_DIR) {
      logger.info(`SQLITE_DATA_DIR not set, defaulting to project path: ${elizaDbDir}`);
    } else {
      logger.info(`Using SQLITE_DATA_DIR: ${elizaDbDir}`);
    }

    logger.info('Using SQLite database at:', elizaDbDir);
    const clientManager = new SqliteClientManager(elizaDbDir);

    try {
      await clientManager.initialize();
      await clientManager.runMigrations();
      logger.success('SQLite migrations completed successfully');
      await clientManager.close();
      process.exit(0);
    } catch (error) {
      logger.error('SQLite migration failed:', error);
      try {
        await clientManager.close();
      } catch (closeError) {
        logger.error('Failed to close SQLite connection:', closeError);
      }
      process.exit(1);
    }
  }
}

runMigrations().catch((error) => {
  logger.error('Unhandled error in migrations:', error);
  process.exit(1);
});
