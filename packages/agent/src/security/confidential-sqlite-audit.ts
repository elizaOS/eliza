/**
 * Commits confidential dispatch metadata to the agent's existing SQLite store.
 * The host prepares the audit actor and room before provider initialization;
 * every append rechecks their ownership in the same transaction as the write.
 * These mutable runtime logs are not an independent tamper-evident ledger.
 */
import {
  type ConfidentialInferenceAuditSink,
  ElizaError,
  type IDatabaseAdapter,
  type UUID,
} from "@elizaos/core";
import type { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { z } from "zod";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const recordSchema = z
  .object({
    attemptId: z.uuid(),
    agentId: z.uuid(),
    modelType: z.string().min(1),
    policyRevision: z.string().min(1).nullable(),
    routeId: z.string().min(1).nullable(),
    timestamp: z.number().int().nonnegative(),
    phase: z.enum([
      "dispatch_intent",
      "response_headers",
      "transport_error",
      "denied",
    ]),
    denialCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    status: z.number().int().min(100).max(599).optional(),
    evidenceDigest: digest.optional(),
    connectionBindingDigest: digest.optional(),
  })
  .strict();

function rejected(): ElizaError {
  return new ElizaError(
    "Confidential audit requires ready same-agent SQLite records",
    {
      code: "CONFIDENTIAL_SQLITE_AUDIT_REJECTED",
    },
  );
}

/** Call only with the host's opened SQLite adapter, before admitting providers. */
export async function createConfidentialSQLiteAudit(
  adapter: SQLiteDatabaseAdapter,
  identity: { agentId: UUID; entityId: UUID; roomId: UUID },
): Promise<ConfidentialInferenceAuditSink> {
  const { agentId, entityId, roomId } = identity;
  async function requireOwner(tx: IDatabaseAdapter): Promise<void> {
    const agents = await tx.getAgentsByIds([agentId]);
    const entities = await tx.getEntitiesByIds([entityId]);
    const rooms = await tx.getRoomsByIds([roomId]);
    if (
      agents.length !== 1 ||
      agents[0].id !== agentId ||
      entities.length !== 1 ||
      entities[0].agentId !== agentId ||
      rooms.length !== 1 ||
      rooms[0].agentId !== agentId
    )
      throw rejected();
  }
  await adapter.transaction(requireOwner);
  return Object.freeze({
    async append(input) {
      const parsed = recordSchema.safeParse(input);
      if (!parsed.success || parsed.data.agentId !== agentId) throw rejected();
      const record = parsed.data;
      if (
        record.phase !== "denied" &&
        (record.policyRevision === null ||
          record.routeId === null ||
          record.evidenceDigest === undefined ||
          record.connectionBindingDigest === undefined)
      )
        throw rejected();
      await adapter.transaction(async (tx) => {
        await requireOwner(tx);
        await tx.createLogs([
          {
            entityId,
            roomId,
            type: "confidential_inference",
            body: { source: "confidential-host", metadata: record },
          },
        ]);
      });
    },
  } satisfies ConfidentialInferenceAuditSink);
}
