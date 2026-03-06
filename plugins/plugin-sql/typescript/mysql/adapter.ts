/**
 * MySQL adapter entry point for plugin-sql.
 * Dynamically loaded when MYSQL_URL is detected.
 */

import type { IDatabaseAdapter, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { MySql2DatabaseAdapter } from "./mysql2/adapter";
import { MySql2ConnectionManager } from "./mysql2/manager";

const GLOBAL_SINGLETONS = Symbol.for("@elizaos/plugin-sql/mysql/global-singletons");

interface GlobalSingletons {
  mysqlConnectionManager?: MySql2ConnectionManager;
}

const globalSymbols = globalThis as typeof globalThis & Record<symbol, GlobalSingletons>;

if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}

const globalSingletons = globalSymbols[GLOBAL_SINGLETONS];

export function createMySqlAdapter(config: { mysqlUrl: string }, agentId: UUID): IDatabaseAdapter {
  if (!globalSingletons.mysqlConnectionManager) {
    logger.debug(
      {
        src: "plugin:sql:mysql",
        agentId: agentId.slice(0, 8),
      },
      "Creating MySQL connection manager"
    );
    globalSingletons.mysqlConnectionManager = new MySql2ConnectionManager(config.mysqlUrl);
  }

  return new MySql2DatabaseAdapter(agentId, globalSingletons.mysqlConnectionManager);
}
