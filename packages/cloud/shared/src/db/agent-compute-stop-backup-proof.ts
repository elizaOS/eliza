/** Validates the source and runtime identity recorded with a prepared stop backup without loading storage or lifecycle services. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { runtimeIdentitySchema } from "../lib/services/sandbox-runtime-observation";
import type { AgentSandbox } from "./schemas/agent-sandboxes";

const nullableText = z.string().nullable();
export const preparedStopSourceSchema = z
  .object({
    id: z.uuid(),
    organization_id: z.uuid(),
    status: z.string(),
    execution_tier: z.string(),
    pool_status: nullableText,
    deleted_at: z.iso.datetime().nullable(),
    deletion_attempt_id: z.uuid().nullable(),
    sandbox_id: nullableText,
    node_id: nullableText,
    container_name: nullableText,
    bridge_url: nullableText,
    health_url: nullableText,
    bridge_port: z.number().int().nullable(),
    web_ui_port: z.number().int().nullable(),
    headscale_ip: nullableText,
    environment_revision: z.number().int().nonnegative(),
    lifecycle_revision: z.number().int().nonnegative(),
    lifecycle_job_id: z.uuid().nullable(),
    lifecycle_execution_generation: z.uuid().nullable(),
  })
  .strict();
export const preparedStopBackupSchema = z
  .object({
    version: z.literal(1),
    intentId: z.uuid(),
    jobId: z.uuid(),
    backupId: z.uuid(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: preparedStopSourceSchema,
    runtime: runtimeIdentitySchema,
  })
  .strict();
export type PreparedStopBackup = z.infer<typeof preparedStopBackupSchema>;

export function preparedStopSource(rec: AgentSandbox): PreparedStopBackup["source"] {
  return preparedStopSourceSchema.parse({
    id: rec.id,
    organization_id: rec.organization_id,
    status: rec.status,
    execution_tier: rec.execution_tier,
    pool_status: rec.pool_status,
    deleted_at: rec.deleted_at?.toISOString() ?? null,
    deletion_attempt_id: rec.deletion_attempt_id,
    sandbox_id: rec.sandbox_id,
    node_id: rec.node_id,
    container_name: rec.container_name,
    bridge_url: rec.bridge_url,
    health_url: rec.health_url,
    bridge_port: rec.bridge_port,
    web_ui_port: rec.web_ui_port,
    headscale_ip: rec.headscale_ip,
    environment_revision: rec.environment_revision,
    lifecycle_revision: rec.lifecycle_revision,
    lifecycle_job_id: rec.lifecycle_job_id,
    lifecycle_execution_generation: rec.lifecycle_execution_generation,
  });
}
export function preparedStopMatches(
  proof: PreparedStopBackup,
  rec: AgentSandbox,
  intentId: string,
  jobId: string,
): boolean {
  return (
    proof.intentId === intentId &&
    proof.jobId === jobId &&
    proof.runtime.agentId === rec.id &&
    proof.runtime.organizationId === rec.organization_id &&
    proof.runtime.nodeId === rec.node_id &&
    proof.runtime.containerName === rec.container_name &&
    JSON.stringify(proof.source) === JSON.stringify(preparedStopSource(rec))
  );
}
export function parsePreparedStopBackup(value: unknown): PreparedStopBackup {
  const result = preparedStopBackupSchema.safeParse(value);
  if (!result.success)
    throw new ElizaError("Prepared stop backup authority is invalid", {
      code: "AGENT_STOP_BACKUP_PROOF_INVALID",
      cause: result.error,
    });
  return result.data;
}
