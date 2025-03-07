import { drizzle } from "drizzle-orm/pglite";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import { config } from "dotenv";

config({ path: "../../.env" });

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
