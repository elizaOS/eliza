import { Adapter, logger, IAgentRuntime, Plugin, IDatabaseAdapter, IDatabaseCacheAdapter } from '@elizaos/core';
import { PgDatabaseAdapter } from './pg/adapter';
import { PgliteDatabaseAdapter } from './pg-lite/adapter';
import { PGliteClientManager } from './pg-lite/manager';
import { PostgresConnectionManager } from './pg/manager';

let pgLiteClientManager: PGliteClientManager;

export function createDatabaseAdapter(config: any): IDatabaseAdapter & IDatabaseCacheAdapter {
  if (config.dataDir) {
    if (!pgLiteClientManager) {
      pgLiteClientManager = new PGliteClientManager({ dataDir: config.dataDir });
    }
    return new PgliteDatabaseAdapter(pgLiteClientManager);
  } else if (config.postgresUrl) {
    const manager = new PostgresConnectionManager(config.postgresUrl);
    return new PgDatabaseAdapter(manager);
  }
  throw new Error("No valid database configuration provided");
}

const drizzleDatabaseAdapter: Adapter = {
  init: async (runtime: IAgentRuntime) => {
    const config = {
      dataDir: runtime.getSetting("PGLITE_DATA_DIR"),
      postgresUrl: runtime.getSetting("POSTGRES_URL"),
    };

    try {
      const db = createDatabaseAdapter(config);
      await db.init();
      logger.success("Database connection established successfully");
      return db;
    } catch (error) {
      logger.error("Failed to initialize database:", error);
      throw error;
    }
  }
};

const drizzlePlugin: Plugin = {
  name: "drizzle",
  description: "Database adapter plugin using Drizzle ORM",
  adapters: [drizzleDatabaseAdapter],
};

export default drizzlePlugin;
