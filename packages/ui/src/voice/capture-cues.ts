/**
 * Audible cues for the hold-to-talk quasimode (#20483): a short rising ping
 * the instant capture opens and a softer falling tick when the utterance is
 * sent. The pair is the trust signal push-to-talk needs — the user knows the
 * mic opened (and closed) without looking at the pill, which is the whole
 * point of a no-window capture. Tones are synthesized with WebAudio so no
 * asset ships; volumes stay low because the cue confirms, it never announces.
 *
 * A cancelled hold plays nothing: cancellation must cost the user zero
 * attention. Failures are swallowed — an environment without WebAudio (or
 * with a suspended context the user never unlocked) silently skips the cue
 * rather than blocking capture.
 */

let cueContext: AudioContext | null = null;

function getCueContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!cueContext || cueContext.state === "closed") {
    try {
      cueContext = new Ctor();
    } catch {
      // error-policy:J4 no audio device / context quota — cues are optional
      return null;
    }
  }
  if (cueContext.state === "suspended") {
    // Called from a user gesture (pointerdown hold / release), so resume is
    // permitted; if the policy still blocks it the cue is skipped, not queued.
    void cueContext.resume().catch(() => undefined);
  }
  return cueContext;
}

function playTone(
  frequencies: readonly [startHz: number, endHz: number],
  durationMs: number,
  peakGain: number,
): void {
  const ctx = getCueContext();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const duration = durationMs / 1000;
    osc.type = "sine";
    osc.frequency.setValueAtTime(frequencies[0], now);
    osc.frequency.exponentialRampToValueAtTime(frequencies[1], now + duration);
    // Fast attack, exponential decay — reads as a soft "blip", not a beep.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch {
    // error-policy:J4 cue synthesis is best-effort; capture is unaffected
  }
}

/** Rising ping: the mic just opened — start talking. */
export function playCaptureStartCue(): void {
  playTone([520, 780], 140, 0.06);
}

/** Softer falling tick: the utterance was captured and is on its way. */
export function playCaptureSendCue(): void {
  playTone([660, 440], 110, 0.04);
}
