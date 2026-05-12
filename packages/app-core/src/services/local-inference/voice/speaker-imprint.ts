import type { VoiceInputSource, VoiceSpeaker } from "./types";

export const DEFAULT_VOICE_IMPRINT_MATCH_THRESHOLD = 0.78;

export interface VoiceImprintProfile {
  id: string;
  centroidEmbedding: ArrayLike<number> | null | undefined;
  embeddingModel?: string | null;
  sampleCount?: number | null;
  confidence?: number | null;
  label?: string | null;
  displayName?: string | null;
  entityId?: string | null;
  sourceKind?: string | null;
  sourceScopeId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface VoiceImprintMatch {
  profile: VoiceImprintProfile;
  similarity: number;
  confidence: number;
}

export interface VoiceImprintCentroidUpdate {
  centroidEmbedding: number[];
  sampleCount: number;
  confidence: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function normalizeVoiceEmbedding(
  embedding: ArrayLike<number>,
): number[] {
  let sumSq = 0;
  const out = new Array<number>(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) {
    const value = Number(embedding[i]);
    if (!Number.isFinite(value)) {
      throw new Error(`[voice-imprint] embedding contains non-finite value at ${i}`);
    }
    out[i] = value;
    sumSq += value * value;
  }
  if (sumSq === 0) return out;
  const invNorm = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < out.length; i += 1) out[i] *= invNorm;
  return out;
}

export function cosineSimilarity(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): number {
  if (left.length !== right.length) {
    throw new Error(
      `[voice-imprint] embedding dimension mismatch: ${left.length} != ${right.length}`,
    );
  }
  const a = normalizeVoiceEmbedding(left);
  const b = normalizeVoiceEmbedding(right);
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

export function updateVoiceImprintCentroid(args: {
  centroidEmbedding?: ArrayLike<number> | null;
  sampleCount?: number | null;
  confidence?: number | null;
  observationEmbedding: ArrayLike<number>;
  observationConfidence?: number | null;
  maxObservationWeight?: number;
}): VoiceImprintCentroidUpdate {
  const observation = normalizeVoiceEmbedding(args.observationEmbedding);
  const previousCount = Math.max(0, Math.floor(args.sampleCount ?? 0));
  const observationWeight = clamp01(
    Math.min(args.maxObservationWeight ?? 1, args.observationConfidence ?? 1),
  );
  if (!args.centroidEmbedding || previousCount === 0) {
    return {
      centroidEmbedding: observation,
      sampleCount: 1,
      confidence: observationWeight,
    };
  }
  if (args.centroidEmbedding.length !== observation.length) {
    throw new Error(
      `[voice-imprint] cannot update ${args.centroidEmbedding.length}-dim centroid with ${observation.length}-dim observation`,
    );
  }
  const centroid = normalizeVoiceEmbedding(args.centroidEmbedding);
  const historicalWeight = Math.max(1, previousCount);
  const updated = centroid.map(
    (value, i) => value * historicalWeight + observation[i] * observationWeight,
  );
  return {
    centroidEmbedding: normalizeVoiceEmbedding(updated),
    sampleCount: previousCount + 1,
    confidence: clamp01(
      ((args.confidence ?? 0) * previousCount + observationWeight) /
        (previousCount + 1),
    ),
  };
}

export function matchVoiceImprint(args: {
  embedding: ArrayLike<number>;
  profiles: readonly VoiceImprintProfile[];
  embeddingModel?: string | null;
  threshold?: number;
}): VoiceImprintMatch | null {
  const threshold = args.threshold ?? DEFAULT_VOICE_IMPRINT_MATCH_THRESHOLD;
  let best: VoiceImprintMatch | null = null;
  for (const profile of args.profiles) {
    if (!profile.centroidEmbedding || profile.centroidEmbedding.length === 0) {
      continue;
    }
    if (
      args.embeddingModel &&
      profile.embeddingModel &&
      args.embeddingModel !== profile.embeddingModel
    ) {
      continue;
    }
    if (profile.centroidEmbedding.length !== args.embedding.length) {
      continue;
    }
    const similarity = cosineSimilarity(args.embedding, profile.centroidEmbedding);
    if (similarity < threshold) continue;
    const confidence = clamp01(
      ((similarity - threshold) / Math.max(0.0001, 1 - threshold)) *
        clamp01(profile.confidence ?? 1),
    );
    if (!best || similarity > best.similarity) {
      best = { profile, similarity, confidence };
    }
  }
  return best;
}

export function voiceSpeakerFromImprintMatch(args: {
  match: VoiceImprintMatch;
  source?: VoiceInputSource;
  observationId?: string;
}): VoiceSpeaker {
  const { profile } = args.match;
  return {
    id: profile.entityId ?? profile.id,
    label: profile.label ?? undefined,
    displayName: profile.displayName ?? profile.label ?? undefined,
    source: args.source,
    imprintClusterId: profile.id,
    imprintObservationId: args.observationId,
    entityId: profile.entityId ?? undefined,
    confidence: args.match.confidence,
    metadata: {
      ...(profile.metadata ?? {}),
      matchSimilarity: args.match.similarity,
      embeddingModel: profile.embeddingModel ?? undefined,
    },
  };
}
