/** Publishes guarded desktop slot mutations through native receipts, never restoring a value by an unconditional write after a lost reply or cancellation. */

import { ElizaError } from "@elizaos/core/errors";
import type {
  RendererSecureSlot,
  RendererSecureSnapshot,
} from "@elizaos/shared/types";
import { desktopSecureStoreTransaction as request } from "./electrobun-rpc";

function invalidReply(cause?: unknown): ElizaError {
  return new ElizaError("Native credential reconciliation is unavailable", {
    code: "NATIVE_STORE_INVALID_REPLY",
    severity: "ephemeral",
    cause,
  });
}

async function verifyPublication(
  kind: RendererSecureSlot,
  published: RendererSecureSnapshot,
  captured: RendererSecureSnapshot,
): Promise<RendererSecureSnapshot> {
  const current = await request({ operation: "read", kind });
  if (
    current.operation !== "read" ||
    current.snapshot.revision !== published.revision ||
    current.snapshot.value !== published.value ||
    (Object.keys(published.authority) as RendererSecureSlot[]).some(
      (slot) =>
        current.snapshot.authority[slot] !== published.authority[slot] ||
        (slot !== kind &&
          current.snapshot.authority[slot] !== captured.authority[slot]),
    )
  )
    throw new ElizaError("Native credential publication was superseded", {
      code: "NATIVE_STORE_SUPERSEDED",
      severity: "ephemeral",
    });
  return current.snapshot;
}

export async function mutateDesktopSecureSlot(
  kind: RendererSecureSlot,
  value: string | null,
  revalidate: () => void,
): Promise<RendererSecureSnapshot> {
  revalidate();
  const read = await request({ operation: "read", kind });
  if (read.operation !== "read") throw invalidReply();
  revalidate();
  const operationId = crypto.randomUUID();
  let sealDispatched = false;
  let sealAcknowledged = false;
  try {
    const prepared = await request({
      operation: "prepare",
      kind,
      expected: read.snapshot,
      value,
      operationId,
    });
    if (prepared.operation !== "prepare") throw invalidReply();
    revalidate();
    await request({ operation: "commit", kind, receipt: prepared.receipt });
    revalidate();
    // The host revalidates captured native account/selection authority at its
    // durable COMMIT. Cancellation after this dispatch cannot undo publication.
    sealDispatched = true;
    const sealed = await request({
      operation: "seal",
      kind,
      receipt: prepared.receipt,
    });
    if (sealed.operation !== "seal") throw invalidReply();
    sealAcknowledged = true;
    return await verifyPublication(kind, sealed.snapshot, read.snapshot);
  } catch (error) {
    // error-policy:J2 an acknowledgement can be lost after native mutation.
    // Lookup is by this operation's identity; a newer writer is never compensated.
    if (sealAcknowledged) throw error;
    const current = await request({ operation: "lookup", kind, operationId });
    if (current.operation !== "lookup") throw invalidReply(error);
    const receipt = current.receipt;
    if (sealDispatched && receipt?.state === "sealed") {
      // Idempotent seal reads the already-published result. A newer winner
      // between lookup and this call makes it reject without changing anything.
      const sealed = await request({ operation: "seal", kind, receipt });
      if (sealed.operation !== "seal") throw invalidReply(error);
      return await verifyPublication(kind, sealed.snapshot, read.snapshot);
    }
    if (receipt?.state === "pending" || receipt?.state === "committed")
      await request({ operation: "rollback", kind, receipt });
    throw error;
  }
}
