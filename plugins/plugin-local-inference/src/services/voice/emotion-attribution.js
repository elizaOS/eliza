import { asrEmotionToTag, EXPRESSIVE_EMOTION_TAGS, enumToEmotion, parseExpressiveTags, } from "./expressive-tags";
const TEXT_WEIGHTS = [
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
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(1, value));
}
function emptyScores() {
    return Object.fromEntries(EXPRESSIVE_EMOTION_TAGS.map((emotion) => [emotion, 0]));
}
function addScore(scores, emotion, amount) {
    scores[emotion] = clamp01(scores[emotion] + amount);
}
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9'\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
}
function wordCount(text) {
    return tokenize(text).length;
}
function audioSpeechRateWpm(text, audio) {
    if (audio?.speechRateWpm !== undefined)
        return audio.speechRateWpm;
    if (!audio?.durationMs || audio.durationMs <= 0)
        return null;
    return (wordCount(text) / (audio.durationMs / 1000)) * 60;
}
function selectBest(scores) {
    let best = {
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
export function attributeVoiceEmotion(input) {
    const text = [input.text, input.asr?.transcript].filter(Boolean).join(" ");
    const parsed = parseExpressiveTags(text);
    const scores = emptyScores();
    const evidence = [];
    // (1) Acoustic-model read — Wav2Small (or equivalent) is the strongest
    // single signal when present. We weight it on the classifier's own
    // confidence so a low-mass continuous read does not dominate the lexicon
    // (the projection table itself abstains under `confidence < 0.35`).
    const modelOutput = input.model?.output;
    if (modelOutput?.emotion) {
        const w = clamp01(modelOutput.confidence) * 0.92;
        if (w > 0) {
            addScore(scores, modelOutput.emotion, w);
            evidence.push({
                source: "acoustic_model",
                detail: `${input.model?.modelId ?? modelOutput.modelId} → ${modelOutput.emotion} (${roundEvidence(modelOutput.confidence)})`,
                confidence: roundEvidence(w),
            });
        }
        // Also propagate the soft scores so the discrete label is not the only
        // thing the projection has agreed with — small contribution per class
        // keeps the per-class mass coherent across consumers.
        for (const tag of EXPRESSIVE_EMOTION_TAGS) {
            const score = clamp01(modelOutput.scores[tag] ?? 0);
            if (score > 0.05 && tag !== modelOutput.emotion) {
                addScore(scores, tag, score * 0.18);
            }
        }
    }
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
        }
        else {
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
        if (matches.length === 0)
            continue;
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
            addScore(scores, scores.angry >= scores.excited ? "angry" : "excited", 0.28);
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
        }
        else if ((audio.rms ?? 0) <= 0.06 && (speechRateWpm ?? 120) <= 95) {
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
    const vad = modelOutput?.vad;
    const best = selectBest(scores);
    if (!best.emotion || best.score < 0.18) {
        return {
            emotion: null,
            confidence: 0,
            method: "none",
            modelNativeEmotion: false,
            evidence,
            scores,
            ...(vad ? { vad } : {}),
        };
    }
    // Fusion-rule method derivation — single deterministic order so consumers
    // reading `.method` get the same answer regardless of evidence shape. The
    // acoustic-model methods win over text-only methods when the acoustic
    // signal contributed to the winning class.
    const hasAcoustic = evidence.some((row) => row.source === "acoustic_model");
    const hasTextual = evidence.some((row) => row.source === "text_expressive_tag" ||
        row.source === "text_lexicon" ||
        row.source === "asr_transcript");
    let method;
    if (hasAcoustic && hasTextual) {
        method = "acoustic_text_fused";
    }
    else if (hasAcoustic) {
        method = "acoustic_model";
    }
    else if (evidence.some((row) => row.source === "text_expressive_tag")) {
        method = "text_tag";
    }
    else if (evidence.some((row) => row.source === "asr_emotion_metadata")) {
        method = "explicit_asr_metadata";
    }
    else {
        method = "text_audio_heuristic";
    }
    return {
        emotion: best.emotion,
        confidence: clamp01(best.score),
        method,
        modelNativeEmotion: false,
        evidence,
        scores,
        ...(vad ? { vad } : {}),
    };
}
function roundEvidence(value) {
    return Math.round(value * 1000) / 1000;
}
//# sourceMappingURL=emotion-attribution.js.map