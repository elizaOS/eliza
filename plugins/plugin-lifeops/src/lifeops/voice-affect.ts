export type VoiceAffectConsentState =
  | "none"
  | "ephemeral_only"
  | "persist_features";

export type VoiceAffectRetentionPolicy =
  | { kind: "ephemeral" }
  | { kind: "ttl"; expiresAt: string };

export type VoiceAffectPolicyDecision =
  | { effect: "allow"; reason: string }
  | { effect: "deny"; reason: string }
  | { effect: "require_approval"; reason: string };

export type VoiceAffectFeatures = {
  pauseDurationsMs?: number[];
  falseStartCount?: number;
  speechRateWpm?: number;
  pitchVarianceHz?: number;
  volumeVarianceDb?: number;
  transcriptUncertaintyTokenCount?: number;
  transcriptTokenCount?: number;
};

export type VoiceAffectInput = {
  utteranceId: string;
  messageId: string;
  capturedAt: string;
  consent: VoiceAffectConsentState;
  retention: VoiceAffectRetentionPolicy;
  features: VoiceAffectFeatures & Record<string, unknown>;
  policyDecision?: VoiceAffectPolicyDecision;
};

export type VoiceAffectScores = {
  hesitance: number;
  uncertainty: number;
  urgency: number;
};

export type VoiceAffectAnalysis = {
  eventType: "voice_affect_event";
  utteranceId: string;
  messageId: string;
  capturedAt: string;
  scores: VoiceAffectScores;
  confidence: number;
  labels: Array<"hesitant" | "uncertain" | "urgent">;
  degradedReasons: string[];
  withheldReasons: string[];
};

export type VoiceAffectDurableRecord =
  | {
      status: "persistable";
      event: VoiceAffectAnalysis & {
        retention: Extract<VoiceAffectRetentionPolicy, { kind: "ttl" }>;
      };
    }
  | {
      status: "withheld";
      reasons: string[];
      event: VoiceAffectAnalysis;
    };

export type VoiceAffectPlannerSlice = {
  utteranceId: string;
  messageId: string;
  capturedAt: string;
  labels: VoiceAffectAnalysis["labels"];
  scores: VoiceAffectScores;
  confidence: number;
  degradedReasons: string[];
};

const RAW_AUDIO_KEYS = new Set([
  "audio",
  "audioBlob",
  "audioData",
  "base64Audio",
  "buffer",
  "pcm",
  "rawAudio",
  "samples",
  "waveform",
]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("voice affect score input must be finite");
  }
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function normalizeIsoTimestamp(value: string, field: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid ISO timestamp`);
  }
  return date.toISOString();
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function assertNoRawAudio(features: Record<string, unknown>): void {
  for (const key of Object.keys(features)) {
    if (RAW_AUDIO_KEYS.has(key)) {
      throw new Error(
        `voice affect features must not include raw audio key: ${key}`,
      );
    }
  }
}

function finiteNonNegative(value: unknown, field: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeFeatures(features: VoiceAffectInput["features"]): {
  pauseMeanMs: number | null;
  pauseMaxMs: number | null;
  falseStartCount: number | null;
  speechRateWpm: number | null;
  pitchVarianceHz: number | null;
  volumeVarianceDb: number | null;
  uncertaintyTokenRatio: number | null;
  featureCount: number;
} {
  assertNoRawAudio(features);

  const pauseDurationsMs = features.pauseDurationsMs ?? [];
  if (!Array.isArray(pauseDurationsMs)) {
    throw new Error("pauseDurationsMs must be an array");
  }
  for (const [index, pause] of pauseDurationsMs.entries()) {
    finiteNonNegative(pause, `pauseDurationsMs[${index}]`);
  }

  const falseStartCount = finiteNonNegative(
    features.falseStartCount,
    "falseStartCount",
  );
  const speechRateWpm = finiteNonNegative(
    features.speechRateWpm,
    "speechRateWpm",
  );
  const pitchVarianceHz = finiteNonNegative(
    features.pitchVarianceHz,
    "pitchVarianceHz",
  );
  const volumeVarianceDb = finiteNonNegative(
    features.volumeVarianceDb,
    "volumeVarianceDb",
  );
  const transcriptUncertaintyTokenCount = finiteNonNegative(
    features.transcriptUncertaintyTokenCount,
    "transcriptUncertaintyTokenCount",
  );
  const transcriptTokenCount = finiteNonNegative(
    features.transcriptTokenCount,
    "transcriptTokenCount",
  );

  const uncertaintyTokenRatio =
    transcriptUncertaintyTokenCount === null || transcriptTokenCount === null
      ? null
      : transcriptTokenCount === 0
        ? 0
        : transcriptUncertaintyTokenCount / transcriptTokenCount;

  const present = [
    pauseDurationsMs.length > 0,
    falseStartCount !== null,
    speechRateWpm !== null,
    pitchVarianceHz !== null,
    volumeVarianceDb !== null,
    uncertaintyTokenRatio !== null,
  ].filter(Boolean).length;

  return {
    pauseMeanMs: average(pauseDurationsMs),
    pauseMaxMs:
      pauseDurationsMs.length === 0 ? null : Math.max(...pauseDurationsMs),
    falseStartCount,
    speechRateWpm,
    pitchVarianceHz,
    volumeVarianceDb,
    uncertaintyTokenRatio,
    featureCount: present,
  };
}

function scoreFromFeatures(features: ReturnType<typeof normalizeFeatures>): {
  scores: VoiceAffectScores;
  confidence: number;
  degradedReasons: string[];
} {
  const pauseSignal =
    features.pauseMaxMs === null ? 0 : features.pauseMaxMs / 2400;
  const falseStartSignal =
    features.falseStartCount === null ? 0 : features.falseStartCount / 4;
  const slowRateSignal =
    features.speechRateWpm === null
      ? 0
      : features.speechRateWpm < 115
        ? (115 - features.speechRateWpm) / 70
        : 0;
  const fastRateSignal =
    features.speechRateWpm === null
      ? 0
      : features.speechRateWpm > 170
        ? (features.speechRateWpm - 170) / 90
        : 0;
  const uncertaintySignal =
    features.uncertaintyTokenRatio === null
      ? 0
      : features.uncertaintyTokenRatio / 0.22;
  const pitchSignal =
    features.pitchVarianceHz === null ? 0 : features.pitchVarianceHz / 90;
  const volumeSignal =
    features.volumeVarianceDb === null ? 0 : features.volumeVarianceDb / 14;

  const hesitance = roundScore(
    pauseSignal * 0.34 +
      falseStartSignal * 0.28 +
      slowRateSignal * 0.18 +
      uncertaintySignal * 0.2,
  );
  const uncertainty = roundScore(
    uncertaintySignal * 0.46 +
      falseStartSignal * 0.2 +
      pauseSignal * 0.2 +
      slowRateSignal * 0.14,
  );
  const urgency = roundScore(
    fastRateSignal * 0.42 + volumeSignal * 0.34 + pitchSignal * 0.24,
  );

  const degradedReasons: string[] = [];
  if (features.featureCount === 0) {
    degradedReasons.push("no_affect_features");
  }
  if (
    features.featureCount <= 2 &&
    features.uncertaintyTokenRatio !== null &&
    features.pauseMeanMs === null &&
    features.pitchVarianceHz === null &&
    features.volumeVarianceDb === null
  ) {
    degradedReasons.push("transcript_only");
  }

  let confidence = 0.22 + features.featureCount * 0.12;
  const hesitantButNotUrgent = hesitance > 0.55 && urgency < 0.35;
  const urgentButNotHesitant = urgency > 0.55 && hesitance < 0.35;
  if (hesitance > 0.5 && urgency > 0.5) {
    confidence -= 0.18;
    degradedReasons.push("mixed_affect_signals");
  } else if (hesitantButNotUrgent || urgentButNotHesitant) {
    confidence += 0.08;
  }
  if (degradedReasons.includes("transcript_only")) {
    confidence = Math.min(confidence, 0.55);
  }
  if (degradedReasons.includes("no_affect_features")) {
    confidence = Math.min(confidence, 0.25);
  }

  return {
    scores: { hesitance, uncertainty, urgency },
    confidence: roundScore(confidence),
    degradedReasons,
  };
}

function labelsForScores(
  scores: VoiceAffectScores,
): VoiceAffectAnalysis["labels"] {
  const labels: VoiceAffectAnalysis["labels"] = [];
  if (scores.hesitance >= 0.5) {
    labels.push("hesitant");
  }
  if (scores.uncertainty >= 0.5) {
    labels.push("uncertain");
  }
  if (scores.urgency >= 0.5) {
    labels.push("urgent");
  }
  return labels;
}

export class VoiceAffectService {
  analyze(input: VoiceAffectInput): VoiceAffectAnalysis {
    assertNonEmpty(input.utteranceId, "utteranceId");
    assertNonEmpty(input.messageId, "messageId");
    const capturedAt = normalizeIsoTimestamp(input.capturedAt, "capturedAt");

    if (
      !["none", "ephemeral_only", "persist_features"].includes(input.consent)
    ) {
      throw new Error("consent must be a known voice affect consent state");
    }

    const features = normalizeFeatures(input.features);
    const scored = scoreFromFeatures(features);
    const withheldReasons: string[] = [];

    if (input.consent === "none") {
      withheldReasons.push("voice_affect_consent_not_granted");
    }
    if (input.policyDecision?.effect === "deny") {
      withheldReasons.push(`policy_denied:${input.policyDecision.reason}`);
    }
    if (input.policyDecision?.effect === "require_approval") {
      withheldReasons.push(
        `policy_requires_approval:${input.policyDecision.reason}`,
      );
    }

    return {
      eventType: "voice_affect_event",
      utteranceId: input.utteranceId.trim(),
      messageId: input.messageId.trim(),
      capturedAt,
      scores: scored.scores,
      confidence: scored.confidence,
      labels: labelsForScores(scored.scores),
      degradedReasons: scored.degradedReasons,
      withheldReasons,
    };
  }

  buildDurableRecord(input: VoiceAffectInput): VoiceAffectDurableRecord {
    const event = this.analyze(input);
    const reasons = [...event.withheldReasons];

    if (input.consent !== "persist_features") {
      reasons.push("durable_storage_requires_persist_features_consent");
    }
    if (input.retention.kind !== "ttl") {
      reasons.push("durable_storage_requires_ttl_retention");
    } else {
      const expiresAt = normalizeIsoTimestamp(
        input.retention.expiresAt,
        "retention.expiresAt",
      );
      if (
        new Date(expiresAt).getTime() <= new Date(event.capturedAt).getTime()
      ) {
        reasons.push("retention_expired");
      }
    }

    if (reasons.length > 0 || input.retention.kind !== "ttl") {
      return { status: "withheld", reasons: [...new Set(reasons)], event };
    }

    return {
      status: "persistable",
      event: {
        ...event,
        retention: {
          kind: "ttl",
          expiresAt: normalizeIsoTimestamp(
            input.retention.expiresAt,
            "retention.expiresAt",
          ),
        },
      },
    };
  }

  toPlannerSlice(analysis: VoiceAffectAnalysis): VoiceAffectPlannerSlice {
    return {
      utteranceId: analysis.utteranceId,
      messageId: analysis.messageId,
      capturedAt: analysis.capturedAt,
      labels: analysis.labels,
      scores: analysis.scores,
      confidence: analysis.confidence,
      degradedReasons: analysis.degradedReasons,
    };
  }
}

export const voiceAffectService = new VoiceAffectService();
