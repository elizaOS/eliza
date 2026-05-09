import { type IAgentRuntime, logger, Service } from '@elizaos/core';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { credentialMappings } from '../db/schema';
import type { CredentialMapping, WorkflowCredentialStoreApi } from '../types/index';
import { WORKFLOW_CREDENTIAL_STORE_TYPE } from '../types/index';

/**
 * Default DB-backed credential store.
 * Maps (userId, credType) → workflows credential ID.
 *
 * On the cloud, a different plugin can register its own implementation
 * under the same service type — runtime.getService() returns the first registered.
 */
export class WorkflowCredentialStore extends Service implements WorkflowCredentialStoreApi {
  static override readonly serviceType = WORKFLOW_CREDENTIAL_STORE_TYPE;

  override capabilityDescription =
    'Stores workflows credential ID mappings per user and credential type, backed by PostgreSQL.';

  private getDb(): NodePgDatabase {
    const db = this.runtime.db;
    if (!db) {
      throw new Error('Database not available for WorkflowCredentialStore');
    }
    return db as NodePgDatabase;
  }

  static async start(runtime: IAgentRuntime): Promise<WorkflowCredentialStore> {
    logger.info(
      { src: 'plugin:workflow:service:credential-store' },
      'Starting Workflow Credential Store...'
    );
    const service = new WorkflowCredentialStore(runtime);
    logger.info(
      { src: 'plugin:workflow:service:credential-store' },
      'Workflow Credential Store started'
    );
    return service;
  }

  override async stop(): Promise<void> {
    logger.info(
      { src: 'plugin:workflow:service:credential-store' },
      'Workflow Credential Store stopped'
    );
  }

  async get(userId: string, credType: string): Promise<string | null> {
    const db = this.getDb();
    const rows = await db
      .select()
      .from(credentialMappings)
      .where(and(eq(credentialMappings.userId, userId), eq(credentialMappings.credType, credType)))
      .limit(1);
    return rows[0]?.workflowCredentialId ?? null;
  }

  async set(userId: string, credType: string, workflowCredId: string): Promise<void> {
    const db = this.getDb();
    await db
      .insert(credentialMappings)
      .values({ userId, credType, workflowCredentialId: workflowCredId })
      .onConflictDoUpdate({
        target: [credentialMappings.userId, credentialMappings.credType],
        set: { workflowCredentialId: workflowCredId, updatedAt: sql`now()` },
      });
  }

  async listByUser(userId: string): Promise<CredentialMapping[]> {
    const db = this.getDb();
    const rows = await db
      .select({
        credType: credentialMappings.credType,
        workflowCredentialId: credentialMappings.workflowCredentialId,
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
