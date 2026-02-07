/**
 * Database Connection
 * PostgreSQL connection using Drizzle ORM
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

/**
 * Get database configuration from environment
 */
export function getDatabaseConfig(): DatabaseConfig {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    return {
      host: url.hostname,
      port: parseInt(url.port || '5432', 10),
      database: url.pathname.slice(1),
      user: url.username,
      password: url.password,
      ssl: url.searchParams.get('sslmode') === 'require',
    };
  }
  
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'eliza_dungeons',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    ssl: process.env.DB_SSL === 'true',
  };
}

/**
 * Initialize database connection
 */
export async function initializeDatabase(config?: DatabaseConfig): Promise<void> {
  if (db) {
    console.log('Database already initialized');
    return;
  }
  
  const dbConfig = config || getDatabaseConfig();
  
  pool = new Pool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  
  // Test connection
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
  
  db = drizzle(pool, { schema });
  
  console.log(`Database connected to ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
}

/**
 * Get database instance
 */
export function getDatabase(): ReturnType<typeof drizzle<typeof schema>> {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

/**
 * Get pool for raw queries
 */
export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return pool;
}

/**
 * Close database connection
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
    console.log('Database connection closed');
  }
}

/**
 * Execute a transaction
 */
export async function withTransaction<T>(
  callback: (tx: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>
): Promise<T> {
  const database = getDatabase();
  
  // Drizzle's transaction API
  return database.transaction(async (tx) => {
    return callback(tx as unknown as ReturnType<typeof drizzle<typeof schema>>);
  });
}

/**
 * Check if database is connected
 */
export function isDatabaseConnected(): boolean {
  return db !== null && pool !== null;
}

// Re-export schema for convenience
export { schema };
