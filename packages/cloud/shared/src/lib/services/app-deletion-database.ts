import {
  confirmDeletionDatabase,
  readOriginalDeletionDatabase,
} from "../../db/repositories/app-deletion-database";
import { getAppDbDeprovisioner } from "./app-db-deprovision-job-service";
import { AppDeletionRecoveryPendingError } from "./app-deletion-authority";
import { fieldEncryption } from "./field-encryption";
import type { JobExecutionAuthority } from "./job-execution-authority";

export async function dispatchAppDeletionDatabase(authority: JobExecutionAuthority): Promise<void> {
  const original = await readOriginalDeletionDatabase(authority);
  if (!original) return;
  const dsn = await fieldEncryption.decryptIfNeeded(original.encryptedUri);
  if (!dsn) throw new AppDeletionRecoveryPendingError("Original database URI is unavailable");
  // Decryption can wait on KMS. Recheck the original lease and placement at
  // the final dispatch boundary; the provider target never comes from input.
  const current = await readOriginalDeletionDatabase(authority);
  if (!current) return;
  if (current.encryptedUri !== original.encryptedUri)
    throw new AppDeletionRecoveryPendingError("Original database URI changed");
  const outcome = await getAppDbDeprovisioner().deprovisionForApp(original.data.appId, dsn, {
    originalClusterId: original.data.originalClusterId!,
    retainPlacement: true,
  });
  if (!outcome.deprovisioned)
    throw new AppDeletionRecoveryPendingError("Original database absence is not confirmed", {
      reason: outcome.reason,
    });
  await confirmDeletionDatabase(authority);
}
