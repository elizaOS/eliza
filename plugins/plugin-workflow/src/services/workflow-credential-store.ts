/**
 * Agent-scoped workflow credential mappings and connector-disconnect eviction.
 * A user may connect the same credential type to several Eliza agents without
 * any runtime observing or deleting another agent's mapping.
 */
import { ElizaError, type IAgentRuntime, logger, Service } from '@elizaos/core';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { credentialMappings, LEGACY_UNSCOPED_WORKFLOW_AGENT_ID } from '../db/schema';
import type {
  ConnectorDisconnectedPayload,
  CredentialMapping,
  WorkflowCredentialStoreApi,
} from '../types/index';
import { CONNECTOR_DISCONNECTED_EVENT, WORKFLOW_CREDENTIAL_STORE_TYPE } from '../types/index';

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

  /**
   * Bound handler for the runtime `connector_disconnected` event. Stored on the
   * instance so `stop()` can unregister exactly the same reference that
   * `start()` registered (referential equality matters for unregisterEvent).
   */
  private readonly connectorDisconnectedHandler = async (
    payload: ConnectorDisconnectedPayload
  ): Promise<void> => {
    if (!payload.userId || !Array.isArray(payload.credTypes)) {
      return;
    }
    if (payload.credTypes.length === 0) {
      return;
    }
    const results = await Promise.allSettled(
      payload.credTypes.map((credType) => this.delete(payload.userId, credType))
    );
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [{ credType: payload.credTypes[index] ?? 'unknown', cause: result.reason }]
        : []
    );
    if (failures.length === 0) return;

    const error = new ElizaError('Workflow credential eviction failed', {
      code: 'WORKFLOW_CREDENTIAL_EVICTION_FAILED',
      cause: failures[0]?.cause,
      context: {
        connectorName: payload.connectorName,
        failedCredentialTypes: failures.map((failure) => failure.credType),
      },
      severity: 'ephemeral',
    });
    this.runtime.reportError('WorkflowCredentialStore.connectorDisconnected', error, {
      connectorName: payload.connectorName,
    });
    throw error;
  };

  private getDb(): NodePgDatabase {
    const db = this.runtime.db;
    if (!db) {
      throw new Error('Database not available for WorkflowCredentialStore');
    }
    return db as NodePgDatabase;
  }

  private get tenantAgentId(): string {
    const agentId = this.runtime.agentId;
    if (!agentId || agentId === LEGACY_UNSCOPED_WORKFLOW_AGENT_ID) {
      throw new ElizaError('Workflow credential mappings require a live agent tenant id', {
        code: 'WORKFLOW_CREDENTIAL_AGENT_TENANT_REQUIRED',
        context: { agentId },
      });
    }
    return agentId;
  }

  static async start(runtime: IAgentRuntime): Promise<WorkflowCredentialStore> {
    logger.info(
      { src: 'plugin:workflow:service:credential-store' },
      'Starting Workflow Credential Store...'
    );
    const service = new WorkflowCredentialStore(runtime);
    runtime.registerEvent<ConnectorDisconnectedPayload>(
      CONNECTOR_DISCONNECTED_EVENT,
      service.connectorDisconnectedHandler
    );
    logger.info(
      { src: 'plugin:workflow:service:credential-store' },
      'Workflow Credential Store started'
    );
    return service;
  }

  override async stop(): Promise<void> {
    this.runtime.unregisterEvent<ConnectorDisconnectedPayload>(
      CONNECTOR_DISCONNECTED_EVENT,
      this.connectorDisconnectedHandler
    );
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
      .where(
        and(
          eq(credentialMappings.agentId, this.tenantAgentId),
          eq(credentialMappings.userId, userId),
          eq(credentialMappings.credType, credType)
        )
      )
      .limit(1);
    return rows[0]?.workflowCredentialId ?? null;
  }

  async set(userId: string, credType: string, workflowCredId: string): Promise<void> {
    const db = this.getDb();
    await db
      .insert(credentialMappings)
      .values({
        agentId: this.tenantAgentId,
        userId,
        credType,
        workflowCredentialId: workflowCredId,
      })
      .onConflictDoUpdate({
        target: [
          credentialMappings.agentId,
          credentialMappings.userId,
          credentialMappings.credType,
        ],
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
      .where(
        and(
          eq(credentialMappings.agentId, this.tenantAgentId),
          eq(credentialMappings.userId, userId)
        )
      );
    return rows;
  }

  async delete(userId: string, credType: string): Promise<void> {
    const db = this.getDb();
    await db
      .delete(credentialMappings)
      .where(
        and(
          eq(credentialMappings.agentId, this.tenantAgentId),
          eq(credentialMappings.userId, userId),
          eq(credentialMappings.credType, credType)
        )
      );
  }
}
