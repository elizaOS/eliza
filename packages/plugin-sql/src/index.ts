import {
	type DatabaseAdapter,
	type IAgentRuntime,
	type IDatabaseAdapter,
	logger,
	type Plugin,
	type UUID,
} from "@elizaos/core";
import { PgliteDatabaseAdapter } from "./pg-lite/adapter";
import { PGliteClientManager } from "./pg-lite/manager";
import { PgDatabaseAdapter } from "./pg/adapter";
import { PostgresConnectionManager } from "./pg/manager";

/**
 * Declaration of a variable named pgLiteClientManager of type PGliteClientManager.
 */
let pgLiteClientManager: PGliteClientManager;

/**
 * Creates a database adapter based on the provided configuration.
 * If a postgresUrl is provided in the config, a PgDatabaseAdapter is initialized using the PostgresConnectionManager.
 * If no postgresUrl is provided, a PgliteDatabaseAdapter is initialized using PGliteClientManager with the dataDir from the config.
 * 
 * @param {object} config - The configuration object.
 * @param {string} [config.dataDir] - The directory where data is stored. Defaults to "./elizadb".
 * @param {string} [config.postgresUrl] - The URL for the PostgreSQL database.
 * @param {UUID} agentId - The unique identifier for the agent.
 * @returns {IDatabaseAdapter} The created database adapter.
 */
export function createDatabaseAdapter(
	config: {
		dataDir?: string;
		postgresUrl?: string;
	},
	agentId: UUID,
): IDatabaseAdapter {
	if (config.postgresUrl) {
		const manager = new PostgresConnectionManager(config.postgresUrl);
		return new PgDatabaseAdapter(agentId, manager);
	}

	const dataDir = config.dataDir ?? "./elizadb";

	if (!pgLiteClientManager) {
		pgLiteClientManager = new PGliteClientManager({ dataDir });
	}
	return new PgliteDatabaseAdapter(agentId, pgLiteClientManager);
}

/**
 * Drizzle plugin for database adapter using Drizzle ORM
 * 
 * @typedef {Object} Plugin
 * @property {string} name - The name of the plugin
 * @property {string} description - The description of the plugin
 * @property {Function} init - The initialization function for the plugin
 * @param {any} _ - Input parameter
 * @param {IAgentRuntime} runtime - The runtime environment for the agent
 */
const drizzlePlugin: Plugin = {
	name: "drizzle",
	description: "Database adapter plugin using Drizzle ORM",
	init: async (_, runtime: IAgentRuntime) => {
		const config = {
			dataDir: runtime.getSetting("PGLITE_DATA_DIR") ?? "./pglite",
			postgresUrl: runtime.getSetting("POSTGRES_URL"),
		};

		try {
			const db = createDatabaseAdapter(config, runtime.agentId);
			logger.success("Database connection established successfully");
			runtime.registerDatabaseAdapter(db);
		} catch (error) {
			logger.error("Failed to initialize database:", error);
			throw error;
		}
	},
};

export default drizzlePlugin;
