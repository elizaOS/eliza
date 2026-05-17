/**
 * Canonical voice cancellation token.
 *
 * Wave 3 W3-9 — one token per voice turn, fanned out to every layer that can
 * cancel: VAD start-of-speech (barge-in), turn-detector EOT revocation,
 * planner-loop / message-handler yield points, DflashLlamaServer slot abort,
 * TTS playback. Built on top of `AbortController` so any consumer that
 * already understands `AbortSignal` (fetch / FFI / model calls) gets cancel
 * for free.
 *
 * Invariants:
 *   - One token per `runId` (one utterance).
 *   - `abort()` is idempotent. The first reason wins; subsequent calls are
 *     no-ops.
 *   - `signal.aborted === true` after the first `abort()`.
 *   - Token is forward-compatible with the legacy `BargeInCancelToken`
 *     shape (`cancelled`, `reason`, `signal`) so existing voice pipeline
 *     consumers can adopt the canonical type without a wider refactor.
 *
 * This file deliberately has no runtime imports (no `@elizaos/core`, no
 * voice-engine imports). It is the bottom of the cancellation stack — every
 * layer above (runtime, plugin, app) imports this type, never the reverse.
 */

/** Why a voice turn was cancelled. Stable enum — telemetry depends on it. */
export type VoiceCancellationReason =
  | "barge-in"
  | "eot-revoked"
  | "user-cancel"
  | "timeout"
  | "external";

/**
 * Listener fired exactly once when the token transitions from active →
 * aborted. Listeners added after abort fire synchronously with the recorded
 * reason.
 */
export type VoiceCancellationListener = (
  reason: VoiceCancellationReason,
) => void;

/**
 * Per-turn cancellation handle. Carries a stable `runId`, the optional slot
 * id the LM is running against (for slot-abort), and a standard `AbortSignal`
 * for fetch / model layers.
 */
export interface VoiceCancellationToken {
  /** Stable per-utterance id. Mirrors the voice state machine's turn id. */
  readonly runId: string;
  /**
   * The DflashLlamaServer slot the optimistic LM is running on, when known.
   * `abort()` fans this out to the slot-abort path on the inference server.
   */
  readonly slot?: number;
  /** True once `abort()` has fired. Cheap polling field. */
  readonly aborted: boolean;
  /** Set when `abort()` fires; null while active. */
  readonly reason: VoiceCancellationReason | null;
  /** Standard `AbortSignal` for fetch / model / FFI consumers. */
  readonly signal: AbortSignal;
  /**
   * Trip the token. Idempotent. First call wins; subsequent calls are
   * no-ops. Fires every registered `onAbort` listener synchronously.
   */
  abort(reason: VoiceCancellationReason): void;
  /**
   * Subscribe to abort. Returns an unsubscribe function. Listeners
   * registered after the token has aborted fire synchronously with the
   * recorded reason.
   */
  onAbort(listener: VoiceCancellationListener): () => void;
}

export interface CreateVoiceCancellationTokenOptions {
  runId: string;
  slot?: number;
  /**
   * Optional pre-existing `AbortSignal` to also honor. When this signal
   * aborts (e.g. the runtime's per-turn signal from
   * `TurnControllerRegistry`), the voice token aborts with reason
   * `"external"` so the voice loop sees the runtime abort.
   */
  linkSignal?: AbortSignal;
}

interface InternalState {
  aborted: boolean;
  reason: VoiceCancellationReason | null;
}

/**
 * Construct a fresh voice cancellation token.
 *
 * Implementation note: a single `AbortController` backs the public `signal`.
 * Listener bookkeeping lives next to the controller (rather than via the
 * `AbortSignal`'s native `addEventListener`) because we want to:
 *   1. Guarantee listeners fire even when the abort was triggered by a
 *      linked signal (the native `addEventListener` path also works, but
 *      this is cheaper and gives us synchronous semantics for
 *      after-abort `onAbort` registrations).
 *   2. Surface the `reason` enum, not a raw `DOMException` from the
 *      AbortSignal.
 */
export function createVoiceCancellationToken(
  opts: CreateVoiceCancellationTokenOptions,
): VoiceCancellationToken {
  const controller = new AbortController();
  const listeners = new Set<VoiceCancellationListener>();
  const state: InternalState = { aborted: false, reason: null };

  const trip = (reason: VoiceCancellationReason): void => {
    if (state.aborted) return;
    state.aborted = true;
    state.reason = reason;
    // Call listeners BEFORE aborting the controller so a listener that
    // itself awaits the signal sees the same reason this token recorded
    // (otherwise listeners that observe `signal.aborted` could race).
    for (const listener of Array.from(listeners)) {
      try {
        listener(reason);
      } catch {
        // Listener errors are swallowed; telemetry should not affect
        // cancellation propagation.
      }
    }
    controller.abort();
  };

  if (opts.linkSignal) {
    if (opts.linkSignal.aborted) {
      trip("external");
    } else {
      const onLinkAbort = () => trip("external");
      opts.linkSignal.addEventListener("abort", onLinkAbort, { once: true });
    }
  }

  const token: VoiceCancellationToken = {
    runId: opts.runId,
    ...(opts.slot !== undefined ? { slot: opts.slot } : {}),
    get aborted() {
      return state.aborted;
    },
    get reason() {
      return state.reason;
    },
    signal: controller.signal,
    abort(reason: VoiceCancellationReason) {
      trip(reason);
    },
    onAbort(listener: VoiceCancellationListener) {
      if (state.aborted) {
        // Synchronous after-abort fan-out. Caller may still want the
        // hook even though the token already aborted — fire once.
        const reason = state.reason ?? "external";
        try {
          listener(reason);
        } catch {
          // see above
        }
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return token;
}

/**
 * Already-aborted token. Useful as a zero-cost default for code paths that
 * have no live voice session but still want to type-thread a token through.
 * The `runId` is the empty string — callers that depend on a stable id must
 * pass their own.
 */
export function createAbortedVoiceCancellationToken(
  reason: VoiceCancellationReason = "external",
): VoiceCancellationToken {
  const t = createVoiceCancellationToken({ runId: "" });
  t.abort(reason);
  return t;
}

/**
 * Per-room registry. Keeps the active voice token for each `roomId` so
 * unrelated layers (the message handler, an HTTP route, the audio sink)
 * can fetch the live token without holding a reference. Mirrors the shape
 * of `TurnControllerRegistry` in `@elizaos/core/runtime/turn-controller`.
 */
export class VoiceCancellationRegistry {
  private readonly byRoom = new Map<string, VoiceCancellationToken>();

  /**
   * Replace the active token for `roomId`. The previous token (if any) is
   * aborted with `"external"` so any orphaned background work cleans up.
   * Returns the new token.
   */
  arm(
    roomId: string,
    opts: CreateVoiceCancellationTokenOptions,
  ): VoiceCancellationToken {
    const previous = this.byRoom.get(roomId);
    if (previous && !previous.aborted) {
      previous.abort("external");
    }
    const token = createVoiceCancellationToken(opts);
    this.byRoom.set(roomId, token);
    // Self-clean: when the token aborts, drop it from the map IF it is
    // still the active one. (Tokens that have been replaced via a later
    // `arm()` will already be evicted.)
    token.onAbort(() => {
      if (this.byRoom.get(roomId) === token) {
        this.byRoom.delete(roomId);
      }
    });
    return token;
  }

  /** Fetch the active token for `roomId`, or null. */
  current(roomId: string): VoiceCancellationToken | null {
    return this.byRoom.get(roomId) ?? null;
  }

  /**
   * Abort the active token for `roomId`. Returns true if a live token was
   * aborted. No-op when there is no active token or it's already aborted.
   */
  abort(roomId: string, reason: VoiceCancellationReason): boolean {
    const token = this.byRoom.get(roomId);
    if (!token || token.aborted) return false;
    token.abort(reason);
    return true;
  }

  /**
   * Abort every active token. Used by lifecycle shutdown (the runtime's
   * `abortInflightInference` hook fires this so the voice loop drops in
   * sync with the runtime).
   */
  abortAll(reason: VoiceCancellationReason): string[] {
    const aborted: string[] = [];
    for (const [roomId, token] of Array.from(this.byRoom.entries())) {
      if (!token.aborted) {
        token.abort(reason);
        aborted.push(roomId);
      }
    }
    return aborted;
  }

  /** Snapshot of live room ids. Diagnostic. */
  activeRoomIds(): string[] {
    return Array.from(this.byRoom.keys()).filter((roomId) => {
      const token = this.byRoom.get(roomId);
      return token !== undefined && !token.aborted;
    });
  }

  /** Test seam: drop everything. */
  clear(): void {
    this.byRoom.clear();
  }
}
