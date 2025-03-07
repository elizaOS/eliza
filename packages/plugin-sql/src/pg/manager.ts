import pkg, { type Pool as PgPool } from "pg";
import type { IDatabaseClientManager } from "../types";
import { logger } from "@elizaos/core";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";

const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class PostgresConnectionManager
	implements IDatabaseClientManager<PgPool>
{
	private pool: PgPool;
	private isShuttingDown = false;
	private readonly connectionTimeout: number = 5000;

	constructor(connectionString: string) {
		const defaultConfig = {
			max: 20,
			idleTimeoutMillis: 30000,
			connectionTimeoutMillis: this.connectionTimeout,
		};

		this.pool = new Pool({
			...defaultConfig,
			connectionString,
		});

		this.pool.on("error", (err) => {
			logger.error("Unexpected pool error", err);
			this.handlePoolError(err);
		});

		this.setupPoolErrorHandling();
		this.testConnection();
	}

	private async handlePoolError(error: Error) {
		logger.error("Pool error occurred, attempting to reconnect", {
			error: error.message,
		});

		try {
			await this.pool.end();

			this.pool = new Pool({
				...this.pool.options,
				connectionTimeoutMillis: this.connectionTimeout,
			});

			await this.testConnection();
			logger.success("Pool reconnection successful");
		} catch (reconnectError) {
			logger.error("Failed to reconnect pool", {
				error:
					reconnectError instanceof Error
						? reconnectError.message
						: String(reconnectError),
			});
			throw reconnectError;
		}
	}

	async testConnection(): Promise<boolean> {
		let client;
		try {
			client = await this.pool.connect();
			const result = await client.query("SELECT NOW()");
			logger.success("Database connection test successful:", result.rows[0]);
			return true;
		} catch (error) {
			logger.error("Database connection test failed:", error);
			throw new Error(
				`Failed to connect to database: ${(error as Error).message}`,
			);
		} finally {
			if (client) client.release();
		}
	}

	private setupPoolErrorHandling() {
		process.on("SIGINT", async () => {
			await this.cleanup();
			process.exit(0);
		});

		process.on("SIGTERM", async () => {
			await this.cleanup();
			process.exit(0);
		});

		process.on("beforeExit", async () => {
			await this.cleanup();
		});
	}

	public getConnection(): PgPool {
		if (this.isShuttingDown) {
			throw new Error("Connection manager is shutting down");
		}

		try {
			return this.pool;
		} catch (error) {
			logger.error("Failed to get connection from pool:", error);
			throw error;
		}
	}

	public async getClient(): Promise<pkg.PoolClient> {
		try {
			return await this.pool.connect();
		} catch (error) {
			logger.error("Failed to acquire a database client:", error);
			throw error;
		}
	}

	public async initialize(): Promise<void> {
		try {
			await this.testConnection();
			logger.info("PostgreSQL connection manager initialized successfully");
		} catch (error) {
			logger.error("Failed to initialize connection manager:", error);
			throw error;
		}
	}

	public async close(): Promise<void> {
		await this.cleanup();
	}

	async cleanup(): Promise<void> {
		try {
			await this.pool.end();
			logger.info("Database pool closed");
		} catch (error) {
			logger.error("Error closing database pool:", error);
		}
	}

	async runMigrations(): Promise<void> {
		try {
			const db = drizzle(this.pool);
			await migrate(db, {
				migrationsFolder: path.resolve(__dirname, "../drizzle/migrations"),
			});
			logger.info("Migrations completed successfully!");
		} catch (error) {
			logger.error("Failed to run database migrations:", error);
			// throw error;
		}
	}
}
