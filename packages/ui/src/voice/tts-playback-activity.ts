/**
 * Renderer-wide TTS playback-activity signal — the first (cheapest) layer of
 * the echo defense (#12256): while the agent's TTS is playing, and for a short
 * cooldown after it ends, the always-on capture raises its speech thresholds
 * so the agent's own tail can't self-trigger an ASR submission.
 *
 * The playback-frame pump sessions (playback-frame-pump.ts) bracket real
 * audible playback on the local-inference/cloud paths, so they mark this
 * signal on start/stop; the local ASR capture's auto-stop detector reads it.
 * All timestamps are in the renderer's `performance.now()` domain. Pure
 * module state, no DOM.
 */

/** Post-TTS cooldown window (ms) during which the raised gate stays on —
 * the `VOICE_WORKBENCH.md` half-duplex recommendation. The server side reads
 * `ELIZA_VOICE_POST_TTS_COOLDOWN_MS`; the renderer uses this default. */
export const DEFAULT_POST_TTS_COOLDOWN_MS = 1500;

function nowMsDefault(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

let activePlaybackSessions = 0;
let lastPlaybackEndedAtMs: number | null = null;

/** A TTS playback session began rendering audio. */
export function markTtsPlaybackStarted(): void {
  activePlaybackSessions += 1;
}

/** A TTS playback session finished (or was interrupted). */
export function markTtsPlaybackEnded(nowMs = nowMsDefault()): void {
  activePlaybackSessions = Math.max(0, activePlaybackSessions - 1);
  lastPlaybackEndedAtMs = nowMs;
}

/**
 * True while TTS playback is active, or within `cooldownMs` after the last
 * playback ended — the window in which the capture side must demand louder
 * (closer) speech before starting an ASR submission. Barge-in still works:
 * the gate raises thresholds, it never mutes.
 */
export function isTtsEchoGateActive(
  nowMs = nowMsDefault(),
  cooldownMs = DEFAULT_POST_TTS_COOLDOWN_MS,
): boolean {
  if (activePlaybackSessions > 0) return true;
  return (
    lastPlaybackEndedAtMs !== null &&
    nowMs - lastPlaybackEndedAtMs <= cooldownMs
  );
}

/** Clear all playback-activity state. Test-only. */
export function __resetTtsPlaybackActivityForTest(): void {
  activePlaybackSessions = 0;
  lastPlaybackEndedAtMs = null;
}
