/** Publishes guarded desktop slot mutations through native receipts, never restoring a value by an unconditional write after a lost reply or cancellation. */

import { ElizaError } from "@elizaos/core/errors";
import type {
  RendererSecureSlot,
  RendererSecureSnapshot,
  RendererSecureStorageAuthority,
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
export type DesktopStorageAuthority = RendererSecureStorageAuthority;

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

/** Restore only the acknowledged outcome of this renderer's durable interruption marker. */
export async function recoverDesktopSecureSlot(
  kind: RendererSecureSlot,
  operationId: string,
  revalidate: () => void,
): Promise<RendererSecureSnapshot> {
  revalidate();
  const result = await request({ operation: "inspect", kind, operationId });
  if (result.operation !== "inspect") throw invalidReply();
  const recovery = result.recovery;
  if (recovery.state !== "sealed" && recovery.state !== "rolled-back")
    throw new ElizaError(
      "Interrupted native storage has no owned terminal result",
      {
        code:
          recovery.state === "not-current"
            ? "NATIVE_STORE_SUPERSEDED"
            : "NATIVE_STORE_PENDING",
        severity: "ephemeral",
      },
    );
  revalidate();
  const verified = await verifyPublication(
    kind,
    recovery.snapshot,
    recovery.snapshot,
  );
  revalidate();
  return verified;
}

/** The optional identity must be durably recorded by a caller before its first native mutation. */
export async function mutateDesktopSecureSlot(
  kind: RendererSecureSlot,
  value: string | null,
  revalidate: () => void,
  expected?: RendererSecureSnapshot,
  signal?: AbortSignal,
  operationId = crypto.randomUUID(),
): Promise<RendererSecureSnapshot> {
  signal?.throwIfAborted();
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
  let cancellation: ReturnType<typeof request> | undefined;
  const cancel = () => {
    cancellation ??= request({ operation: "cancel", kind, operationId });
    // error-policy:J5 observed by the cancellation branch before this mutation settles.
    void cancellation.catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const validate = () => {
    signal?.throwIfAborted();
    revalidate();
  };
  let sealDispatched = false;
  let sealAcknowledged = false;
  const execute = async (): Promise<RendererSecureSnapshot> => {
    try {
      validate();
      const prepared = await request({
        operation: "prepare",
        kind,
        expected: read.snapshot,
        value,
        operationId,
      });
      if (prepared.operation !== "prepare") throw invalidReply();
      validate();
      await request({ operation: "commit", kind, receipt: prepared.receipt });
      validate();
      // The host revalidates captured native account/selection authority at its
      // durable COMMIT. Cancellation is also sent while this request is awaiting
      // native work; durable seal COMMIT, not dispatch or its reply, is irreversible.
      sealDispatched = true;
      const sealed = await request({
        operation: "seal",
        kind,
        receipt: prepared.receipt,
      });
      if (sealed.operation !== "seal") throw invalidReply();
      sealAcknowledged = true;
      const verified = await verifyPublication(
        kind,
        sealed.snapshot,
        read.snapshot,
      );
      validate();
      return verified;
    } catch (error) {
      // error-policy:J2 an acknowledgement can be lost after native mutation.
      // Lookup is by this operation's identity; a newer writer is never compensated.
      if (signal?.aborted) throw error;
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
  };
  // error-policy:J2 retain the operation error until its cancellation receipt is reconciled.
  const outcome = await execute().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  signal?.removeEventListener("abort", cancel);
  // Cancellation can also arrive while lost-reply reconciliation is awaiting
  // the host. Observe its durable disposition on every exit, not just catch entry.
  if (cancellation) {
    const result = await cancellation;
    if (result.operation !== "cancel") throw invalidReply();
    if (result.state === "published")
      throw new ElizaError(
        "Native storage was already published before cancellation; recover the current selection.",
        {
          code: "NATIVE_STORE_ALREADY_PUBLISHED",
          severity: "ephemeral",
          cause: signal?.reason,
        },
      );
    signal?.throwIfAborted();
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
