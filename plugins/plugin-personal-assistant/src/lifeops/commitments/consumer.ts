/**
 * Runtime consumers for commitment-ledger producers that need to create
 * scheduled work. Source hooks call these helpers when a standing guarantee
 * observes a new artifact and must install both the durable obligation row and
 * the watcher that will fire later through the shared ScheduledTask spine.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { LifeOpsRepository } from "../repository.js";
import type { ScheduledTask } from "../scheduled-task/index.js";
import { getScheduledTaskRunner } from "../scheduled-task/service.js";
import {
  createDocumentObligationLedgerRecord,
  type DocumentObligationInput,
  type LifeOpsCommitmentLedgerRecord,
} from "./ledger.js";

export interface TrackDocumentObligationResult {
  readonly record: LifeOpsCommitmentLedgerRecord;
  readonly task: ScheduledTask;
}

function requireSqlAdapter(runtime: IAgentRuntime): void {
  const adapter = (runtime as { adapter?: { db?: unknown } }).adapter;
  if (!adapter?.db) {
    throw new Error(
      "Tracking document obligations requires the LifeOps SQL adapter.",
    );
  }
}

function documentObligationIdempotencyKey(
  input: DocumentObligationInput,
): string {
  return `commitment-ledger:document:${input.documentId}:deadline:${input.deadline}`;
}

/**
 * Convert one newly observed document artifact into a tracked obligation.
 * The ScheduledTask uses a stable idempotency key, so replaying the same
 * connector/document event reuses the same watcher and upserts the same
 * ledger row instead of creating duplicate owner work.
 */
export async function trackDocumentObligationArtifact(
  runtime: IAgentRuntime,
  input: DocumentObligationInput,
): Promise<TrackDocumentObligationResult> {
  requireSqlAdapter(runtime);
  const seedRecord = createDocumentObligationLedgerRecord({
    ...input,
    scheduledTaskId: null,
  });
  const runner = getScheduledTaskRunner(runtime, { agentId: input.agentId });
  const task = await runner.schedule({
    kind: "watcher",
    promptInstructions: `Document "${input.title}" obligation deadline reached. Verify ${seedRecord.kind} status for ${input.documentId} and escalate if it is still open.`,
    trigger: { kind: "once", atIso: input.deadline },
    priority: "medium",
    subject: { kind: "document", id: input.documentId },
    idempotencyKey: documentObligationIdempotencyKey(input),
    respectsGlobalPause: true,
    source: "plugin",
    createdBy: input.agentId,
    ownerVisible: true,
    metadata: {
      ...(input.metadata ?? {}),
      commitmentLedgerId: seedRecord.id,
      commitmentKind: seedRecord.kind,
      documentId: input.documentId,
      documentTitle: input.title,
      standingGuarantee: true,
    },
  });
  const record = createDocumentObligationLedgerRecord({
    ...input,
    scheduledTaskId: task.taskId,
  });
  await new LifeOpsRepository(runtime).upsertCommitmentLedgerRecord(record);
  return { record, task };
}
