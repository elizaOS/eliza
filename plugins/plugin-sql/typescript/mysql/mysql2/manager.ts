import { logger, type UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import { join } from "node:path";

export class MySql2ConnectionManager {
  private pool: Pool;
  private db: MySql2Database;

  constructor(connectionString: string) {
    this.pool = mysql.createPool({
      uri: connectionString,
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      connectTimeout: 5000,
    });

    this.db = drizzle(this.pool, { casing: "snake_case" });
  }

  public getDatabase(): MySql2Database {
    return this.db;
  }

  public getConnection(): Pool {
    return this.pool;
  }

  public async getClient(): Promise<PoolConnection> {
    return this.pool.getConnection();
  }

  public async testConnection(): Promise<boolean> {
    let connection: PoolConnection | null = null;
    try {
      connection = await this.pool.getConnection();
      await connection.query("SELECT 1");
      return true;
    } catch (error) {
      logger.error(
        {
          src: "plugin:mysql",
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to connect to the MySQL database"
      );
      return false;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  /**
   * Runs Drizzle migrations from the drizzle/migrations directory.
   */
  public async runMigrations(): Promise<void> {
    try {
      const migrationsFolder = join(__dirname, "..", "drizzle", "migrations");
      await migrate(this.db, { migrationsFolder });
      logger.info({ src: "plugin:mysql" }, "Database migrations completed");
    } catch (error) {
      logger.error(
        {
          src: "plugin:mysql",
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to run database migrations"
      );
      throw error;
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
