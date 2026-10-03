/**
 * verification.ts — honest scoring for a three-agent dialogue run.
 *
 * A run is SCORED only when every turn exercised the real pipeline (real TTS
 * audio + real ASR transcription). Any synthetic turn (sine-wave TTS fallback
 * or missing ASR) demotes the run to `synthetic-smoke`: structural checks
 * (audio produced, non-blank, distinct speakers) still run, but the
 * transcript and emotion axes are skipped-with-report and the run never
 * counts as a scored pass unless smoke was explicitly requested.
 */

export type RunMode = "real" | "synthetic-smoke";

/** Per-turn outcome facts collected by the runner. */
export interface TurnOutcome {
  turnIdx: number;
  speaker: string;
  /** Ground-truth prompt text from the scenario. */
  gtText: string;
  /** Real ASR transcription of the TTS audio; null when no real ASR ran. */
  asrText: string | null;
  /** True when the audio came from the real TTS provider (not sine-wave). */
  ttsReal: boolean;
  /** True when asrText came from a real transcription call. */
  asrReal: boolean;
  /** Emotion detected from the real ASR text; null when no real ASR ran. */
  detectedEmotion: string | null;
  expectedEmotion: string;
}

export interface VerificationThresholds {
  minNonEmptyTranscripts: number;
  minAudioDurationSec: number;
  minDistinctSpeakers: number;
  emotionDetectedMinFraction: number;
}

export interface VerificationResult {
  /** "real" only when every turn used real TTS + real ASR. */
  mode: RunMode;
  /** True when the run is eligible for benchmark scoring. */
  scored: boolean;
  realTurns: number;
  syntheticTurns: number;
  transcriptNotNull: boolean;
  audioNotBlank: boolean;
  distinctSpeakersDetected: number;
  emotionsDetected: number;
  emotionDetectedFraction: number;
  turnsTaken: number;
  durationSec: number;
  pass: boolean;
  failures: string[];
  /** Checks that could not run because the pipeline was synthetic. */
  skippedChecks: string[];
}

// ---------------------------------------------------------------------------
// Text-level emotion heuristic. Applied to REAL ASR output only, so the axis
// requires the full TTS → ASR round trip; it is never fed the ground-truth
// prompt (which would make the check a tautology).
// ---------------------------------------------------------------------------

const EMOTION_KEYWORDS: Record<string, string[]> = {
  joy: [
    "excited",
    "wonderful",
    "love",
    "great",
    "happy",
    "touched",
    "warmth",
    "enjoy",
  ],
  sadness: ["gently", "held", "sad", "hurt", "empathy", "care"],
  anger: ["frustrated", "angry", "wrong", "unfair"],
  surprise: ["actually", "shifted", "concede", "unexpected", "wait"],
  curiosity: [
    "think",
    "question",
    "wonder",
    "interesting",
    "explore",
    "consider",
  ],
  neutral: [],
};

export function detectEmotionFromText(text: string): string {
  const lower = text.toLowerCase();
  for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
    if (emotion === "neutral") continue;
    if (keywords.some((kw) => lower.includes(kw))) return emotion;
  }
  return "neutral";
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function computeVerification(args: {
  turns: TurnOutcome[];
  thresholds: VerificationThresholds;
  mixDurationSec: number;
  mixNonBlank: boolean;
  distinctSpeakers: number;
  /** True when the caller explicitly requested a smoke run. */
  smokeRequested: boolean;
}): VerificationResult {
  const {
    turns,
    thresholds,
    mixDurationSec,
    mixNonBlank,
    distinctSpeakers,
    smokeRequested,
  } = args;

  const syntheticTurns = turns.filter((t) => !(t.ttsReal && t.asrReal)).length;
  const realTurns = turns.length - syntheticTurns;
  const mode: RunMode =
    turns.length > 0 && syntheticTurns === 0 ? "real" : "synthetic-smoke";
  const scored = mode === "real";

  const failures: string[] = [];
  const skippedChecks: string[] = [];

  // --- Structural checks (always run) ---
  if (!mixNonBlank) {
    failures.push("mix.wav is blank (RMS below noise floor or empty)");
  }
  if (mixDurationSec < thresholds.minAudioDurationSec) {
    failures.push(
      `audio duration ${mixDurationSec.toFixed(2)}s < min ${thresholds.minAudioDurationSec}s`,
    );
  }
  if (distinctSpeakers < thresholds.minDistinctSpeakers) {
    failures.push(
      `distinct speakers: got ${distinctSpeakers}, need ≥ ${thresholds.minDistinctSpeakers}`,
    );
  }

  // --- Scored checks (real ASR/TTS required) ---
  const realTranscripts = turns.filter(
    (t) =>
      t.asrReal && typeof t.asrText === "string" && t.asrText.trim().length > 0,
  ).length;
  const emotionsDetected = turns.filter(
    (t) => t.detectedEmotion !== null,
  ).length;
  const emotionFraction =
    turns.length > 0 ? emotionsDetected / turns.length : 0;

  const transcriptNotNull =
    scored && realTranscripts >= thresholds.minNonEmptyTranscripts;

  if (scored) {
    if (realTranscripts < thresholds.minNonEmptyTranscripts) {
      failures.push(
        `real ASR transcripts: got ${realTranscripts}, need ≥ ${thresholds.minNonEmptyTranscripts}`,
      );
    }
    if (emotionFraction < thresholds.emotionDetectedMinFraction) {
      failures.push(
        `emotion detected fraction ${(emotionFraction * 100).toFixed(0)}% < ` +
          `${(thresholds.emotionDetectedMinFraction * 100).toFixed(0)}% threshold`,
      );
    }
  } else {
    skippedChecks.push(
      "transcripts (requires real ASR — synthetic turns present)",
      "emotion (requires real ASR — synthetic turns present)",
    );
    if (!smokeRequested) {
      failures.push(
        `synthetic TTS/ASR path used on ${syntheticTurns}/${turns.length} turns — ` +
          "full runs are scored only with real GROQ TTS+ASR; set GROQ_API_KEY " +
          "or run with --smoke for an unscored structural smoke",
      );
    }
  }

  return {
    mode,
    scored,
    realTurns,
    syntheticTurns,
    transcriptNotNull,
    audioNotBlank:
      mixNonBlank && mixDurationSec >= thresholds.minAudioDurationSec,
    distinctSpeakersDetected: distinctSpeakers,
    emotionsDetected,
    emotionDetectedFraction: Math.round(emotionFraction * 100) / 100,
    turnsTaken: turns.length,
    durationSec: Math.round(mixDurationSec * 100) / 100,
    pass: failures.length === 0,
    failures,
    skippedChecks,
  };
}
