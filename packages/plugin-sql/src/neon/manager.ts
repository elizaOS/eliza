import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { logger, type UUID, validateUuid } from '@elizaos/core';
import ws from 'ws';

/**
 * Neon Serverless Connection Manager
 *
 * Uses @neondatabase/serverless for optimal performance with Neon databases.
 * Benefits over standard pg driver:
 * - Connection pooling handled at the edge (Neon's proxy)
 * - WebSocket-based connections for serverless environments
 * - Better cold start performance
 * - No pool.end() issues (connections are ephemeral)
 */
export class NeonConnectionManager {
  private pool: Pool;
  private db: NeonDatabase;
  private _closed = false;
  private readonly connectionString: string;
  private readonly rlsServerId?: string;

  constructor(connectionString: string, rlsServerId?: string) {
    this.connectionString = connectionString;
    this.rlsServerId = rlsServerId;

    // Configure WebSocket for Node.js environment
    // In browser/edge environments, native WebSocket is used automatically
    if (typeof WebSocket === 'undefined') {
      neonConfig.webSocketConstructor = ws;
    }

    // Neon serverless pool - connection pooling is handled by Neon's proxy
    // so we don't need the same pool configuration as node-postgres
    this.pool = new Pool({
      connectionString,
    });

    this.db = drizzle(this.pool, { casing: 'snake_case' });
  }

  public getDatabase(): NeonDatabase {
    return this.db;
  }

  public getConnection(): Pool {
    return this.pool;
  }

  public async testConnection(): Promise<boolean> {
    try {
      // Neon serverless uses a simpler connection model
      await this.db.execute(sql`SELECT 1`);
      return true;
    } catch (error) {
      logger.error(
        { src: 'plugin:sql:neon', error: error instanceof Error ? error.message : String(error) },
        'Failed to connect to Neon database'
      );
      return false;
    }
  }

  /**
   * Execute a query with full isolation context (Server RLS + Entity RLS).
   * Uses set_config() with parameterized queries for proper SQL injection protection.
   */
  public async withIsolationContext<T>(
    entityId: UUID | null,
    callback: (tx: NeonDatabase) => Promise<T>
  ): Promise<T> {
    const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';

    return await this.db.transaction(async (tx) => {
      if (dataIsolationEnabled) {
        // Set server context (Server RLS) using parameterized set_config()
        if (this.rlsServerId) {
          await tx.execute(sql`SELECT set_config('app.server_id', ${this.rlsServerId}, true)`);
        }

        // Set entity context (Entity RLS) using parameterized set_config()
        if (entityId) {
          if (!validateUuid(entityId)) {
            throw new Error(`Invalid UUID format for entity context: ${entityId}`);
          }
          await tx.execute(sql`SELECT set_config('app.entity_id', ${entityId}, true)`);
        }
      }

      return await callback(tx as unknown as NeonDatabase);
    });
  }

  /**
   * Closes the connection pool.
   * Note: With Neon serverless, this is less critical as connections
   * are managed by Neon's proxy, but we still track the closed state.
   */
  public async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await this.pool.end();
  }

  /**
   * Check if the connection pool has been closed.
   */
  public isClosed(): boolean {
    return this._closed;
  }

  /**
   * Get the connection string for this manager.
   */
  public getConnectionString(): string {
    return this.connectionString;
  }

  /**
   * Get the RLS server ID for this manager.
   */
  public getRlsServerId(): string | undefined {
    return this.rlsServerId;
  }
}
