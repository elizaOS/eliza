import { drizzle } from "drizzle-orm/pglite";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import { config } from "dotenv";

config({ path: "../../.env" });

/**
 * Runs the database migrations based on the environment variable POSTGRES_URL.
 * If the POSTGRES_URL is provided, it indicates the use of a PostgreSQL database and the corresponding migration logic needs to be implemented.
 * If POSTGRES_URL is not provided, it uses a PGlite database and runs the migrations on it.
 * @returns {Promise<void>} A promise that resolves once the migrations are completed successfully or rejects if an error occurs.
 */
async function runMigrations() {
	if (process.env.POSTGRES_URL) {
		console.log("Using PostgreSQL database");
		// You'll need to add PostgreSQL migration logic here if needed
		return;
	}

	console.log("Using PGlite database");
	const client = new PGlite("file://../../pglite");
	const db = drizzle(client);

	try {
		await pgliteMigrate(db, {
			migrationsFolder: "./drizzle/migrations",
		});
		console.log("Migrations completed successfully");
	} catch (error) {
		console.error("Migration failed:", error);
		process.exit(1);
	}
}

runMigrations().catch(console.error);
