/**
 * Optimistic prefill client — POSTs to a forthcoming `/v1/prefill` endpoint
 * that runs a no-sample forward pass over a partial transcript and snapshots
 * the resulting KV state so a subsequent generation can resume from there
 * without re-running the prefill.
 *
 * The endpoint does not yet exist upstream — the fork PR that adds it is
 * tracked alongside the `--ctx-checkpoints` REST endpoints in
 * `docs/eliza-1-optimistic-rollback.md`. Until then, this module emulates
 * the contract via the existing `CheckpointClient` slot-save path: it
 * assumes the caller has already prefilled the slot via the standard
 * `/v1/chat/completions` no-decode call, then issues a `saveCheckpoint`.
 * When the upstream endpoint lands, the body of `prefillOptimistic`
 * switches to a single REST call — callers see no signature change.
 *
 *   TODO(upstream-fork-PR-#TBD): swap the body of `prefillOptimistic` for
 *   a single `POST /v1/prefill { slotId, partialText, eotProb }` call.
 *   The endpoint must:
 *     1. Run the model's prefill over `partialText` against `slotId`.
 *     2. Save a checkpoint of the resulting KV state.
 *     3. Return `{ handle, eotProb }` — `eotProb` lets the caller decide
 *        whether to kick the drafter or wait for more audio.
 *   Tracking issue: github.com/elizaOS/eliza/issues/TBD (fill in once
 *   the upstream PR is opened).
 */

import type {
  CheckpointHandle,
  CheckpointManagerLike,
} from "./checkpoint-manager";

/**
 * Input contract for the optimistic prefill call. `partialText` is the
 * current partial transcript; `eotProb` is the caller's estimate that the
 * user has stopped speaking (typically derived from VAD hangover progress).
 */
export interface PrefillOptimisticArgs {
  /** Slot id pinning this conversation. */
  slotId: string;
  /** Partial transcript to prefill against. Non-empty. */
  partialText: string;
  /**
   * Probability the partial is end-of-turn (0..1). Today this is recorded
   * only as telemetry; once `/v1/prefill` lands the server will use it to
   * decide whether to also kick the drafter inline.
   */
  eotProb: number;
}

export interface PrefillOptimisticResult {
  /** Checkpoint handle to pass to `CheckpointManager.restoreCheckpoint`. */
  handle: CheckpointHandle;
  /**
   * Server-reported end-of-turn probability. Today this is the value the
   * caller passed in (the server has nothing to refine it with); once the
   * upstream endpoint lands, the server returns its own model estimate.
   */
  eotProb: number;
  /**
   * Backend label so callers can route around stub-only deployments. Today
   * always `slot-save-stub`; will become `prefill-v1` once upstream lands.
   */
  backend: "slot-save-stub" | "prefill-v1";
}

export interface PrefillOptimisticOptions {
  checkpointManager: CheckpointManagerLike;
  /**
   * Optional name to associate with the snapshot. Defaults to
   * `pre-prefill`. Useful when callers want to checkpoint multiple
   * intermediate prefills (e.g. multi-segment dictation).
   */
  checkpointName?: string;
}

const DEFAULT_CHECKPOINT_NAME = "pre-prefill";

/**
 * Run the optimistic prefill. Returns a handle the caller passes to
 * `CheckpointManager.restoreCheckpoint` on rollback.
 *
 * Today (pre-upstream-merge) the function only takes a checkpoint of the
 * current slot state — the caller is responsible for having already issued
 * the prefill via the regular chat/completions HTTP path. Once
 * `POST /v1/prefill` lands, the body switches to a single REST call.
 */
export async function prefillOptimistic(
  args: PrefillOptimisticArgs,
  opts: PrefillOptimisticOptions,
): Promise<PrefillOptimisticResult> {
  assertPartialText(args.partialText);
  assertEotProb(args.eotProb);
  const name = opts.checkpointName ?? DEFAULT_CHECKPOINT_NAME;
  // TODO(upstream-fork-PR-#TBD): replace this with a single POST to
  // `/v1/prefill { slotId, partialText, eotProb }`. Until then, take a
  // slot-save checkpoint and trust the caller to have prefilled the slot.
  const handle = await opts.checkpointManager.saveCheckpoint(args.slotId, name);
  return {
    handle,
    eotProb: args.eotProb,
    backend: "slot-save-stub",
  };
}

function assertPartialText(s: string): void {
  if (typeof s !== "string" || s.trim().length === 0) {
    throw new TypeError(
      `[prefill-client] partialText must be a non-empty string (got ${JSON.stringify(s)})`,
    );
  }
}

function assertEotProb(p: number): void {
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new TypeError(
      `[prefill-client] eotProb must be a finite number in [0, 1] (got ${p})`,
    );
  }
}
