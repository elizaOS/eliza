/** Projects relationship observations over independent pre-existing data. Retired
 * observations remain in the ledger so deletion and journal replay are auditable. */
import z from "zod";
import { ElizaError } from "@elizaos/core";
import type { EvaluatorEvidenceReconciliation } from "@elizaos/core";

const valueSchema = z.object({
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.json()),
});
const observationSchema = valueSchema.extend({
  roomId: z.string(),
  evidenceId: z.string(),
  sourceRevisions: z.record(z.string(), z.string()),
  interactionDelta: z.number().int().nonnegative(),
  isBackfill: z.boolean(),
  sequence: z.number().int().nonnegative(),
  retiredBy: z.string().optional(),
});
const ledgerSchema = z.object({
  version: z.literal(1),
  baseline: valueSchema.nullable(),
  overlay: valueSchema.optional(),
  observations: z.record(z.string(), observationSchema),
  active: z.boolean(),
});
export type RelationshipEvidenceValue = z.infer<typeof valueSchema>;
export type RelationshipObservation = z.infer<typeof observationSchema>;
export type RelationshipEvidenceLedger = z.infer<typeof ledgerSchema>;

export function parseRelationshipEvidence(
  value: unknown,
): RelationshipEvidenceLedger {
  const result = ledgerSchema.safeParse(value);
  if (!result.success)
    throw new ElizaError("Relationship evidence ledger is invalid", {
      code: "RELATIONSHIP_EVIDENCE_INVALID",
      cause: result.error,
    });
  return result.data;
}

export function projectRelationshipEvidence(
  ledger: RelationshipEvidenceLedger,
): RelationshipEvidenceValue & { active: boolean } {
  const observations = Object.values(ledger.observations)
    .filter((item) => !item.retiredBy)
    .sort((a, b) => a.sequence - b.sequence);
  const metadata = { ...ledger.baseline?.metadata };
  const tags = new Set(ledger.baseline?.tags ?? []);
  let interactions =
    typeof metadata.interactions === "number" ? metadata.interactions : 0;
  for (const observation of observations) {
    for (const tag of observation.tags) tags.add(tag);
    interactions += observation.interactionDelta;
    Object.assign(metadata, { interactions }, observation.metadata);
    if (typeof metadata.interactions === "number")
      interactions = metadata.interactions;
  }
  for (const tag of ledger.overlay?.tags ?? []) tags.add(tag);
  Object.assign(metadata, ledger.overlay?.metadata);
  return {
    active:
      ledger.baseline !== null ||
      observations.length > 0 ||
      ledger.overlay !== undefined,
    tags: [...tags],
    metadata,
  };
}

export function retireRelationshipEvidence(
  ledger: RelationshipEvidenceLedger,
  roomId: string,
  reconciliation: EvaluatorEvidenceReconciliation,
): { ledger: RelationshipEvidenceLedger; reprocessSourceIds: string[] } {
  const next = structuredClone(ledger);
  const reprocess = new Set<string>();
  for (const observation of Object.values(next.observations)) {
    if (observation.roomId !== roomId) continue;
    if (observation.retiredBy && observation.retiredBy !== reconciliation.id)
      continue;
    const affected =
      observation.evidenceId === reconciliation.pendingEvidenceId ||
      Object.entries(observation.sourceRevisions).some(
        ([id, revision]) =>
          reconciliation.changedMessageIds.includes(id) ||
          reconciliation.removedMessageIds.includes(id) ||
          (reconciliation.currentSourceRevisions[id] !== undefined &&
            reconciliation.currentSourceRevisions[id] !== revision),
      );
    if (!affected) continue;
    observation.retiredBy ??= reconciliation.id;
    for (const id of Object.keys(observation.sourceRevisions))
      if (reconciliation.currentSourceRevisions[id] !== undefined)
        reprocess.add(id);
  }
  next.active = projectRelationshipEvidence(next).active;
  return { ledger: next, reprocessSourceIds: [...reprocess] };
}
