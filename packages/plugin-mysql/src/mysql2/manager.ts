import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';
import type { IDatabaseClientManager } from '../types';

/**
 * Manages connections to a MySQL database using a connection pool.
 * Implements IDatabaseClientManager interface.
 */
export class MySql2ConnectionManager implements IDatabaseClientManager<mysql.Pool> {
  private pool: mysql.Pool;
  private readonly connectionString: string;
  private isShuttingDown = false;
  private readonly connectionTimeout: number = 5000;

  /**
   * Constructor for creating a connection pool.
   * @param {string} connectionString - The connection string used to connect to the database.
   */
  constructor(connectionString: string) {
    this.connectionString = connectionString;
    // Create a pool using mysql2's createPool function
    this.pool = mysql.createPool(this.connectionString);

    // mysql2 has a slightly different event system compared to node-postgres
    // Here we listen for errors on connections from the pool
    this.pool.on('connection', (connection) => {
      connection.on('error', (err) => {
        logger.error('Unexpected connection error', err);
        this.handlePoolError(err);
      });
    });

    this.setupPoolErrorHandling();
    this.testConnection();
  }

  /**
   * Handles a pool error by attempting to reconnect the pool.
   *
   * @param {Error} error The error that occurred in the pool.
   * @throws {Error} If failed to reconnect the pool.
   */
  private async handlePoolError(error: Error) {
    logger.error('Pool error occurred, attempting to reconnect', {
      error: error.message,
    });

    try {
      await this.pool.end();

      // Create a new pool using the original connection string
      this.pool = mysql.createPool({
        uri: this.connectionString,
        connectTimeout: this.connectionTimeout,
        waitForConnections: true,
        connectionLimit: 20,
        queueLimit: 0,
      });

      await this.testConnection();
      logger.success('Pool reconnection successful');
    } catch (reconnectError) {
      logger.error('Failed to reconnect pool', {
        error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
      });
      throw reconnectError;
    }
  }

  /**
   * Asynchronously tests the database connection by executing a query to get the current timestamp.
   *
   * @returns {Promise<boolean>} - A Promise that resolves to true if the database connection test is successful.
   */
  async testConnection(): Promise<boolean> {
    try {
      const [rows] = await this.pool.query('SELECT NOW()');
      logger.success('Database connection test successful:', rows[0]);
      return true;
    } catch (error) {
      logger.error('Database connection test failed:', error);
      throw new Error(`Failed to connect to database: ${(error as Error).message}`);
    }
  }

  /**
   * Sets up event listeners to handle pool cleanup on SIGINT, SIGTERM, and beforeExit events.
   */
  private setupPoolErrorHandling() {
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('beforeExit', async () => {
      await this.cleanup();
    });
  }

  /**
   * Get the connection pool.
   * @returns {mysql.Pool} The connection pool
   * @throws {Error} If the connection manager is shutting down or an error occurs when trying to get the connection from the pool
   */
  public getConnection(): mysql.Pool {
    if (this.isShuttingDown) {
      throw new Error('Connection manager is shutting down');
    }

    try {
      return this.pool;
    } catch (error) {
      logger.error('Failed to get connection from pool:', error);
      throw error;
    }
  }

  /**
   * Asynchronously acquires a database client from the connection pool.
   *
   * @returns {Promise<mysql.PoolConnection>} A Promise that resolves with the acquired database client.
   * @throws {Error} If an error occurs while acquiring the database client.
   */
  public async getClient(): Promise<mysql.PoolConnection> {
    try {
      return await this.pool.getConnection();
    } catch (error) {
      logger.error('Failed to acquire a database client:', error);
      throw error;
    }
  }

  /**
   * Initializes the MySQL connection manager by testing the connection and logging the result.
   *
   * @returns {Promise<void>} A Promise that resolves once the manager is successfully initialized
   * @throws {Error} If there is an error initializing the connection manager
   */
  public async initialize(): Promise<void> {
    try {
      await this.testConnection();
      logger.debug('MySQL connection manager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize connection manager:', error);
      throw error;
    }
  }

  /**
   * Asynchronously close the current process by executing a cleanup function.
   * @returns A promise that resolves once the cleanup is complete.
   */
  public async close(): Promise<void> {
    await this.cleanup();
  }

  /**
   * Cleans up and closes the database pool.
   * @returns {Promise<void>} A Promise that resolves when the database pool is closed.
   */
  async cleanup(): Promise<void> {
    try {
      await this.pool.end();
      logger.info('Database pool closed');
    } catch (error) {
      logger.error('Error closing database pool:', error);
    }
  }

  /**
   * Asynchronously runs database migrations using the Drizzle library.
   *
   * Drizzle will first check if the migrations are already applied.
   * If there is a diff between database schema and migrations, it will apply the migrations.
   * If they are already applied, it will skip them.
   *
   * @returns {Promise<void>} A Promise that resolves once the migrations are completed successfully.
   */
  async runMigrations(): Promise<void> {
    let connection: mysql.Connection | null = null;
    try {
      // Get a dedicated connection for migrations using the original connection string
      connection = await mysql.createConnection(this.connectionString);

      const db = drizzle(connection);

      // --- Find the package root dynamically ---
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const packageRoot = findPackageRoot(__dirname);
      const migrationsPath = path.join(packageRoot, 'drizzle', 'migrations');
      logger.debug(`Resolved migrations path: ${migrationsPath}`); // Add logging
      // --- End find package root ---

      await migrate(db, {
        migrationsFolder: migrationsPath, // Use the dynamically found path
      });

      // Close the connection after migration is complete
      if (connection) {
        await connection.end();
      }
    } catch (error) {
      logger.error('Failed to run database migrations (mysql):', error);
    }
  }
}

/**
 * Finds the root directory of the package containing the given directory.
 * Walks up the directory tree looking for package.json.
 * @param startDir The directory to start searching from.
 * @returns The path to the package root directory.
 * @throws Error if package.json is not found.
 */
function findPackageRoot(startDir: string): string {
  let currentDir = startDir;
  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    try {
      // Check if package.json exists and is a file
      if (fs.statSync(packageJsonPath).isFile()) {
        // Make sure the package name is correct (optional but safer)
        // const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        // if (pkg.name === '@elizaos/plugin-mysql') { // Or whatever the actual package name is
        return currentDir;
        // }
      }
    } catch (err) {
      // Ignore errors (e.g., permission denied, file not found)
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached the filesystem root without finding the correct package.json
      throw new Error(
        `Could not find package root containing package.json starting from ${startDir}`
      );
    }
    currentDir = parentDir;
  }
}
