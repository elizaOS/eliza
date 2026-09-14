/** Browser-safe deletion review and journal contracts shared by HTTP clients and storage. */
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const familyBackupRetentionSchema = z.enum([
  "immediate",
  "7-days",
  "30-days",
]);
export const familyDeletionJobSchema = z.strictObject({
  id: z.string().uuid(),
  agentId: z.string().min(1),
  reviewedSha256: sha256,
  startedAt: z.string().datetime(),
  state: z.enum(["purge_pending", "backup_pending"]),
  backupRetention: familyBackupRetentionSchema,
  backupGeneration: z.string().uuid(),
  backupOperationId: z.string().min(1),
  files: z.array(z.strictObject({ fileName: z.string().min(1), sha256 })),
  databaseRowsRemoved: z.number().int().nonnegative(),
  retained: z.array(
    z.strictObject({ kind: z.string(), count: z.number().int().positive() }),
  ),
});
export type FamilyDeletionJob = z.infer<typeof familyDeletionJobSchema>;

export const familyDeletionPreviewSchema = z.strictObject({
  agentId: z.string().min(1),
  sha256,
  unavailable: z.array(z.string()),
  records: z.array(
    z.strictObject({
      kind: z.string(),
      classification: z.enum(["owned", "referenced", "mixed", "unclassified"]),
      unsettled: z.boolean(),
      sha256,
      identity: z.record(z.string(), z.json()),
    }),
  ),
});
export type FamilyDeletionPreview = z.infer<typeof familyDeletionPreviewSchema>;
