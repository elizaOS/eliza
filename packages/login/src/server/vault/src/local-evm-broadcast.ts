import { logger } from "@elizaos/logger";
import { type Hex, keccak256 } from "viem";
import { redactedThrownDiagnostics } from "../../shared/src/index.ts";
import { ExternalBroadcastOutcomeUnknownError } from "./external-key-custody";

export interface LocalEvmBroadcastLifecycle {
  /** Prepare and locally sign bytes. No mutating RPC may occur here. */
  prepare: () => Promise<Hex>;
  /** Durably persist the deterministic hash before the mutating RPC boundary. */
  checkpoint: (transactionHash: Hex) => Promise<void>;
  /** Submit the exact signed bytes once. This callback must never retry. */
  broadcast: (serializedTransaction: Hex) => Promise<Hex>;
  /** One read-only reconciliation attempt after a lost/failed RPC response. */
  reconcile: (transactionHash: Hex) => Promise<boolean>;
  /** Release allocator state only while it is still proven pre-broadcast. */
  releaseBeforeBroadcast: () => Promise<void>;
  /** Persist accepted state and confirm allocator bookkeeping. */
  finalizeAccepted: (transactionHash: Hex) => Promise<void>;
}

async function releaseBeforeBroadcast(
  lifecycle: LocalEvmBroadcastLifecycle,
): Promise<void> {
  try {
    await lifecycle.releaseBeforeBroadcast();
  } catch (error) {
    // Preserve the operation failure for callers while making allocator cleanup
    // failures visible without exposing database or provider diagnostics.
    try {
      logger.error(
        {
          details: [
            "[vault] Failed to release EVM nonce after pre-broadcast failure",
            redactedThrownDiagnostics(error),
          ],
        },
        "[Login:local-evm-broadcast] error",
      );
    } catch {
      // Diagnostics are best-effort and must never replace the operation error.
    }
  }
}

/**
 * Broadcast a locally signed EVM transaction without ever blindly retrying or
 * reusing its nonce after the first mutating RPC call.
 *
 * The signed bytes make the final transaction hash deterministic. Steward
 * checkpoints that hash before submission, broadcasts exactly once, and then
 * performs at most one read-only hash reconciliation if the RPC response is
 * lost. Any unresolved or post-broadcast failure is surfaced as
 * outcome-unknown and deliberately does not call `releaseBeforeBroadcast`.
 */
export async function executeLocalEvmBroadcast(
  lifecycle: LocalEvmBroadcastLifecycle,
): Promise<Hex> {
  let serializedTransaction: Hex;
  try {
    serializedTransaction = await lifecycle.prepare();
  } catch (error) {
    await releaseBeforeBroadcast(lifecycle);
    throw error;
  }

  const transactionHash = keccak256(serializedTransaction);
  try {
    await lifecycle.checkpoint(transactionHash);
  } catch (error) {
    // No mutating RPC has happened, so this is the final safe release point.
    await releaseBeforeBroadcast(lifecycle);
    throw error;
  }

  let returnedHash: Hex;
  try {
    returnedHash = await lifecycle.broadcast(serializedTransaction);
  } catch (cause) {
    const reconciled = await lifecycle
      .reconcile(transactionHash)
      .catch(() => false);
    if (!reconciled) {
      throw new ExternalBroadcastOutcomeUnknownError(transactionHash, {
        cause,
      });
    }
    returnedHash = transactionHash;
  }

  if (returnedHash.toLowerCase() !== transactionHash.toLowerCase()) {
    throw new ExternalBroadcastOutcomeUnknownError(transactionHash, {
      cause: new Error("EVM RPC returned a mismatched transaction hash"),
    });
  }

  try {
    await lifecycle.finalizeAccepted(transactionHash);
  } catch (cause) {
    // Submission has completed (or was reconciled), and the durable checkpoint
    // remains the authoritative recovery record. Never make this retryable.
    throw new ExternalBroadcastOutcomeUnknownError(transactionHash, { cause });
  }

  return transactionHash;
}
