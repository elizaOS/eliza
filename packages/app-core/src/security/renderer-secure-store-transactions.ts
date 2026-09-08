/**
 * Coordinates conditional app-slot publication inside a native secure store.
 * Values, opaque revisions, pending proposals and compensation receipts occupy
 * one protected record, so a crash cannot separate ownership from its value.
 * The host must supply serialization spanning every writer of the same vault
 * across all app slots; a renderer queue or browser-origin lock does not satisfy
 * that port. Captured account/selection fingerprints fence final publication.
 */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type {
  RendererSecureReceipt,
  RendererSecureSlot,
  RendererSecureSnapshot,
} from "@elizaos/shared/types";
import type { PlatformSecureStore } from "./platform-secure-store";

export type {
  RendererSecureReceipt,
  RendererSecureSlot,
  RendererSecureSnapshot,
} from "@elizaos/shared/types";

export interface RendererSecureCommitBoundary {
  /** Synchronous checks run immediately before durable publication, after all native awaits. */
  beforeCommit(check: () => void): void;
  isCancelled(slot: RendererSecureSlot, operationId: string): boolean;
  cancelOperation(slot: RendererSecureSlot, operationId: string): void;
}

export interface RendererSecureSerialization {
  run<T>(
    vaultId: string,
    work: (boundary: RendererSecureCommitBoundary) => Promise<T>,
  ): Promise<T>;
}

type Transaction = RendererSecureReceipt & {
  baseRevision: string;
  previous: string | null;
  proposed: string | null;
  expiresAt: number;
  authority: Record<RendererSecureSlot, string>;
};
type RecordState = Pick<RendererSecureSnapshot, "revision" | "value"> & {
  transaction: Transaction | null;
};
const PREFIX = "eliza-native-slot:1\n";
const MAX_VALUE_BYTES = 256 * 1024;
// JSON can encode one UTF-8 control byte as six bytes. A reversible record
// holds at most three logical values, plus fixed-size ownership metadata.
const MAX_RECORD_BYTES = MAX_VALUE_BYTES * 3 * 6 + 4096;
const PENDING_LIFETIME_MS = 60_000;
const SLOTS = new Set<RendererSecureSlot>([
  "session.device_auth",
  "session.steward_token",
  "runtime.active_server",
  "runtime.agent_profiles",
]);

function failure(code: string): ElizaError {
  return new ElizaError(
    "Native credential operation could not establish ownership",
    {
      code,
      severity: "ephemeral",
    },
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isValue(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= MAX_VALUE_BYTES)
  );
}
function isIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
function isRevision(value: unknown): value is string {
  return value === "legacy" || value === "absent" || isIdentity(value);
}

function isAuthority(
  value: unknown,
): value is Record<RendererSecureSlot, string> {
  return (
    isObject(value) &&
    Object.keys(value).length === SLOTS.size &&
    [...SLOTS].every(
      (slot) =>
        typeof value[slot] === "string" && /^[0-9a-f]{64}$/.test(value[slot]),
    )
  );
}

function fingerprint(
  record: Pick<RendererSecureSnapshot, "revision" | "value">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([record.revision, record.value]))
    .digest("hex");
}

function isPending(record: RecordState): boolean {
  return (
    record.transaction?.state === "pending" ||
    record.transaction?.state === "committed"
  );
}

/** Existing plaintext-format payloads remain logical values, never envelopes exposed to callers. */
function decode(raw: string | null): RecordState {
  if (raw === null)
    return { revision: "absent", value: null, transaction: null };
  if (!raw.startsWith("eliza-native-slot:")) {
    if (!isValue(raw)) throw failure("NATIVE_STORE_CORRUPT");
    return { revision: "legacy", value: raw, transaction: null };
  }
  if (
    !raw.startsWith(PREFIX) ||
    Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES
  )
    throw failure("NATIVE_STORE_CORRUPT");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(PREFIX.length));
  } catch {
    // error-policy:J3 malformed protected metadata is unavailable, never a legacy credential.
    throw failure("NATIVE_STORE_CORRUPT");
  }
  if (
    !isObject(parsed) ||
    !isIdentity(parsed.revision) ||
    !isValue(parsed.value)
  )
    throw failure("NATIVE_STORE_CORRUPT");
  const transaction = parsed.transaction;
  if (transaction === null)
    return {
      revision: parsed.revision,
      value: parsed.value,
      transaction: null,
    };
  if (
    !isObject(transaction) ||
    !isIdentity(transaction.operationId) ||
    !isIdentity(transaction.revision) ||
    !isRevision(transaction.baseRevision) ||
    !isValue(transaction.previous) ||
    !isValue(transaction.proposed) ||
    !isAuthority(transaction.authority) ||
    typeof transaction.expiresAt !== "number" ||
    !Number.isSafeInteger(transaction.expiresAt) ||
    (transaction.state !== "pending" &&
      transaction.state !== "committed" &&
      transaction.state !== "sealed" &&
      transaction.state !== "rolled-back")
  )
    throw failure("NATIVE_STORE_CORRUPT");
  const state = transaction.state;
  if (
    ((state === "pending" || state === "committed") &&
      transaction.revision !== parsed.revision) ||
    ((state === "rolled-back" || state === "sealed") &&
      (transaction.revision === parsed.revision ||
        transaction.previous !== null ||
        transaction.proposed !== null)) ||
    (state === "pending" && parsed.value !== transaction.previous) ||
    (state === "committed" && parsed.value !== transaction.proposed)
  )
    throw failure("NATIVE_STORE_CORRUPT");
  return {
    revision: parsed.revision,
    value: parsed.value,
    transaction: {
      operationId: transaction.operationId,
      revision: transaction.revision,
      state,
      baseRevision: transaction.baseRevision,
      previous: transaction.previous,
      proposed: transaction.proposed,
      expiresAt: transaction.expiresAt,
      authority: transaction.authority,
    },
  };
}

/** Native host owner; do not construct beside a bypassing raw app-slot writer. */
export class RendererSecureStoreTransactions {
  constructor(
    private readonly store: Pick<PlatformSecureStore, "get" | "set">,
    private readonly serialization: RendererSecureSerialization,
    private readonly now: () => number = Date.now,
  ) {}

  private async persist(
    vault: string,
    slot: RendererSecureSlot,
    record: RecordState,
  ): Promise<void> {
    const raw = PREFIX + JSON.stringify(record);
    if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES)
      throw failure("NATIVE_STORE_INVALID_INPUT");
    const written = await this.store.set(vault, slot, raw);
    if (!written.ok) throw failure("NATIVE_STORE_UNAVAILABLE");
    const verified = await this.store.get(vault, slot);
    if (!verified.ok || verified.value !== raw)
      throw failure("NATIVE_STORE_UNVERIFIED");
  }

  private run<T>(
    vault: string,
    slot: RendererSecureSlot,
    work: (
      record: RecordState,
      boundary: RendererSecureCommitBoundary,
    ) => Promise<T>,
  ): Promise<T> {
    if (!vault || !SLOTS.has(slot))
      return Promise.reject(failure("NATIVE_STORE_INVALID_INPUT"));
    return this.serialization.run(vault, async (boundary) => {
      return work(await this.load(vault, slot), boundary);
    });
  }

  private async runOwned<T>(
    vault: string,
    slot: RendererSecureSlot,
    operationId: string,
    signal: AbortSignal | undefined,
    work: (
      record: RecordState,
      boundary: RendererSecureCommitBoundary,
    ) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    return this.run(vault, slot, async (record, boundary) => {
      const validate = () => {
        signal?.throwIfAborted();
        if (boundary.isCancelled(slot, operationId))
          throw failure("NATIVE_STORE_CANCELLED");
      };
      validate();
      boundary.beforeCommit(validate);
      return work(record, boundary);
    });
  }

  /** Only called while holding the vault-wide native serialization boundary. */
  private async load(
    vault: string,
    slot: RendererSecureSlot,
  ): Promise<RecordState> {
    const read = await this.store.get(vault, slot);
    if (!read.ok && read.reason !== "not_found")
      throw failure("NATIVE_STORE_UNAVAILABLE");
    let record = decode(read.ok ? read.value : null);
    const pending = record.transaction;
    const now = this.now();
    if (!Number.isSafeInteger(now)) throw failure("NATIVE_STORE_INVALID_CLOCK");
    if (
      (pending?.state === "pending" || pending?.state === "committed") &&
      (now >= pending.expiresAt ||
        pending.expiresAt > now + PENDING_LIFETIME_MS)
    ) {
      // The proposal was never published. A deadline also fences a surviving
      // old renderer after host restart or a backwards wall-clock jump.
      record = this.rolledBack(pending);
      await this.persist(vault, slot, record);
    }
    return record;
  }

  private async snapshot(
    vault: string,
    slot: RendererSecureSlot,
    record: RecordState,
    allowPending = false,
  ): Promise<RendererSecureSnapshot> {
    const authority = {} as Record<RendererSecureSlot, string>;
    for (const key of SLOTS) {
      const current = key === slot ? record : await this.load(vault, key);
      if (!allowPending && isPending(current))
        throw failure("NATIVE_STORE_PENDING");
      authority[key] = fingerprint(current);
    }
    return { revision: record.revision, value: record.value, authority };
  }

  private async assertAuthority(
    vault: string,
    slot: RendererSecureSlot,
    authority: Record<RendererSecureSlot, string>,
  ): Promise<void> {
    for (const key of SLOTS) {
      if (key === slot) continue;
      const current = await this.load(vault, key);
      if (isPending(current) || fingerprint(current) !== authority[key])
        throw failure("NATIVE_STORE_SUPERSEDED");
    }
  }

  private rolledBack(transaction: Transaction): RecordState {
    return {
      revision: randomUUID(),
      value: transaction.previous,
      // Retain only the receipt for a lost rollback reply, not the rejected secret.
      transaction: {
        ...transaction,
        state: "rolled-back",
        previous: null,
        proposed: null,
      },
    };
  }

  read(
    vault: string,
    slot: RendererSecureSlot,
  ): Promise<RendererSecureSnapshot> {
    return this.run(vault, slot, async (record) => {
      if (
        record.transaction?.state === "pending" ||
        record.transaction?.state === "committed"
      )
        throw failure("NATIVE_STORE_PENDING");
      return this.snapshot(vault, slot, record);
    });
  }

  /** All ordinary/proxy writes and deletes advance the same durable ownership. */
  write(
    vault: string,
    slot: RendererSecureSlot,
    value: string | null,
  ): Promise<RendererSecureSnapshot> {
    if (!isValue(value))
      return Promise.reject(failure("NATIVE_STORE_INVALID_INPUT"));
    return this.run(vault, slot, async () => {
      const record: RecordState = {
        revision: randomUUID(),
        value,
        transaction: null,
      };
      await this.persist(vault, slot, record);
      // A newer explicit account/selection change must be able to supersede an
      // older pending operation. Its snapshot cannot prepare until peers settle.
      return this.snapshot(vault, slot, record, true);
    });
  }

  prepare(
    vault: string,
    slot: RendererSecureSlot,
    selection: RendererSecureSnapshot,
    value: string | null,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<RendererSecureReceipt> {
    if (
      !isValue(value) ||
      !isValue(selection.value) ||
      !isRevision(selection.revision) ||
      !isAuthority(selection.authority) ||
      selection.authority[slot] !== fingerprint(selection) ||
      !isIdentity(operationId)
    )
      return Promise.reject(failure("NATIVE_STORE_INVALID_INPUT"));
    // A caller may retain/mutate its DTO while this operation waits for the host.
    const expected = { ...selection, authority: { ...selection.authority } };
    return this.runOwned(vault, slot, operationId, signal, async (record) => {
      await this.assertAuthority(vault, slot, expected.authority);
      const existing = record.transaction;
      if (existing?.operationId === operationId) {
        if (existing.state === "rolled-back" || existing.state === "sealed")
          throw failure("NATIVE_STORE_SUPERSEDED");
        if (
          existing.baseRevision !== expected.revision ||
          existing.previous !== expected.value ||
          existing.proposed !== value ||
          [...SLOTS].some(
            (key) => existing.authority[key] !== expected.authority[key],
          )
        )
          throw failure("NATIVE_STORE_INVALID_INPUT");
        return this.receipt(existing);
      }
      if (
        record.revision !== expected.revision ||
        record.value !== expected.value ||
        existing?.state === "pending" ||
        existing?.state === "committed"
      )
        throw failure("NATIVE_STORE_SUPERSEDED");
      const transaction: Transaction = {
        operationId,
        revision: randomUUID(),
        state: "pending",
        baseRevision: expected.revision,
        previous: record.value,
        proposed: value,
        expiresAt: this.now() + PENDING_LIFETIME_MS,
        authority: { ...expected.authority },
      };
      await this.persist(vault, slot, {
        revision: transaction.revision,
        value: record.value,
        transaction,
      });
      return this.receipt(transaction);
    });
  }

  private receipt(transaction: Transaction): RendererSecureReceipt {
    return {
      operationId: transaction.operationId,
      revision: transaction.revision,
      state: transaction.state,
    };
  }

  /** Recover a lost prepare reply without starting another mutation after cancellation. */
  lookup(
    vault: string,
    slot: RendererSecureSlot,
    operationId: string,
  ): Promise<RendererSecureReceipt | null> {
    if (!isIdentity(operationId))
      return Promise.reject(failure("NATIVE_STORE_INVALID_INPUT"));
    return this.run(vault, slot, async (record) =>
      record.transaction?.operationId === operationId
        ? this.receipt(record.transaction)
        : null,
    );
  }

  /** Commit the proposal provisionally; other readers remain gated until seal. */
  commit(
    vault: string,
    slot: RendererSecureSlot,
    receipt: RendererSecureReceipt,
    signal?: AbortSignal,
  ): Promise<RendererSecureSnapshot> {
    return this.runOwned(
      vault,
      slot,
      receipt.operationId,
      signal,
      async (record) => {
        const transaction = record.transaction;
        if (
          !transaction ||
          transaction.operationId !== receipt.operationId ||
          transaction.revision !== receipt.revision ||
          transaction.state === "rolled-back" ||
          transaction.state === "sealed"
        )
          throw failure("NATIVE_STORE_SUPERSEDED");
        if (transaction.state === "pending") {
          record = {
            ...record,
            value: transaction.proposed,
            transaction: { ...transaction, state: "committed" },
          };
          await this.persist(vault, slot, record);
        }
        return this.snapshot(vault, slot, record, true);
      },
    );
  }

  /**
   * Irreversible publication point. Call only after final authority validation.
   * Once sealed, a lost reply is reconciled with lookup/read, never rollback;
   * cancellation after publication does not undo a completed native operation.
   */
  seal(
    vault: string,
    slot: RendererSecureSlot,
    receipt: RendererSecureReceipt,
    signal?: AbortSignal,
  ): Promise<RendererSecureSnapshot> {
    return this.runOwned(
      vault,
      slot,
      receipt.operationId,
      signal,
      async (record, boundary) => {
        const transaction = record.transaction;
        if (
          !transaction ||
          transaction.operationId !== receipt.operationId ||
          transaction.revision !== receipt.revision ||
          (transaction.state !== "committed" && transaction.state !== "sealed")
        )
          throw failure("NATIVE_STORE_SUPERSEDED");
        if (transaction.state === "committed") {
          await this.assertAuthority(vault, slot, transaction.authority);
          const validateLifetime = () => {
            const now = this.now();
            if (!Number.isSafeInteger(now))
              throw failure("NATIVE_STORE_INVALID_CLOCK");
            if (
              now >= transaction.expiresAt ||
              transaction.expiresAt > now + PENDING_LIFETIME_MS
            )
              throw failure("NATIVE_STORE_SUPERSEDED");
          };
          validateLifetime();
          // A native payload write is not publication. The adapter repeats this
          // check before its durable pointer commit, without another await.
          boundary.beforeCommit(validateLifetime);
          record = {
            revision: randomUUID(),
            value: record.value,
            transaction: {
              ...transaction,
              state: "sealed",
              previous: null,
              proposed: null,
            },
          };
          await this.persist(vault, slot, record);
        }
        return this.snapshot(vault, slot, record);
      },
    );
  }

  rollback(
    vault: string,
    slot: RendererSecureSlot,
    receipt: RendererSecureReceipt,
  ): Promise<void> {
    return this.run(vault, slot, async (record) => {
      const transaction = record.transaction;
      if (
        !transaction ||
        transaction.operationId !== receipt.operationId ||
        transaction.revision !== receipt.revision ||
        transaction.state === "sealed"
      )
        throw failure("NATIVE_STORE_SUPERSEDED");
      if (transaction.state === "rolled-back") return;
      await this.persist(vault, slot, this.rolledBack(transaction));
    });
  }

  /** Durable cancellation fences delayed/replayed requests; already sealed values are never undone. */
  cancel(
    vault: string,
    slot: RendererSecureSlot,
    operationId: string,
  ): Promise<"cancelled" | "published" | "not-current"> {
    if (!isIdentity(operationId))
      return Promise.reject(failure("NATIVE_STORE_INVALID_INPUT"));
    return this.run(vault, slot, async (record, boundary) => {
      const transaction = record.transaction;
      if (
        transaction?.operationId === operationId &&
        transaction.state === "sealed"
      )
        return "published";
      boundary.cancelOperation(slot, operationId);
      if (transaction?.operationId !== operationId) return "not-current";
      if (transaction.state !== "rolled-back")
        await this.persist(vault, slot, this.rolledBack(transaction));
      return "cancelled";
    });
  }
}
