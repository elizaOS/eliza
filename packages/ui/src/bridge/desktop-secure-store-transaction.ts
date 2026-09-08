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

const slots: RendererSecureSlot[] = [
  "session.device_auth",
  "session.steward_token",
  "runtime.active_server",
  "runtime.agent_profiles",
];

function superseded(): ElizaError {
  return new ElizaError("The native account or runtime selection changed", {
    code: "NATIVE_STORE_SUPERSEDED",
    severity: "ephemeral",
  });
}

function copySnapshot(
  snapshot: RendererSecureSnapshot,
): RendererSecureSnapshot {
  return { ...snapshot, authority: { ...snapshot.authority } };
}

/** An individual continuation's baseline, advanced only by its acknowledged writes. */
export interface DesktopStorageAuthority {
  expected(kind: RendererSecureSlot): RendererSecureSnapshot;
  acceptOwned(
    kind: RendererSecureSlot,
    published: RendererSecureSnapshot,
  ): void;
  assertCurrent(): Promise<void>;
}

/** Capture before starting account requests, rejecting an already-stale renderer mirror. */
export async function captureDesktopStorageAuthority(
  values: ReadonlyMap<RendererSecureSlot, string | null>,
  revalidate: () => void,
): Promise<DesktopStorageAuthority> {
  const snapshots = new Map<RendererSecureSlot, RendererSecureSnapshot>();
  let vector: RendererSecureSnapshot["authority"] | undefined;
  for (const kind of slots) {
    revalidate();
    const result = await request({ operation: "read", kind });
    if (result.operation !== "read") throw invalidReply();
    revalidate();
    if (
      result.snapshot.value !== values.get(kind) ||
      (vector &&
        slots.some(
          (slot) => vector?.[slot] !== result.snapshot.authority[slot],
        ))
    )
      throw superseded();
    vector = { ...result.snapshot.authority };
    snapshots.set(kind, copySnapshot(result.snapshot));
  }
  const expected = (kind: RendererSecureSlot) => {
    const snapshot = snapshots.get(kind);
    if (!snapshot) throw invalidReply();
    return copySnapshot(snapshot);
  };
  return {
    expected,
    acceptOwned(kind, published) {
      const previous = expected(kind);
      if (
        slots.some(
          (slot) =>
            slot !== kind &&
            previous.authority[slot] !== published.authority[slot],
        )
      )
        throw superseded();
      // Carry the acknowledged revision, never a later read that can adopt ABA
      // or another writer. All slot expectations share this one updated vector.
      for (const slot of slots) {
        const snapshot = slot === kind ? published : expected(slot);
        snapshots.set(slot, {
          ...snapshot,
          authority: { ...published.authority },
        });
      }
    },
    async assertCurrent() {
      revalidate();
      const result = await request({
        operation: "read",
        kind: "session.device_auth",
      });
      if (result.operation !== "read") throw invalidReply();
      revalidate();
      const captured = expected("session.device_auth");
      if (
        slots.some(
          (slot) =>
            captured.authority[slot] !== result.snapshot.authority[slot],
        )
      )
        throw superseded();
    },
  };
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
  expected?: RendererSecureSnapshot,
): Promise<RendererSecureSnapshot> {
  revalidate();
  const read = await request({ operation: "read", kind });
  if (read.operation !== "read") throw invalidReply();
  if (
    expected &&
    (read.snapshot.revision !== expected.revision ||
      read.snapshot.value !== expected.value ||
      slots.some(
        (slot) => read.snapshot.authority[slot] !== expected.authority[slot],
      ))
  )
    throw superseded();
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
