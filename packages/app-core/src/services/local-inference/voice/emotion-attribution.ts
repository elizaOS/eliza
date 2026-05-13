import {
  asrEmotionToTag,
  EXPRESSIVE_EMOTION_TAGS,
  type ExpressiveEmotion,
  enumToEmotion,
  parseExpressiveTags,
} from "./expressive-tags";

export type VoiceEmotionAttributionMethod =
  | "none"
  | "text_tag"
  | "text_audio_heuristic"
  | "explicit_asr_metadata";

export interface VoiceEmotionAudioFeatures {
  durationMs?: number;
  rms?: number;
  zeroCrossingRate?: number;
  speechRateWpm?: number;
  meanPitchHz?: number;
  pitchStdHz?: number;
}

export interface VoiceEmotionAsrFeatures {
  transcript?: string;
  confidence?: number;
  /**
   * Optional structured metadata supplied by an ASR service. The local fused
   * ASR path does not currently advertise model-native emotion labels, so this
   * is ignored unless `emotionLabelSupported` is explicitly true.
   */
  emotionLabel?: string | null;
  emotionLabelSupported?: boolean;
}

export interface VoiceEmotionAttributionInput {
  text?: string;
  asr?: VoiceEmotionAsrFeatures;
  audio?: VoiceEmotionAudioFeatures;
}

export interface VoiceEmotionEvidence {
  source:
    | "text_expressive_tag"
    | "text_lexicon"
    | "audio_prosody"
    | "asr_transcript"
    | "asr_emotion_metadata"
    | "asr_emotion_metadata_ignored";
  detail: string;
  confidence: number;
}

export interface VoiceEmotionAttribution {
  emotion: ExpressiveEmotion | null;
  confidence: number;
  method: VoiceEmotionAttributionMethod;
  modelNativeEmotion: false;
  evidence: VoiceEmotionEvidence[];
  scores: Record<ExpressiveEmotion, number>;
}

const TEXT_WEIGHTS: ReadonlyArray<{
  emotion: ExpressiveEmotion;
  words: readonly string[];
  weight: number;
}> = [
  {
    emotion: "happy",
    words: ["happy", "glad", "great", "thanks", "love", "delighted"],
    weight: 0.3,
  },
  {
    emotion: "excited",
    words: ["excited", "amazing", "wow", "urgent", "huge", "yes"],
    weight: 0.32,
  },
  {
    emotion: "sad",
    words: ["sad", "sorry", "miss", "tired", "hurt", "lonely"],
    weight: 0.34,
  },
  {
    emotion: "angry",
    words: ["angry", "mad", "furious", "annoyed", "unacceptable", "stop"],
    weight: 0.36,
  },
  {
    emotion: "nervous",
    words: ["nervous", "worried", "afraid", "scared", "anxious", "maybe"],
    weight: 0.34,
  },
  {
    emotion: "calm",
    words: ["calm", "okay", "steady", "fine", "breathe", "settled"],
    weight: 0.25,
  },
  {
    emotion: "whisper",
    words: ["quietly", "whisper", "softly"],
    weight: 0.3,
  },
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function emptyScores(): Record<ExpressiveEmotion, number> {
  return Object.fromEntries(
    EXPRESSIVE_EMOTION_TAGS.map((emotion) => [emotion, 0]),
  ) as Record<ExpressiveEmotion, number>;
}

function addScore(
  scores: Record<ExpressiveEmotion, number>,
  emotion: ExpressiveEmotion,
  amount: number,
): void {
  scores[emotion] = clamp01(scores[emotion] + amount);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function wordCount(text: string): number {
  return tokenize(text).length;
}

function audioSpeechRateWpm(
  text: string,
  audio?: VoiceEmotionAudioFeatures,
): number | null {
  if (audio?.speechRateWpm !== undefined) return audio.speechRateWpm;
  if (!audio?.durationMs || audio.durationMs <= 0) return null;
  return (wordCount(text) / (audio.durationMs / 1000)) * 60;
}

function selectBest(scores: Record<ExpressiveEmotion, number>): {
  emotion: ExpressiveEmotion | null;
  score: number;
} {
  let best: { emotion: ExpressiveEmotion | null; score: number } = {
    emotion: null,
    score: 0,
  };
  for (const emotion of EXPRESSIVE_EMOTION_TAGS) {
    if (scores[emotion] > best.score) {
      best = { emotion, score: scores[emotion] };
    }
  }
  return best;
}

export function attributeVoiceEmotion(
  input: VoiceEmotionAttributionInput,
): VoiceEmotionAttribution {
  const text = [input.text, input.asr?.transcript].filter(Boolean).join(" ");
  const parsed = parseExpressiveTags(text);
  const scores = emptyScores();
  const evidence: VoiceEmotionEvidence[] = [];

  if (parsed.dominantEmotion) {
    addScore(scores, parsed.dominantEmotion, 0.88);
    evidence.push({
      source: "text_expressive_tag",
      detail: `[${parsed.dominantEmotion}]`,
      confidence: 0.88,
    });
  }

  const asrLabel = input.asr?.emotionLabel;
  if (asrLabel) {
    const mapped = asrEmotionToTag(asrLabel) ?? enumToEmotion(asrLabel);
    if (input.asr?.emotionLabelSupported === true && mapped) {
      addScore(scores, mapped, 0.72);
      evidence.push({
        source: "asr_emotion_metadata",
        detail: asrLabel,
        confidence: 0.72,
      });
    } else {
      evidence.push({
        source: "asr_emotion_metadata_ignored",
        detail: asrLabel,
        confidence: 0,
      });
    }
  }

  const words = new Set(tokenize(text));
  for (const row of TEXT_WEIGHTS) {
    const matches = row.words.filter((word) => words.has(word));
    if (matches.length === 0) continue;
    const amount = Math.min(0.55, row.weight + (matches.length - 1) * 0.08);
    addScore(scores, row.emotion, amount);
    evidence.push({
      source: input.asr?.transcript ? "asr_transcript" : "text_lexicon",
      detail: `${row.emotion}: ${matches.join(",")}`,
      confidence: roundEvidence(amount),
    });
  }

  const audio = input.audio;
  if (audio) {
    const speechRateWpm = audioSpeechRateWpm(text, audio);
    if ((audio.rms ?? 0) >= 0.18 && (speechRateWpm ?? 0) >= 165) {
      addScore(
        scores,
        scores.angry >= scores.excited ? "angry" : "excited",
        0.28,
      );
      evidence.push({
        source: "audio_prosody",
        detail: "high energy and fast speech",
        confidence: 0.28,
      });
    }
    if ((audio.rms ?? 0) <= 0.045 && (audio.zeroCrossingRate ?? 0) >= 0.14) {
      addScore(scores, "whisper", 0.38);
      evidence.push({
        source: "audio_prosody",
        detail: "low energy with high zero-crossing rate",
        confidence: 0.38,
      });
    } else if ((audio.rms ?? 0) <= 0.06 && (speechRateWpm ?? 120) <= 95) {
      addScore(scores, "sad", 0.22);
      evidence.push({
        source: "audio_prosody",
        detail: "low energy and slow speech",
        confidence: 0.22,
      });
    }
    if ((audio.pitchStdHz ?? 0) <= 18 && (audio.rms ?? 0) <= 0.1) {
      addScore(scores, "calm", 0.2);
      evidence.push({
        source: "audio_prosody",
        detail: "stable pitch and restrained energy",
        confidence: 0.2,
      });
    }
  }

  const best = selectBest(scores);
  if (!best.emotion || best.score < 0.18) {
    return {
      emotion: null,
      confidence: 0,
      method: "none",
      modelNativeEmotion: false,
      evidence,
      scores,
    };
  }

  const method = evidence.some((row) => row.source === "text_expressive_tag")
    ? "text_tag"
    : evidence.some((row) => row.source === "asr_emotion_metadata")
      ? "explicit_asr_metadata"
      : "text_audio_heuristic";

  return {
    emotion: best.emotion,
    confidence: clamp01(best.score),
    method,
    modelNativeEmotion: false,
    evidence,
    scores,
  };
}

function roundEvidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}
