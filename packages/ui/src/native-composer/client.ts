/**
 * The renderer-side composer-bridge client: the one object a native shell talks
 * to. It decodes raw operations at the boundary, folds them through the reducer,
 * emits typed {@link ComposerEvent}s back to the shell, and persists the draft +
 * idempotency ledger so state survives app backgrounding, window reload, and
 * transport reconnect.
 *
 * Durability model:
 *   - `serialize()` / `hydrate()` round-trip the draft, the processed-`opId`
 *     ledger, and the offline send queue as plain JSON. Restoring them after a
 *     reload is what makes a re-delivered operation still dedupe (idempotency)
 *     and an offline send still replay (offline recovery). The in-flight
 *     `sending` marker is intentionally NOT persisted — a reload has no live
 *     request to resume, so the send is re-driven by a fresh op or its result.
 *   - `setOnline(true)` flushes the deferred queue and reports each replay.
 *
 * The client never throws on bad native input: a malformed raw operation becomes
 * a `rejected: "invalid-input"` result (error-policy J3), so one bad frame cannot
 * tear down a live composer.
 */

import {
  decodeComposerOperation,
  decodeComposerOperationStream,
} from "./decode";
import {
  applyComposerOperation,
  type ComposerApplyContext,
  type ComposerBridgeState,
  type ComposerCapabilities,
  type ComposerLimits,
  DEFAULT_COMPOSER_CAPABILITIES,
  DEFAULT_COMPOSER_LIMITS,
  flushDeferredOperations,
  initialComposerState,
  resolveSend,
} from "./reduce";
import {
  type ComposerDraft,
  type ComposerEvent,
  type ComposerOperation,
  type DispatchResult,
  NATIVE_COMPOSER_SCHEMA,
  type NativeComposerSchema,
  type SendOutcome,
} from "./contract";

/** Plain-JSON snapshot persisted across reload; excludes the transient send. */
export interface ComposerBridgeSnapshot {
  schema: NativeComposerSchema;
  draft: ComposerDraft;
  /** The dedupe ledger, so a post-reload duplicate op still no-ops. */
  processedOpIds: string[];
  /** The offline send queue, so a deferred send still replays after reload. */
  deferred: ComposerOperation[];
}

export interface ComposerBridgeClientOptions {
  online?: boolean;
  capabilities?: ComposerCapabilities;
  limits?: ComposerLimits;
  /** Restore a prior session (idempotency + draft + offline queue). */
  snapshot?: ComposerBridgeSnapshot;
}

export interface ComposerBridgeClient {
  /** Decode + apply one raw native operation; never throws on bad input. */
  dispatchRaw(raw: unknown): DispatchResult;
  /** Decode + apply a whole `{ schema, operations }` envelope (batch replay). */
  dispatchRawStream(raw: unknown): DispatchResult[];
  /** Apply an already-decoded operation. */
  dispatchOperation(op: ComposerOperation): DispatchResult;
  /** Resolve the in-flight send and emit `send.result` + `draft.changed`. */
  completeSend(opId: string, outcome: SendOutcome): void;
  /** Toggle transport liveness; going online flushes the deferred send queue. */
  setOnline(online: boolean): void;
  getDraft(): ComposerDraft;
  getState(): ComposerBridgeState;
  /** Subscribe to events emitted toward the native shell. */
  subscribe(listener: (event: ComposerEvent) => void): () => void;
  serialize(): ComposerBridgeSnapshot;
}

/** Best-effort opId for a raw op that failed to decode (for the rejected result). */
function rawOpId(raw: unknown): string {
  if (raw && typeof raw === "object" && "opId" in raw) {
    const id = (raw as { opId: unknown }).opId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "";
}

export function createComposerBridgeClient(
  options: ComposerBridgeClientOptions = {},
): ComposerBridgeClient {
  let state = options.snapshot
    ? hydrate(options.snapshot)
    : initialComposerState();

  const ctx: ComposerApplyContext = {
    online: options.online ?? true,
    capabilities: options.capabilities ?? DEFAULT_COMPOSER_CAPABILITIES,
    limits: options.limits ?? DEFAULT_COMPOSER_LIMITS,
  };

  const listeners = new Set<(event: ComposerEvent) => void>();
  const emit = (event: ComposerEvent): void => {
    for (const listener of listeners) listener(event);
  };

  // A draft-mutating result is echoed to the shell; emit the specific side
  // events (focus/voice) so a shell that only cares about those need not diff.
  const emitFor = (op: ComposerOperation, result: DispatchResult): void => {
    if (result.status !== "applied") return;
    emit({ type: "draft.changed", draft: result.draft });
    if (op.type === "focus.set")
      emit({
        type: "focus.changed",
        focused: result.draft.focused,
        keyboard: result.draft.keyboard,
      });
    if (op.type === "voice.handoff")
      emit({ type: "voice.state", phase: op.phase });
  };

  const applyDecoded = (op: ComposerOperation): DispatchResult => {
    const step = applyComposerOperation(state, op, ctx);
    state = step.state;
    emitFor(op, step.result);
    return step.result;
  };

  return {
    dispatchRaw(raw) {
      const decoded = decodeComposerOperation(raw);
      if (!decoded.ok) {
        return {
          status: "rejected",
          opId: rawOpId(raw),
          reason: "invalid-input",
          message: decoded.error.message,
          draft: state.draft,
        };
      }
      return applyDecoded(decoded.operation);
    },
    dispatchRawStream(raw) {
      const { operations, rejected } = decodeComposerOperationStream(raw);
      const results: DispatchResult[] = [];
      // Preserve source order: rejected ops surface as invalid-input in place.
      let opIdx = 0;
      const rejectedByIndex = new Map(rejected.map((r) => [r.index, r]));
      const total = operations.length + rejected.length;
      for (let i = 0; i < total; i++) {
        const bad = rejectedByIndex.get(i);
        if (bad) {
          results.push({
            status: "rejected",
            opId: "",
            reason: "invalid-input",
            message: bad.error.message,
            draft: state.draft,
          });
        } else {
          results.push(applyDecoded(operations[opIdx++]));
        }
      }
      return results;
    },
    dispatchOperation(op) {
      return applyDecoded(op);
    },
    completeSend(opId, outcome) {
      state = resolveSend(state, opId, outcome);
      emit({ type: "send.result", opId, outcome });
      emit({ type: "draft.changed", draft: state.draft });
    },
    setOnline(online) {
      ctx.online = online;
      if (!online) return;
      const flushed = flushDeferredOperations(state, ctx);
      state = flushed.state;
      // A replayed send that applied changes nothing in the draft, but a shell
      // watching the queue wants the draft snapshot after the flush.
      if (flushed.results.some((r) => r.status === "applied"))
        emit({ type: "draft.changed", draft: state.draft });
    },
    getDraft() {
      return state.draft;
    },
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    serialize() {
      return {
        schema: NATIVE_COMPOSER_SCHEMA,
        draft: state.draft,
        processedOpIds: [...state.processed],
        deferred: state.deferred,
      };
    },
  };
}

/** Rebuild reducer state from a persisted snapshot (drops the transient send). */
function hydrate(snapshot: ComposerBridgeSnapshot): ComposerBridgeState {
  return {
    draft: snapshot.draft,
    processed: new Set(snapshot.processedOpIds),
    deferred: snapshot.deferred,
    sending: null,
  };
}
