import { PostgresConnectionManager } from "./pg/manager.js";
import { PGliteClientManager } from "./pg-lite/manager.js";
import { logger } from "@elizaos/core";
import { config } from "dotenv";

config({ path: "../../.env" });

async function runMigrations() {
	if (process.env.POSTGRES_URL) {
		try {
			const connectionManager = new PostgresConnectionManager(
				process.env.POSTGRES_URL,
			);
			await connectionManager.initialize();
			await connectionManager.runMigrations();
			await connectionManager.close();
			logger.success("PostgreSQL migrations completed successfully");
			process.exit(0);
		} catch (error) {
			logger.warn("PostgreSQL migration failed:", error);
			process.exit(1);
		}
	} else {
		logger.info("Using PGlite database");
		const clientManager = new PGliteClientManager({
			dataDir: "../../pglite",
		});

		try {
			await clientManager.initialize();
			await clientManager.runMigrations();
			logger.success("PGlite migrations completed successfully");
			await clientManager.close();
			process.exit(0);
		} catch (error) {
			logger.error("PGlite migration failed:", error);
			try {
				await clientManager.close();
			} catch (closeError) {
				logger.error("Failed to close PGlite connection:", closeError);
			}
			process.exit(1);
		}
	}
}

runMigrations().catch((error) => {
	logger.error("Unhandled error in migrations:", error);
	process.exit(1);
});
