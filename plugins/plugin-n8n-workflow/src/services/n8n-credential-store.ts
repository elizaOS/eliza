import { type IAgentRuntime, logger, Service } from '@elizaos/core';
import { eq, and, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { credentialMappings } from '../db/schema';
import { N8N_CREDENTIAL_STORE_TYPE } from '../types/index';
import type { N8nCredentialStoreApi, CredentialMapping } from '../types/index';

/**
 * Default DB-backed credential store.
 * Maps (userId, credType) → n8n credential ID.
 *
 * On the cloud, a different plugin can register its own implementation
 * under the same service type — runtime.getService() returns the first registered.
 */
export class N8nCredentialStore extends Service implements N8nCredentialStoreApi {
  static override readonly serviceType = N8N_CREDENTIAL_STORE_TYPE;

  override capabilityDescription =
    'Stores n8n credential ID mappings per user and credential type, backed by PostgreSQL.';

  private getDb(): NodePgDatabase {
    const db = this.runtime.db;
    if (!db) {
      throw new Error('Database not available for N8nCredentialStore');
    }
    return db as NodePgDatabase;
  }

  static async start(runtime: IAgentRuntime): Promise<N8nCredentialStore> {
    logger.info(
      { src: 'plugin:n8n-workflow:service:credential-store' },
      'Starting N8n Credential Store...'
    );
    const service = new N8nCredentialStore(runtime);
    logger.info(
      { src: 'plugin:n8n-workflow:service:credential-store' },
      'N8n Credential Store started'
    );
    return service;
  }

  override async stop(): Promise<void> {
    logger.info(
      { src: 'plugin:n8n-workflow:service:credential-store' },
      'N8n Credential Store stopped'
    );
  }

  async get(userId: string, credType: string): Promise<string | null> {
    const db = this.getDb();
    const rows = await db
      .select()
      .from(credentialMappings)
      .where(and(eq(credentialMappings.userId, userId), eq(credentialMappings.credType, credType)))
      .limit(1);
    return rows[0]?.n8nCredentialId ?? null;
  }

  async set(userId: string, credType: string, n8nCredId: string): Promise<void> {
    const db = this.getDb();
    await db
      .insert(credentialMappings)
      .values({ userId, credType, n8nCredentialId: n8nCredId })
      .onConflictDoUpdate({
        target: [credentialMappings.userId, credentialMappings.credType],
        set: { n8nCredentialId: n8nCredId, updatedAt: sql`now()` },
      });
  }

  async listByUser(userId: string): Promise<CredentialMapping[]> {
    const db = this.getDb();
    const rows = await db
      .select({
        credType: credentialMappings.credType,
        n8nCredentialId: credentialMappings.n8nCredentialId,
      })
      .from(credentialMappings)
      .where(eq(credentialMappings.userId, userId));
    return rows;
  }

  async delete(userId: string, credType: string): Promise<void> {
    const db = this.getDb();
    await db
      .delete(credentialMappings)
      .where(and(eq(credentialMappings.userId, userId), eq(credentialMappings.credType, credType)));
  }
}
