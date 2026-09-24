/** Reconstructs the committed backup behind a prepared stop proof and verifies its canonical storage identity and content. */
import { ElizaError } from "@elizaos/core";
import type { PreparedStopBackup } from "../../../../db/agent-compute-stop-backup-proof";
import { hydrateAgentSandboxBackup } from "../../../../db/repositories/agent-sandboxes";
import { computeStateHash, requireBackupStateData } from "../../agent-backup-diff";
import { captureStoredRestoreChain, storedRestoreChainStillCanonical } from "./authority";

export {
  type PreparedStopBackup,
  parsePreparedStopBackup,
  preparedStopBackupSchema,
  preparedStopMatches,
  preparedStopSource,
  preparedStopSourceSchema,
} from "../../../../db/agent-compute-stop-backup-proof";

export async function verifyPreparedStopBackup(proof: PreparedStopBackup): Promise<void> {
  const chain = await captureStoredRestoreChain(proof.backupId, proof.source.id);
  if (!chain)
    throw new ElizaError("Prepared stop backup is missing or belongs to another agent", {
      code: "AGENT_STOP_BACKUP_UNAVAILABLE",
    });
  // These proofs are minted only for the canonical full snapshot insertion.
  if (chain.length !== 1 || chain[0]?.id !== proof.backupId || chain[0]?.backup_kind !== "full")
    throw new ElizaError("Prepared stop backup chain changed", {
      code: "AGENT_STOP_BACKUP_CHANGED",
    });
  const hydrated = await hydrateAgentSandboxBackup(chain[0]);
  const state = requireBackupStateData(hydrated.state_data, proof.backupId);
  const confirmed = await captureStoredRestoreChain(proof.backupId, proof.source.id);
  if (
    !confirmed ||
    !storedRestoreChainStillCanonical(confirmed, chain) ||
    computeStateHash(state) !== proof.contentHash
  )
    throw new ElizaError("Prepared stop backup content changed", {
      code: "AGENT_STOP_BACKUP_CHANGED",
    });
}
