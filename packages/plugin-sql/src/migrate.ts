import { PostgresConnectionManager } from "./pg/manager.js";
import { PGliteClientManager } from "./pg-lite/manager.js";
import { config } from "dotenv";

config({ path: "../../.env" });

async function runMigrations() {
	if (process.env.POSTGRES_URL) {
		console.log("Using PostgreSQL database");
		try {
			const connectionManager = new PostgresConnectionManager(
				process.env.POSTGRES_URL,
			);
			await connectionManager.initialize();
			await connectionManager.runMigrations();
			await connectionManager.close();
			console.log("PostgreSQL migrations completed successfully");
			process.exit(0);
		} catch (error) {
			console.error("PostgreSQL migration failed:", error);
			process.exit(1);
		}
	} else {
		console.log("Using PGlite database");
		const clientManager = new PGliteClientManager({
			dataDir: "../../pglite",
		});

		try {
			await clientManager.initialize();
			await clientManager.runMigrations();
			console.log("PGlite migrations completed successfully");
			await clientManager.close();
			process.exit(0);
		} catch (error) {
			console.error("PGlite migration failed:", error);
			try {
				await clientManager.close();
			} catch (closeError) {
				console.error("Failed to close PGlite connection:", closeError);
			}
			process.exit(1);
		}
	}
}

runMigrations().catch((error) => {
	console.error("Unhandled error in migrations:", error);
	process.exit(1);
});
