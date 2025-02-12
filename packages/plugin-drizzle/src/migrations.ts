import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from 'url';
import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { logger } from "@elizaos/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(pgPool: Pool): Promise<void> {
    try {
        const db = drizzle(pgPool);
        await migrate(db, {
            migrationsFolder: path.resolve(__dirname, "../drizzle/migrations"),
        });
        logger.info("Migrations completed successfully!");
    } catch (error) {
        logger.error("Failed to run database migrations:", error);
        throw error;
    }
}
