import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "../../.env" });

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/schema/index.ts",
	out: "./drizzle/migrations",
	migrations: {
		table: "__drizzle_migrations",
		schema: "public",
		prefix: "timestamp",
	},
	dbCredentials: {
		url: process.env.POSTGRES_URL || "file://../../pglite",
	},
	breakpoints: true,
});
