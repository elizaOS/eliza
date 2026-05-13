import { createHash } from "node:crypto";
import type { VoiceInputSource } from "./types";

export const VOICE_PROFILE_ARTIFACT_SCHEMA_VERSION =
  "eliza.voice_profile.v1" as const;

export const VOICE_PROFILE_FEATURE_EMBEDDING_MODEL =
  "eliza-voice-profile-features-v1" as const;

export type VoiceProfileArtifactStatus = "ready" | "needs_review" | "invalid";

export interface VoiceProfileConsent {
  attribution: boolean;
  synthesis: boolean;
  grantedBy?: string;
  grantedAt?: string;
  expiresAt?: string;
  evidenceId?: string;
}

export interface VoiceProfileReferenceMetadata {
  speakerId?: string;
  label?: string;
  displayName?: string;
  referenceText?: string;
  language?: string;
  locale?: string;
  source?: VoiceInputSource;
  consent?: VoiceProfileConsent;
  metadata?: Record<string, unknown>;
}

export interface VoiceProfileSampleInput {
  id?: string;
  wavBytes: ArrayBuffer | ArrayBufferView;
  referenceText?: string;
  recordedAt?: string;
  source?: VoiceInputSource;
  metadata?: Record<string, unknown>;
}

export interface VoiceProfileAudioFeatures {
  sha256: string;
  byteLength: number;
  format: "wav/pcm_s16le";
  channels: number;
  sampleRateHz: number;
  bitsPerSample: 16;
  dataBytes: number;
  samplesPerChannel: number;
  durationMs: number;
  peakAbs: number;
  rms: number;
  zeroCrossingRate: number;
  silenceRatio: number;
}

export interface VoiceProfileArtifactSample {
  id: string;
  wavSha256: string;
  referenceText: string | null;
  recordedAt: string | null;
  source: VoiceInputSource | null;
  metadata: Record<string, unknown> | null;
  audio: VoiceProfileAudioFeatures;
  featureEmbedding: number[];
}

export interface VoiceProfileArtifact {
  schemaVersion: typeof VOICE_PROFILE_ARTIFACT_SCHEMA_VERSION;
  artifactId: string;
  embeddingModel: typeof VOICE_PROFILE_FEATURE_EMBEDDING_MODEL;
  centroidEmbedding: number[];
  sampleCount: number;
  totalDurationMs: number;
  confidence: number;
  reference: {
    speakerId: string | null;
    label: string | null;
    displayName: string | null;
    referenceText: string | null;
    language: string | null;
    locale: string | null;
    source: VoiceInputSource | null;
    consent: VoiceProfileConsent;
    metadata: Record<string, unknown> | null;
  };
  samples: VoiceProfileArtifactSample[];
  usage: {
    attributionAuthorized: boolean;
    synthesisAuthorized: boolean;
    authorizationSource: "reference_metadata";
  };
  provenance: {
    createdAt: string | null;
    deterministic: true;
    generator: "app-core.voice-profile-artifact";
  };
}

export interface VoiceProfileArtifactVerification {
  status: VoiceProfileArtifactStatus;
  artifactId: string;
  expectedArtifactId: string;
  artifactIdMatches: boolean;
  sampleCount: number;
  totalDurationMs: number;
  attributionStatus: "ready" | "missing_consent" | "invalid";
  synthesisStatus:
    | "authorized_by_metadata"
    | "not_authorized"
    | "insufficient_audio"
    | "invalid";
  issues: string[];
  samples: Array<{
    id: string;
    status: "pass" | "fail";
    issues: string[];
    wavSha256Matches?: boolean;
  }>;
}

const MIN_ATTRIBUTION_DURATION_MS = 1_000;
const MIN_SYNTHESIS_DURATION_MS = 3_000;

function toUint8Array(bytes: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readI16(bytes: Uint8Array, offset: number): number {
  const value = readU16(bytes, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizeText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return round(value, 9);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function canonicalVoiceProfileJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function normalizeVector(vector: readonly number[]): number[] {
  let sumSq = 0;
  for (const value of vector) sumSq += value * value;
  if (sumSq === 0) return vector.map(() => 0);
  const inv = 1 / Math.sqrt(sumSq);
  return vector.map((value) => round(value * inv, 9));
}

export function analyzeVoiceProfileWav(
  wavBytes: ArrayBuffer | ArrayBufferView,
): VoiceProfileAudioFeatures {
  const bytes = toUint8Array(wavBytes);
  if (bytes.byteLength < 44) {
    throw new Error("[voice-profile] WAV is too short");
  }
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("[voice-profile] expected RIFF/WAVE input");
  }

  let fmtOffset = -1;
  let fmtSize = 0;
  let dataOffset = -1;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= bytes.byteLength; ) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = readU32(bytes, offset + 4);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkSize > bytes.byteLength) {
      throw new Error(`[voice-profile] malformed WAV chunk ${chunkId}`);
    }
    if (chunkId === "fmt ") {
      fmtOffset = chunkDataOffset;
      fmtSize = chunkSize;
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }
  if (fmtOffset < 0 || fmtSize < 16) {
    throw new Error("[voice-profile] WAV is missing a PCM fmt chunk");
  }
  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error("[voice-profile] WAV is missing audio data");
  }

  const audioFormat = readU16(bytes, fmtOffset);
  const channels = readU16(bytes, fmtOffset + 2);
  const sampleRateHz = readU32(bytes, fmtOffset + 4);
  const bitsPerSample = readU16(bytes, fmtOffset + 14);
  if (audioFormat !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `[voice-profile] expected PCM16 WAV, got format=${audioFormat} bits=${bitsPerSample}`,
    );
  }
  if (channels < 1 || sampleRateHz < 8_000) {
    throw new Error(
      `[voice-profile] unsupported WAV layout channels=${channels} sampleRate=${sampleRateHz}`,
    );
  }

  const bytesPerFrame = channels * 2;
  const samplesPerChannel = Math.floor(dataSize / bytesPerFrame);
  let sumSq = 0;
  let peakAbs = 0;
  let zeroCrossings = 0;
  let previousSign = 0;
  let silentSamples = 0;
  for (let frame = 0; frame < samplesPerChannel; frame += 1) {
    const value = readI16(bytes, dataOffset + frame * bytesPerFrame) / 32768;
    const abs = Math.abs(value);
    peakAbs = Math.max(peakAbs, abs);
    sumSq += value * value;
    if (abs < 0.01) silentSamples += 1;
    const sign = value > 0 ? 1 : value < 0 ? -1 : previousSign;
    if (previousSign !== 0 && sign !== 0 && sign !== previousSign) {
      zeroCrossings += 1;
    }
    if (sign !== 0) previousSign = sign;
  }

  const rms = samplesPerChannel > 0 ? Math.sqrt(sumSq / samplesPerChannel) : 0;
  return {
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
    format: "wav/pcm_s16le",
    channels,
    sampleRateHz,
    bitsPerSample: 16,
    dataBytes: dataSize,
    samplesPerChannel,
    durationMs: round((samplesPerChannel / sampleRateHz) * 1000, 3),
    peakAbs: round(peakAbs),
    rms: round(rms),
    zeroCrossingRate: round(
      samplesPerChannel > 1 ? zeroCrossings / (samplesPerChannel - 1) : 0,
    ),
    silenceRatio: round(
      samplesPerChannel > 0 ? silentSamples / samplesPerChannel : 1,
    ),
  };
}

function featureEmbedding(args: {
  audio: VoiceProfileAudioFeatures;
  referenceText: string | null;
  sampleId: string;
}): number[] {
  const text = normalizeText(args.referenceText);
  const textHash = sha256Hex(text);
  const hashFloats = [0, 1, 2, 3].map((i) => {
    const hex = textHash.slice(i * 8, i * 8 + 8);
    return parseInt(hex, 16) / 0xffffffff;
  });
  const durationSec = args.audio.durationMs / 1000;
  const vector = [
    Math.log1p(args.audio.sampleRateHz) / 12,
    Math.log1p(durationSec) / 4,
    args.audio.rms,
    args.audio.peakAbs,
    args.audio.zeroCrossingRate,
    1 - args.audio.silenceRatio,
    args.audio.channels / 8,
    normalizeText(args.sampleId).length / 128,
    text.length / 512,
    ...hashFloats,
  ];
  return normalizeVector(vector);
}

function artifactHashPayload(
  artifact: Omit<VoiceProfileArtifact, "artifactId">,
): string {
  return canonicalVoiceProfileJson(artifact);
}

function computeArtifactId(
  artifact: Omit<VoiceProfileArtifact, "artifactId">,
): string {
  return `vpa_${sha256Hex(artifactHashPayload(artifact)).slice(0, 32)}`;
}

export function createVoiceProfileArtifact(args: {
  samples: readonly VoiceProfileSampleInput[];
  reference?: VoiceProfileReferenceMetadata;
  createdAt?: string | null;
}): VoiceProfileArtifact {
  if (args.samples.length === 0) {
    throw new Error("[voice-profile] at least one WAV sample is required");
  }
  const reference = args.reference ?? {};
  const consent = reference.consent ?? {
    attribution: false,
    synthesis: false,
  };

  const samples = args.samples
    .map((sample, index): VoiceProfileArtifactSample => {
      const audio = analyzeVoiceProfileWav(sample.wavBytes);
      const sampleId = sample.id ?? `sample-${index + 1}`;
      const referenceText =
        normalizeText(sample.referenceText ?? reference.referenceText) || null;
      return {
        id: sampleId,
        wavSha256: audio.sha256,
        referenceText,
        recordedAt: sample.recordedAt ?? null,
        source: sample.source ?? null,
        metadata: sample.metadata ?? null,
        audio,
        featureEmbedding: featureEmbedding({
          audio,
          referenceText,
          sampleId,
        }),
      };
    })
    .sort(
      (a, b) =>
        a.id.localeCompare(b.id) || a.wavSha256.localeCompare(b.wavSha256),
    );

  const centroid = normalizeVector(
    samples[0].featureEmbedding.map((_, dim) =>
      samples.reduce((sum, sample) => sum + sample.featureEmbedding[dim], 0),
    ),
  );
  const totalDurationMs = round(
    samples.reduce((sum, sample) => sum + sample.audio.durationMs, 0),
    3,
  );
  const speechRatio =
    samples.reduce((sum, sample) => sum + (1 - sample.audio.silenceRatio), 0) /
    samples.length;

  const withoutId: Omit<VoiceProfileArtifact, "artifactId"> = {
    schemaVersion: VOICE_PROFILE_ARTIFACT_SCHEMA_VERSION,
    embeddingModel: VOICE_PROFILE_FEATURE_EMBEDDING_MODEL,
    centroidEmbedding: centroid,
    sampleCount: samples.length,
    totalDurationMs,
    confidence: round(
      Math.min(1, totalDurationMs / MIN_SYNTHESIS_DURATION_MS) *
        Math.max(0, Math.min(1, speechRatio)),
    ),
    reference: {
      speakerId: reference.speakerId ?? null,
      label: reference.label ?? null,
      displayName: reference.displayName ?? reference.label ?? null,
      referenceText: normalizeText(reference.referenceText) || null,
      language: reference.language ?? null,
      locale: reference.locale ?? null,
      source: reference.source ?? null,
      consent: {
        attribution: consent.attribution === true,
        synthesis: consent.synthesis === true,
        ...(consent.grantedBy ? { grantedBy: consent.grantedBy } : {}),
        ...(consent.grantedAt ? { grantedAt: consent.grantedAt } : {}),
        ...(consent.expiresAt ? { expiresAt: consent.expiresAt } : {}),
        ...(consent.evidenceId ? { evidenceId: consent.evidenceId } : {}),
      },
      metadata: reference.metadata ?? null,
    },
    samples,
    usage: {
      attributionAuthorized: consent.attribution === true,
      synthesisAuthorized: consent.synthesis === true,
      authorizationSource: "reference_metadata",
    },
    provenance: {
      createdAt: args.createdAt ?? null,
      deterministic: true,
      generator: "app-core.voice-profile-artifact",
    },
  };

  return {
    ...withoutId,
    artifactId: computeArtifactId(withoutId),
  };
}

export function verifyVoiceProfileArtifact(args: {
  artifact: VoiceProfileArtifact;
  sampleWavs?: Readonly<Record<string, ArrayBuffer | ArrayBufferView>>;
}): VoiceProfileArtifactVerification {
  const { artifact } = args;
  const issues: string[] = [];
  if (artifact.schemaVersion !== VOICE_PROFILE_ARTIFACT_SCHEMA_VERSION) {
    issues.push(`unsupported schemaVersion ${artifact.schemaVersion}`);
  }
  if (artifact.embeddingModel !== VOICE_PROFILE_FEATURE_EMBEDDING_MODEL) {
    issues.push(`unsupported embeddingModel ${artifact.embeddingModel}`);
  }
  if (!Array.isArray(artifact.samples) || artifact.samples.length === 0) {
    issues.push("at least one sample is required");
  }
  if (!artifact.reference.consent.attribution) {
    issues.push("attribution consent is missing");
  }
  if (artifact.totalDurationMs < MIN_ATTRIBUTION_DURATION_MS) {
    issues.push(
      `total duration ${artifact.totalDurationMs}ms is below ${MIN_ATTRIBUTION_DURATION_MS}ms`,
    );
  }

  const { artifactId: _artifactId, ...withoutId } = artifact;
  const expectedArtifactId = computeArtifactId(withoutId);
  const artifactIdMatches = expectedArtifactId === artifact.artifactId;
  if (!artifactIdMatches) {
    issues.push("artifactId does not match canonical content hash");
  }

  const samples = artifact.samples.map((sample) => {
    const sampleIssues: string[] = [];
    if (sample.audio.sha256 !== sample.wavSha256) {
      sampleIssues.push("sample wavSha256 does not match audio.sha256");
    }
    if (sample.audio.durationMs <= 0)
      sampleIssues.push("sample has no duration");
    if (sample.audio.rms <= 0) sampleIssues.push("sample is silent");
    let wavSha256Matches: boolean | undefined;
    const bytes = args.sampleWavs?.[sample.id];
    if (bytes) {
      const observed = analyzeVoiceProfileWav(bytes);
      wavSha256Matches = observed.sha256 === sample.wavSha256;
      if (!wavSha256Matches)
        sampleIssues.push("provided WAV bytes hash mismatch");
    }
    return {
      id: sample.id,
      status: sampleIssues.length === 0 ? ("pass" as const) : ("fail" as const),
      issues: sampleIssues,
      ...(wavSha256Matches !== undefined ? { wavSha256Matches } : {}),
    };
  });

  const invalid =
    issues.some((issue) => issue.includes("unsupported")) ||
    issues.some((issue) => issue.includes("artifactId")) ||
    samples.some((sample) => sample.status === "fail");
  const ready =
    !invalid &&
    artifact.reference.consent.attribution &&
    artifact.totalDurationMs >= MIN_ATTRIBUTION_DURATION_MS;
  const synthesisStatus = invalid
    ? "invalid"
    : !artifact.reference.consent.synthesis
      ? "not_authorized"
      : artifact.totalDurationMs < MIN_SYNTHESIS_DURATION_MS
        ? "insufficient_audio"
        : "authorized_by_metadata";

  return {
    status: invalid ? "invalid" : ready ? "ready" : "needs_review",
    artifactId: artifact.artifactId,
    expectedArtifactId,
    artifactIdMatches,
    sampleCount: artifact.samples.length,
    totalDurationMs: artifact.totalDurationMs,
    attributionStatus: invalid
      ? "invalid"
      : artifact.reference.consent.attribution
        ? "ready"
        : "missing_consent",
    synthesisStatus,
    issues,
    samples,
  };
}
