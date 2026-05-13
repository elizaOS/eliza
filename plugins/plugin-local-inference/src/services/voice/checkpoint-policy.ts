/**
 * Voice checkpoint policy — thin VAD-event → checkpoint-op translator that
 * sits between the voice loop (turn-controller / pipeline / vad) and the
 * `GatedCheckpointManager` (`../checkpoint-manager.ts`).
 *
 * Why a separate policy module?
 *
 *   - The constraint envelope on this scaffold explicitly forbids editing
 *     `turn-controller.ts`, `pipeline.ts`, `pipeline-impls.ts`, `vad.ts`,
 *     `scheduler.ts`, `phrase-chunker.ts`, `barge-in.ts`, `transcriber.ts`,
 *     and anything under `voice/kokoro/` / `voice/streaming-asr/`. Those
 *     files are owned by other agents.
 *   - But the upstream merge for `--ctx-checkpoints` lands "any week now,"
 *     and the JS-side rollback policy is what the merge unlocks. So the
 *     policy lives here as a free-standing module that the turn controller
 *     can pick up in a follow-up PR by injecting it into its VAD handler
 *     and calling `onSpeechPause` / `onSpeechResume` / `onSpeechEndCommit`
 *     / `onHardStop` at the matching transitions.
 *   - The wiring required in `turn-controller.ts` is documented in the
 *     `WIRING-INSTRUCTIONS` comment at the bottom of this file and in
 *     `docs/eliza-1-ctx-checkpoints-integration.md`. We intentionally do
 *     NOT apply the wiring here — that is a follow-up PR scoped to the
 *     turn-controller owner.
 *
 * Policy summary (one C1 per turn, named `pre-speculative-T<turnId>`):
 *
 *   - `onSpeechPause(turnId)` — VAD reports the user stopped speaking but
 *     hangover hasn't elapsed. Save C1 and let the caller kick the
 *     speculative drafter. If the save fails the policy logs and continues
 *     (callers MUST treat speculative work as best-effort).
 *
 *   - `onSpeechResume(turnId)` — VAD fires `speech-active` within the
 *     rollback window. If we previously kicked a speculative draft (the
 *     caller flips `speculativeFired=true` to tell us), restore C1 so the
 *     KV state is rolled back to the pre-draft point. Otherwise no-op.
 *
 *   - `onSpeechEndCommit(turnId)` — VAD's hangover elapsed; the pause was a
 *     real turn boundary. The speculative draft is promoted. Erase C1: we
 *     no longer need a rollback target for this turn.
 *
 *   - `onHardStop(turnId)` — caller-initiated cancellation (e.g. user
 *     pressed mute, app backgrounded). If C1 exists, prefer restoring to
 *     it so the KV cache is in a known-clean state for the next turn; if
 *     C1 isn't around, fall back to `cancel` (the gated manager will
 *     either issue `DELETE /slots/<id>` or invoke the SSE-disconnect
 *     callback depending on the gate).
 *
 * All four hooks are idempotent and survive a missing C1 by no-op'ing.
 * Errors from the underlying manager are caught and reported through the
 * `events.onError` sink — the policy NEVER throws back into the voice
 * loop, because a failing checkpoint endpoint must not be able to break
 * audio.
 *
 * The policy holds no state of its own beyond the per-turn name; the
 * `GatedCheckpointManager` owns the registry, the REST client, and the
 * capability cache.
 *
 * --- WIRING-INSTRUCTIONS (turn-controller.ts) -----------------------------
 *
 * The turn-controller owner adds (after the upstream merge lands):
 *
 *   1. Construct a `GatedCheckpointManager` once at session start and
 *      pass it into a `CheckpointPolicy` instance (one per slot).
 *   2. In the VAD `speech-pause` handler, immediately after the pause
 *      hangover timer is armed:
 *
 *          await policy.onSpeechPause(this.turnId, this.slotId);
 *          // ...kick speculative drafter against the partial transcript
 *
 *   3. In the VAD `speech-active` handler (only when arriving within the
 *      rollback window — the controller already tracks this):
 *
 *          await policy.onSpeechResume(this.turnId, this.slotId, {
 *            speculativeFired: this.speculativeFired,
 *          });
 *          // ...abort the speculative drafter
 *
 *   4. In the `speech-end` → SPEAKING transition (after the verifier
 *      promotes the draft):
 *
 *          await policy.onSpeechEndCommit(this.turnId, this.slotId);
 *
 *   5. In the `dispose()` path and any other hard-stop site (mute, app
 *      background, error shutdown, barge-in mid-SPEAKING):
 *
 *          await policy.onHardStop(this.turnId, this.slotId, () => {
 *            this.speculativeAbort?.abort();  // SSE-disconnect callback
 *          });
 *
 *   6. Feature flag: pass `useCtxCheckpoints` through to the
 *      `GatedCheckpointManager` constructor; when off the policy still
 *      runs but every call is a logged no-op.
 *
 * The turn-controller must NOT call `mgr.save/restore/erase/cancel`
 * directly — those names are reserved for the policy so the gated/no-op
 * branching stays in one place. The `policy.events.onError` sink lets the
 * controller forward checkpoint failures into its existing voice-loop
 * telemetry without coupling to the REST error type.
 */

import { logger } from "@elizaos/core";
import type {
  CheckpointHandle,
  GatedCheckpointManager,
  SseDisconnectFn,
} from "../checkpoint-manager";

/**
 * Errors are surfaced through this sink rather than rethrown. The voice
 * loop wires it into its existing telemetry; tests assert on it directly.
 */
export interface CheckpointPolicyEvents {
  onError?(
    op: "save" | "restore" | "erase" | "cancel",
    error: unknown,
    turnId: string,
  ): void;
  /**
   * Called after a successful save so callers can record the handle in
   * their per-turn state if they want to bypass the name-based lookup on
   * the matching restore.
   */
  onSaved?(turnId: string, handle: CheckpointHandle): void;
  /** Called after a successful restore. */
  onRestored?(turnId: string, handle: CheckpointHandle): void;
  /** Called when the policy decides to no-op (registry miss, gate off). */
  onNoop?(
    op: "save" | "restore" | "erase" | "cancel",
    turnId: string,
    reason: "gate-off" | "registry-miss" | "no-speculative",
  ): void;
}

export interface CheckpointPolicyOptions {
  /** Gated manager. Owned by the caller; one per session. */
  manager: GatedCheckpointManager;
  /** Events sink (errors + observability). Optional. */
  events?: CheckpointPolicyEvents;
}

/** Optional second arg to `onSpeechResume` so the policy knows whether
 * a speculative draft actually fired. When `false`, the resume is a no-op
 * (no draft means nothing to roll back).
 */
export interface SpeechResumeContext {
  speculativeFired: boolean;
}

/**
 * Voice checkpoint policy. Stateless w.r.t. checkpoints (the manager owns
 * the registry) — only holds the manager + event sink. One instance per
 * voice session is enough; the `turnId` argument scopes each operation.
 */
export class CheckpointPolicy {
  private readonly manager: GatedCheckpointManager;
  private readonly events: CheckpointPolicyEvents;

  constructor(opts: CheckpointPolicyOptions) {
    this.manager = opts.manager;
    this.events = opts.events ?? {};
  }

  /**
   * VAD `speech-pause`. Save C1. Caller kicks the speculative drafter on
   * its own — the policy doesn't care; it just guarantees the rollback
   * target exists.
   */
  async onSpeechPause(turnId: string, slotId: number): Promise<void> {
    const name = checkpointNameFor(turnId);
    if (!this.manager.isFeatureFlagOn()) {
      this.events.onNoop?.("save", turnId, "gate-off");
      logger.debug(
        `[checkpoint-policy] onSpeechPause(${turnId}) — gate off, skipping save`,
      );
      return;
    }
    try {
      const handle = await this.manager.save(slotId, name);
      if (handle === null) {
        // Gate flipped on but capability check declined — manager logs.
        this.events.onNoop?.("save", turnId, "gate-off");
        return;
      }
      this.events.onSaved?.(turnId, handle);
    } catch (error) {
      this.events.onError?.("save", error, turnId);
      logger.warn(
        { error, turnId, slotId },
        "[checkpoint-policy] save failed; speculative draft will run without rollback target",
      );
    }
  }

  /**
   * VAD `speech-active` within the rollback window. Restore C1 ONLY if
   * the caller actually kicked a speculative draft — otherwise the KV
   * state hasn't been mutated and we'd be doing a needless REST round
   * trip.
   */
  async onSpeechResume(
    turnId: string,
    slotId: number,
    ctx: SpeechResumeContext,
  ): Promise<void> {
    if (!ctx.speculativeFired) {
      this.events.onNoop?.("restore", turnId, "no-speculative");
      logger.debug(
        `[checkpoint-policy] onSpeechResume(${turnId}) — no speculative draft fired; skipping restore`,
      );
      return;
    }
    const name = checkpointNameFor(turnId);
    if (!this.manager.isFeatureFlagOn()) {
      this.events.onNoop?.("restore", turnId, "gate-off");
      logger.debug(
        `[checkpoint-policy] onSpeechResume(${turnId}) — gate off, skipping restore`,
      );
      return;
    }
    try {
      const ok = await this.manager.restore(slotId, name);
      if (!ok) {
        this.events.onNoop?.("restore", turnId, "registry-miss");
        logger.warn(
          { turnId, slotId, name },
          "[checkpoint-policy] restore returned false (handle not found / expired); KV cache may be dirty until next pause",
        );
        return;
      }
      const handle = this.manager.getNamedHandle(name);
      if (handle) this.events.onRestored?.(turnId, handle);
    } catch (error) {
      this.events.onError?.("restore", error, turnId);
      logger.warn(
        { error, turnId, slotId },
        "[checkpoint-policy] restore failed; KV cache may contain speculative writes",
      );
    }
  }

  /**
   * VAD's hangover elapsed → real turn boundary. Speculative draft is
   * being promoted, so C1 is no longer needed. Erase frees the registry
   * slot (the server-side LRU handles its own eviction independently).
   */
  async onSpeechEndCommit(turnId: string, slotId: number): Promise<void> {
    const name = checkpointNameFor(turnId);
    if (!this.manager.isFeatureFlagOn()) {
      this.events.onNoop?.("erase", turnId, "gate-off");
      logger.debug(
        `[checkpoint-policy] onSpeechEndCommit(${turnId}) — gate off, skipping erase`,
      );
      return;
    }
    try {
      await this.manager.erase(slotId, name);
    } catch (error) {
      this.events.onError?.("erase", error, turnId);
      logger.warn(
        { error, turnId, slotId },
        "[checkpoint-policy] erase failed; registry entry remains until TTL eviction",
      );
    }
  }

  /**
   * Hard-stop: caller-initiated cancellation. Prefer rolling back to C1
   * (clean KV state for the next turn) when available, else cancel any
   * in-flight decode on the slot. `sseDisconnect` is the existing voice-
   * loop abort hook — required because the gated manager falls back to
   * it when the REST endpoints aren't available.
   */
  async onHardStop(
    turnId: string,
    slotId: number,
    sseDisconnect: SseDisconnectFn,
  ): Promise<void> {
    const name = checkpointNameFor(turnId);
    if (!this.manager.isFeatureFlagOn()) {
      sseDisconnect(slotId);
      this.events.onNoop?.("cancel", turnId, "gate-off");
      return;
    }
    const existing = this.manager.getNamedHandle(name);
    if (existing) {
      try {
        const ok = await this.manager.restore(slotId, name);
        if (ok) {
          this.events.onRestored?.(turnId, existing);
        }
        // Also erase: the registry slot serves no further purpose after
        // a hard stop, and leaving it pinned through TTL eviction is
        // wasteful.
        try {
          await this.manager.erase(slotId, name);
        } catch (eraseError) {
          this.events.onError?.("erase", eraseError, turnId);
        }
        return;
      } catch (error) {
        this.events.onError?.("restore", error, turnId);
        logger.warn(
          { error, turnId, slotId },
          "[checkpoint-policy] hard-stop restore failed; falling back to cancel",
        );
      }
    }
    try {
      await this.manager.cancel(slotId, sseDisconnect);
    } catch (error) {
      this.events.onError?.("cancel", error, turnId);
      logger.warn(
        { error, turnId, slotId },
        "[checkpoint-policy] cancel failed; voice loop SSE-disconnect already invoked",
      );
    }
  }
}

/**
 * Per-turn checkpoint name. Keeps the namespace stable so a hard-stop
 * after a normal commit doesn't collide with the next turn's C1.
 *
 * The format is the only thing callers outside the policy ever see —
 * `GatedCheckpointManager.getNamedHandle('pre-speculative-T123')` returns
 * the same handle the policy used. Keep it stable; if the format changes
 * in a future PR, audit every consumer of `getNamedHandle`.
 */
export function checkpointNameFor(turnId: string): string {
  // The gated manager's REST filename validation allows
  // `[A-Za-z0-9._-]`, and turn ids in the voice loop are short integer
  // strings. Sanitize defensively for the (unlikely) future where turn
  // ids carry colons or slashes.
  const safe = turnId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `pre-speculative-T${safe}`;
}
