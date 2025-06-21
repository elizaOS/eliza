import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { logger } from '@elizaos/core';

export class PostgresConnectionManager {
  private pool: Pool;
  private db: NodePgDatabase;

  constructor(connectionString: string) {
    // Optimized pool configuration for better performance
    const poolConfig: PoolConfig = {
      connectionString,
      // Connection pool settings
      max: 20, // Maximum number of clients in the pool
      min: 2, // Minimum number of clients in the pool  
      idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
      connectionTimeoutMillis: 2000, // Return error after 2 seconds if unable to get connection
      // Query settings
      query_timeout: 30000, // Cancel query after 30 seconds
      statement_timeout: 30000, // Cancel statement after 30 seconds
      // Connection settings
      keepAlive: true, // Enable TCP keep-alive
      keepAliveInitialDelayMillis: 10000, // Initial delay for keep-alive
    };

    this.pool = new Pool(poolConfig);
    this.db = drizzle(this.pool as any);

    // Set up pool event handlers for monitoring
    this.pool.on('connect', () => {
      logger.debug('PostgreSQL pool: New client connected');
    });
    
    this.pool.on('acquire', () => {
      logger.debug('PostgreSQL pool: Client acquired from pool');
    });
    
    this.pool.on('release', () => {
      logger.debug('PostgreSQL pool: Client released back to pool');
    });
    
    this.pool.on('error', (err) => {
      logger.error('PostgreSQL pool: Unexpected error on idle client', err);
    });
  }

  public getDatabase(): NodePgDatabase {
    return this.db;
  }

  public getConnection(): Pool {
    return this.pool;
  }

  public async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  public async testConnection(): Promise<boolean> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query('SELECT 1');
      return true;
    } catch (error) {
      logger.error('Failed to connect to the database:', error);
      return false;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Get pool statistics for monitoring and optimization
   */
  public getPoolStats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
      maxConnections: this.pool.options.max || 10,
      minConnections: this.pool.options.min || 0,
    };
  }

  /**
   * Log current pool status for debugging
   */
  public logPoolStatus(): void {
    const stats = this.getPoolStats();
    logger.info('PostgreSQL Pool Status:', {
      total: stats.totalCount,
      idle: stats.idleCount,
      waiting: stats.waitingCount,
      max: stats.maxConnections,
      min: stats.minConnections,
      utilization: `${Math.round((stats.totalCount / stats.maxConnections) * 100)}%`
    });
  }

  /**
   * Closes the connection pool.
   * @returns {Promise<void>}
   * @memberof PostgresConnectionManager
   */
  public async close(): Promise<void> {
    logger.info('Closing PostgreSQL connection pool...');
    this.logPoolStatus();
    await this.pool.end();
  }
}
