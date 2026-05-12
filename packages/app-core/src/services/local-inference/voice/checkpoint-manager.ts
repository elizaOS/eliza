/**
 * CheckpointManager — high-level slot-agnostic KV-cache checkpoint primitive
 * used by the voice state machine (`voice-state-machine.ts`) to implement the
 * optimistic-rollback path described in `docs/eliza-1-optimistic-rollback.md`.
 *
 * Why a manager on top of `CheckpointClient`?
 *
 *   - `CheckpointClient` (in `dflash-checkpoint-client.ts`) is a thin REST
 *     adapter. It is keyed by `(slotId, filename)` because that is what the
 *     fork's `POST /slots/<id>/save?filename=<n>` REST API expects.
 *   - Callers (the voice state machine, voice-bench drivers) don't want to
 *     mint filenames, track active handles, or know about the upstream URL
 *     scheme. They want `save("pre-draft") → handle`, `restore(handle)`,
 *     `discard(handle)` and an in-memory mock for unit tests.
 *   - When the upstream llama.cpp merge lands and `/v1/checkpoint/save`
 *     becomes the canonical endpoint, only this file changes — the voice
 *     state machine keeps the same public interface (`saveCheckpoint`,
 *     `restoreCheckpoint`, `discardCheckpoint`). The `CheckpointHandle` is
 *     opaque from the caller's perspective; only this module reads its
 *     fields.
 *
 * The handle returned from `saveCheckpoint` carries enough information to
 * `restore` and `discard` the same snapshot later even after the underlying
 * URL scheme changes. Today it points at `(slotId, filename)`; tomorrow it
 * will point at the v1 checkpoint id the upstream API returns.
 *
 * **MockCheckpointManager** stores a caller-supplied snapshot (token sequence
 * + arbitrary metadata) in memory keyed by the handle. Tests use it to drive
 * the voice state machine deterministically without spinning up a real
 * llama-server.
 */

import {
  CheckpointClient,
  type CheckpointFetch,
  type CheckpointHandle as RestCheckpointHandle,
} from "../dflash-checkpoint-client";

/**
 * Opaque-to-callers handle returned by `saveCheckpoint`. The fields are
 * exposed so tests can assert on them but callers should treat the handle
 * as an opaque blob.
 */
export interface CheckpointHandle {
  /**
   * Caller-supplied conversation/turn-scoped slot id. Maps onto the REST
   * `slotId` today; on v1 it maps onto the upstream checkpoint-server's
   * session id.
   */
  slotId: string;
  /**
   * Human-readable name passed to `saveCheckpoint`. Used as part of the
   * REST filename today (`C1-<slotId>-<name>`).
   */
  name: string;
  /**
   * Monotonically increasing per-manager id. Lets tests assert that two
   * checkpoints from the same `(slotId, name)` are distinct.
   */
  id: number;
  /** ISO timestamp of the save call. */
  createdAt: string;
  /**
   * Backend-specific reference. For the REST-backed manager this is the
   * `CheckpointClient` handle (`{slotId: number, filename: string,
   * createdAt: string}`). For the mock manager this is `null` (the mock
   * is keyed by the handle's `id` field).
   */
  readonly backendRef: RestCheckpointHandle | null;
}

/**
 * Common interface implemented by both `CheckpointManager` (REST-backed)
 * and `MockCheckpointManager` (in-memory). The voice state machine accepts
 * this interface so tests can substitute the mock.
 */
export interface CheckpointManagerLike {
  /**
   * Snapshot the slot's KV state. Returns a handle the caller passes back
   * to `restoreCheckpoint` / `discardCheckpoint`. Each call returns a new
   * handle; identical `(slotId, name)` pairs do NOT alias.
   */
  saveCheckpoint(slotId: string, name: string): Promise<CheckpointHandle>;
  /**
   * Restore a previously-saved snapshot. After `restore`, the handle is
   * still valid — the same checkpoint can be restored again (e.g. for two
   * consecutive barge-ins against the same C1).
   */
  restoreCheckpoint(handle: CheckpointHandle): Promise<void>;
  /**
   * Free server-side storage for `handle`. After `discard`, the handle is
   * invalid; subsequent restore/discard calls reject with
   * `CheckpointHandleInvalidError`.
   */
  discardCheckpoint(handle: CheckpointHandle): Promise<void>;
}

/**
 * Raised when a caller passes a handle that this manager did not create,
 * or that has already been `discardCheckpoint`-ed. Distinct from REST
 * errors (which surface as `CheckpointHttpError` from the client).
 */
export class CheckpointHandleInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointHandleInvalidError";
  }
}

/* ------------------------------------------------------------------------ *
 * REST-backed manager (production path)
 * ------------------------------------------------------------------------ */

export interface CheckpointManagerOptions {
  /**
   * Base URL of the llama-server / llama-checkpoint-server. Same shape as
   * `CheckpointClient` — `http://host:port`.
   */
  baseUrl: string;
  /**
   * Slot-id-string → numeric slot-id mapping. The REST layer takes a
   * non-negative integer; voice callers prefer string ids that travel
   * with the conversation/turn id. Defaults to a hash of the string.
   */
  resolveSlotId?: (slotIdString: string) => number;
  /** Optional custom fetch (mostly for unit-testing the REST surface). */
  fetchImpl?: CheckpointFetch;
  /**
   * Default per-request timeout (ms). Forwarded to `CheckpointClient`. The
   * REST checkpoint REST surface is latency-critical on the restore path —
   * keep this short.
   */
  requestTimeoutMs?: number;
  /**
   * Source of monotonically increasing ids. Injected for deterministic
   * tests; defaults to a per-manager counter.
   */
  now?: () => Date;
}

const REST_FILENAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * REST-backed `CheckpointManager`. Wraps `CheckpointClient` and exposes
 * the slot-agnostic save/restore/discard contract. The class is stateful
 * only in so far as it tracks which handles are still live so a double-
 * `discard` is detected; the actual snapshot lives in llama-server's
 * `--slot-save-path` directory.
 */
export class CheckpointManager implements CheckpointManagerLike {
  private readonly client: CheckpointClient;
  private readonly resolveSlotId: (slotIdString: string) => number;
  private readonly now: () => Date;
  private nextId = 1;
  private readonly live = new Set<number>();

  constructor(opts: CheckpointManagerOptions) {
    this.client = new CheckpointClient({
      baseUrl: opts.baseUrl,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: opts.requestTimeoutMs }
        : {}),
    });
    this.resolveSlotId = opts.resolveSlotId ?? defaultResolveSlotId;
    this.now = opts.now ?? (() => new Date());
  }

  async saveCheckpoint(
    slotId: string,
    name: string,
  ): Promise<CheckpointHandle> {
    assertSlotIdString(slotId);
    assertCheckpointName(name);
    const numericSlot = this.resolveSlotId(slotId);
    const id = this.nextId++;
    const filename = restFilenameFor(slotId, name, id);
    // TODO(upstream-fork-PR-#TBD): when llama.cpp's `/v1/checkpoint/save`
    // endpoint lands (tracked in `docs/eliza-1-optimistic-rollback.md`),
    // switch this to the new checkpoint-id-based REST call. Public
    // interface stays the same — only `backendRef` changes shape.
    const backendRef = await this.client.saveCheckpoint(numericSlot, filename);
    this.live.add(id);
    return {
      slotId,
      name,
      id,
      createdAt: this.now().toISOString(),
      backendRef,
    };
  }

  async restoreCheckpoint(handle: CheckpointHandle): Promise<void> {
    this.assertLive(handle);
    if (!handle.backendRef) {
      throw new CheckpointHandleInvalidError(
        `[checkpoint-manager] handle id=${handle.id} has no REST backend reference (mock-only handle?)`,
      );
    }
    // TODO(upstream-fork-PR-#TBD): swap for `/v1/checkpoint/restore` once
    // upstream lands. The handle already carries the upstream id via
    // `backendRef`.
    await this.client.restoreCheckpoint(
      handle.backendRef.slotId,
      handle.backendRef.filename,
    );
  }

  async discardCheckpoint(handle: CheckpointHandle): Promise<void> {
    this.assertLive(handle);
    this.live.delete(handle.id);
    // Upstream slot-save doesn't expose a per-file delete today. The
    // server evicts on slot reuse and on `--slot-save-path` directory
    // sweep (see `CacheBridge.sweepStale`), so a dangling file is bounded.
    // We DO need to cancel any in-flight decode on the slot, though, so
    // a `discard` after a speculative draft properly aborts. When the
    // upstream merge lands, replace with `DELETE /v1/checkpoint/<id>`.
    if (handle.backendRef) {
      await this.client.cancelSlot(handle.backendRef.slotId);
    }
  }

  /**
   * Probe the underlying llama-server for checkpoint support. Forwarded
   * from `CheckpointClient.probeSupported`. Callers gate the feature flag
   * on this.
   */
  async probeSupported(signal?: AbortSignal): Promise<boolean> {
    return this.client.probeSupported(signal);
  }

  private assertLive(handle: CheckpointHandle): void {
    if (!this.live.has(handle.id)) {
      throw new CheckpointHandleInvalidError(
        `[checkpoint-manager] handle id=${handle.id} (slotId=${handle.slotId}, name=${handle.name}) is not live (already discarded or never saved by this manager)`,
      );
    }
  }
}

/* ------------------------------------------------------------------------ *
 * MockCheckpointManager (test path)
 * ------------------------------------------------------------------------ */

/**
 * Caller-supplied snapshot the mock stores against a handle. The voice
 * state machine tests use this to record the token sequence at the
 * `speech-pause` instant and assert that a barge-in restores the same
 * sequence.
 */
export interface MockCheckpointSnapshot {
  /** Token ids at the time of `saveCheckpoint`. */
  tokens: readonly number[];
  /** Free-form metadata (partial transcript, turn id, etc.). */
  metadata?: Record<string, unknown>;
}

export type MockSnapshotSource = (
  slotId: string,
  name: string,
) => MockCheckpointSnapshot;

/**
 * In-memory `CheckpointManager` for tests. Records every save / restore /
 * discard call so tests can assert on them, and stores a snapshot of the
 * token sequence keyed by handle.
 */
export class MockCheckpointManager implements CheckpointManagerLike {
  private nextId = 1;
  private readonly snapshots = new Map<number, MockCheckpointSnapshot>();
  /**
   * Operations recorded in arrival order. Useful for assertions like
   * "discard happened after restore".
   */
  readonly operations: Array<
    | { kind: "save"; slotId: string; name: string; handleId: number }
    | { kind: "restore"; handleId: number }
    | { kind: "discard"; handleId: number }
  > = [];
  /**
   * Token sequence the active "slot" most recently restored to. Lets
   * tests assert that a restore actually replayed the saved tokens.
   */
  currentTokens: readonly number[] = [];

  constructor(private readonly snapshotSource?: MockSnapshotSource) {}

  async saveCheckpoint(
    slotId: string,
    name: string,
  ): Promise<CheckpointHandle> {
    assertSlotIdString(slotId);
    assertCheckpointName(name);
    const id = this.nextId++;
    const snapshot: MockCheckpointSnapshot = this.snapshotSource
      ? this.snapshotSource(slotId, name)
      : { tokens: [...this.currentTokens] };
    this.snapshots.set(id, snapshot);
    this.operations.push({ kind: "save", slotId, name, handleId: id });
    return {
      slotId,
      name,
      id,
      createdAt: new Date(0).toISOString(),
      backendRef: null,
    };
  }

  async restoreCheckpoint(handle: CheckpointHandle): Promise<void> {
    const snapshot = this.snapshots.get(handle.id);
    if (!snapshot) {
      throw new CheckpointHandleInvalidError(
        `[mock-checkpoint-manager] handle id=${handle.id} not found (already discarded or never saved by this mock)`,
      );
    }
    this.currentTokens = [...snapshot.tokens];
    this.operations.push({ kind: "restore", handleId: handle.id });
  }

  async discardCheckpoint(handle: CheckpointHandle): Promise<void> {
    if (!this.snapshots.has(handle.id)) {
      throw new CheckpointHandleInvalidError(
        `[mock-checkpoint-manager] handle id=${handle.id} not found (already discarded or never saved by this mock)`,
      );
    }
    this.snapshots.delete(handle.id);
    this.operations.push({ kind: "discard", handleId: handle.id });
  }

  /** Live handles count — for leak assertions. */
  liveHandleCount(): number {
    return this.snapshots.size;
  }

  /** Look up the snapshot saved against `handle.id`. */
  snapshotFor(handle: CheckpointHandle): MockCheckpointSnapshot | undefined {
    return this.snapshots.get(handle.id);
  }
}

/* ------------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------------ */

const SLOT_ID_STRING_RE = /^[A-Za-z0-9._:-]+$/;

function assertSlotIdString(slotId: string): void {
  if (typeof slotId !== "string" || slotId.length === 0 || slotId.length > 128) {
    throw new TypeError(
      `[checkpoint-manager] invalid slotId: ${JSON.stringify(slotId)} (1-128 chars required)`,
    );
  }
  if (!SLOT_ID_STRING_RE.test(slotId)) {
    throw new TypeError(
      `[checkpoint-manager] invalid slotId: ${JSON.stringify(slotId)} (allowed chars: A-Z a-z 0-9 . _ - :)`,
    );
  }
}

const CHECKPOINT_NAME_RE = /^[A-Za-z0-9._-]+$/;

function assertCheckpointName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.length > 64) {
    throw new TypeError(
      `[checkpoint-manager] invalid checkpoint name: ${JSON.stringify(name)} (1-64 chars required)`,
    );
  }
  if (!CHECKPOINT_NAME_RE.test(name)) {
    throw new TypeError(
      `[checkpoint-manager] invalid checkpoint name: ${JSON.stringify(name)} (allowed chars: A-Z a-z 0-9 . _ -)`,
    );
  }
}

function restFilenameFor(slotId: string, name: string, id: number): string {
  // REST filenames may only contain `[A-Za-z0-9._-]` per
  // `CheckpointClient.assertCheckpointName`. The slot id may carry `:` for
  // structured ids (e.g. `conv:42`); normalize those to `_`.
  const safeSlot = slotId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!REST_FILENAME_RE.test(safeSlot)) {
    throw new TypeError(
      `[checkpoint-manager] could not normalize slotId ${JSON.stringify(slotId)} to a REST-safe filename component`,
    );
  }
  return `C1-${safeSlot}-${name}-${id.toString(36)}`;
}

/**
 * Default `slotIdString → numeric slot` mapping. Uses a stable 31-bit
 * hash so the same conversation id always lands on the same numeric slot.
 * Callers that own a real slot allocator should pass their own
 * `resolveSlotId` instead.
 */
function defaultResolveSlotId(slotIdString: string): number {
  let hash = 0;
  for (let i = 0; i < slotIdString.length; i++) {
    hash = ((hash << 5) - hash + slotIdString.charCodeAt(i)) | 0;
  }
  // Coerce to a non-negative integer below the typical llama-server `--parallel`
  // count. Callers with more than 256 parallel slots should supply their own
  // resolver.
  return Math.abs(hash) % 256;
}
