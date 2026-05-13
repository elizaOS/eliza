/**
 * Pure scoring and validation helpers for the local voice E2E harnesses.
 *
 * This file intentionally does not load models, touch the filesystem, or
 * start servers. Hardware scripts feed it real measurements; unit tests can
 * exercise the orchestration logic without native artifacts.
 */

export type VoiceE2eHarnessErrorCode =
  | "missing-artifact"
  | "missing-measurement"
  | "invalid-measurement";

export class VoiceE2eHarnessError extends Error {
  readonly code: VoiceE2eHarnessErrorCode;
  readonly details?: unknown;

  constructor(
    code: VoiceE2eHarnessErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "VoiceE2eHarnessError";
    this.code = code;
    this.details = details;
  }
}

export interface RequiredVoiceArtifact {
  kind:
    | "bundle-root"
    | "speaker-preset"
    | "tts-model"
    | "tts-tokenizer"
    | "asr-model"
    | "asr-mmproj"
    | "ffi-library"
    | "server-binary";
  path: string;
  minBytes?: number;
  magic?: string;
}

export interface VoiceArtifactProbe {
  exists(path: string): boolean;
  size(path: string): number | null;
  readMagic?(path: string, bytes: number): string | null;
}

export interface VerifiedVoiceArtifact extends RequiredVoiceArtifact {
  size: number | null;
}

export function assertRequiredVoiceArtifacts(
  artifacts: ReadonlyArray<RequiredVoiceArtifact>,
  probe: VoiceArtifactProbe,
): VerifiedVoiceArtifact[] {
  const failures: Array<{
    kind: RequiredVoiceArtifact["kind"];
    path: string;
    reason: string;
  }> = [];
  const verified: VerifiedVoiceArtifact[] = [];

  for (const artifact of artifacts) {
    if (!probe.exists(artifact.path)) {
      failures.push({
        kind: artifact.kind,
        path: artifact.path,
        reason: "not found",
      });
      continue;
    }

    const size = probe.size(artifact.path);
    if (
      artifact.minBytes !== undefined &&
      size !== null &&
      size < artifact.minBytes
    ) {
      failures.push({
        kind: artifact.kind,
        path: artifact.path,
        reason: `too small (${size} bytes < ${artifact.minBytes} bytes)`,
      });
      continue;
    }

    if (artifact.magic) {
      const got = probe.readMagic?.(artifact.path, artifact.magic.length);
      if (got !== artifact.magic) {
        failures.push({
          kind: artifact.kind,
          path: artifact.path,
          reason: `bad magic (${JSON.stringify(got)} !== ${JSON.stringify(
            artifact.magic,
          )})`,
        });
        continue;
      }
    }

    verified.push({ ...artifact, size });
  }

  if (failures.length > 0) {
    const list = failures
      .map((f) => `- ${f.kind}: ${f.path} (${f.reason})`)
      .join("\n");
    throw new VoiceE2eHarnessError(
      "missing-artifact",
      `Missing required Eliza-1 voice artifact(s):\n${list}`,
      { failures },
    );
  }

  return verified;
}

export function normalizeWerText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordErrorRate(reference: string, hypothesis: string): number {
  const refWords = normalizeWerText(reference).split(" ").filter(Boolean);
  const hypWords = normalizeWerText(hypothesis).split(" ").filter(Boolean);
  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1;

  const prev = Array.from({ length: hypWords.length + 1 }, (_, i) => i);
  const curr = new Array<number>(hypWords.length + 1).fill(0);
  for (let i = 1; i <= refWords.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= hypWords.length; j++) {
      const cost = refWords[i - 1] === hypWords[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < curr.length; j++) prev[j] = curr[j];
  }
  return prev[hypWords.length] / refWords.length;
}

export interface TtsAsrRoundTripInput {
  referenceText: string;
  hypothesisText: string;
  maxWer?: number;
}

export interface TtsAsrRoundTripResult {
  kind: "tts-asr-roundtrip";
  referenceText: string;
  hypothesisText: string;
  normalizedReference: string;
  normalizedHypothesis: string;
  wer: number;
  maxWer: number;
  passed: boolean;
}

export function scoreTtsAsrRoundTrip(
  input: TtsAsrRoundTripInput,
): TtsAsrRoundTripResult {
  const maxWer = input.maxWer ?? 0.15;
  const wer = wordErrorRate(input.referenceText, input.hypothesisText);
  return {
    kind: "tts-asr-roundtrip",
    referenceText: input.referenceText,
    hypothesisText: input.hypothesisText,
    normalizedReference: normalizeWerText(input.referenceText),
    normalizedHypothesis: normalizeWerText(input.hypothesisText),
    wer: round4(wer),
    maxWer,
    passed: wer <= maxWer,
  };
}

export interface BargeInInterruptionInput {
  voiceDetectedAtMs: number;
  ttsCancelledAtMs?: number | null;
  llmCancelledAtMs?: number | null;
  audioDrainedAtMs?: number | null;
  maxCancelMs?: number;
  requireLlmCancel?: boolean;
}

export interface BargeInInterruptionResult {
  kind: "barge-in-interruption";
  ttsCancelMs: number | null;
  llmCancelMs: number | null;
  audioDrainMs: number | null;
  bargeInCancelMs: number;
  maxCancelMs: number;
  passed: boolean;
}

export function scoreBargeInInterruption(
  input: BargeInInterruptionInput,
): BargeInInterruptionResult {
  const maxCancelMs = input.maxCancelMs ?? 250;
  const ttsCancelMs = optionalDuration(
    "voiceDetectedAtMs",
    input.voiceDetectedAtMs,
    "ttsCancelledAtMs",
    input.ttsCancelledAtMs,
  );
  const llmCancelMs = optionalDuration(
    "voiceDetectedAtMs",
    input.voiceDetectedAtMs,
    "llmCancelledAtMs",
    input.llmCancelledAtMs,
  );
  const audioDrainMs = optionalDuration(
    "voiceDetectedAtMs",
    input.voiceDetectedAtMs,
    "audioDrainedAtMs",
    input.audioDrainedAtMs,
  );

  if (ttsCancelMs === null) {
    throw missingMeasurement("ttsCancelledAtMs");
  }
  if (input.requireLlmCancel !== false && llmCancelMs === null) {
    throw missingMeasurement("llmCancelledAtMs");
  }

  const measured = [ttsCancelMs, llmCancelMs, audioDrainMs].filter(
    (value): value is number => value !== null,
  );
  const bargeInCancelMs = Math.max(...measured);
  return {
    kind: "barge-in-interruption",
    ttsCancelMs: round1(ttsCancelMs),
    llmCancelMs: llmCancelMs === null ? null : round1(llmCancelMs),
    audioDrainMs: audioDrainMs === null ? null : round1(audioDrainMs),
    bargeInCancelMs: round1(bargeInCancelMs),
    maxCancelMs,
    passed: bargeInCancelMs <= maxCancelMs,
  };
}

export interface PauseContinuationInput {
  speechPauseAtMs: number;
  continuationAtMs: number;
  speculativeStartedAtMs?: number | null;
  speculativeAbortedAtMs?: number | null;
  finalRestartedAtMs?: number | null;
  committedBeforeContinuationAtMs?: number | null;
  maxContinuationGapMs?: number;
  maxAbortAfterContinuationMs?: number;
  maxRestartAfterContinuationMs?: number;
}

export interface PauseContinuationResult {
  kind: "pause-continuation";
  continuationGapMs: number;
  speculativeStartAfterPauseMs: number | null;
  abortAfterContinuationMs: number;
  restartAfterContinuationMs: number;
  maxContinuationGapMs: number;
  passed: boolean;
}

export function scorePauseContinuation(
  input: PauseContinuationInput,
): PauseContinuationResult {
  const maxContinuationGapMs = input.maxContinuationGapMs ?? 4000;
  const maxAbortAfterContinuationMs = input.maxAbortAfterContinuationMs ?? 250;
  const maxRestartAfterContinuationMs =
    input.maxRestartAfterContinuationMs ?? 1000;
  const continuationGapMs = duration(
    "speechPauseAtMs",
    input.speechPauseAtMs,
    "continuationAtMs",
    input.continuationAtMs,
  );
  const speculativeStartAfterPauseMs = optionalDuration(
    "speechPauseAtMs",
    input.speechPauseAtMs,
    "speculativeStartedAtMs",
    input.speculativeStartedAtMs,
  );
  const abortAfterContinuationMs = duration(
    "continuationAtMs",
    input.continuationAtMs,
    "speculativeAbortedAtMs",
    required(input.speculativeAbortedAtMs, "speculativeAbortedAtMs"),
  );
  const restartAfterContinuationMs = duration(
    "continuationAtMs",
    input.continuationAtMs,
    "finalRestartedAtMs",
    required(input.finalRestartedAtMs, "finalRestartedAtMs"),
  );
  const committedBefore =
    input.committedBeforeContinuationAtMs !== null &&
    input.committedBeforeContinuationAtMs !== undefined &&
    input.committedBeforeContinuationAtMs < input.continuationAtMs;

  return {
    kind: "pause-continuation",
    continuationGapMs: round1(continuationGapMs),
    speculativeStartAfterPauseMs:
      speculativeStartAfterPauseMs === null
        ? null
        : round1(speculativeStartAfterPauseMs),
    abortAfterContinuationMs: round1(abortAfterContinuationMs),
    restartAfterContinuationMs: round1(restartAfterContinuationMs),
    maxContinuationGapMs,
    passed:
      !committedBefore &&
      continuationGapMs <= maxContinuationGapMs &&
      abortAfterContinuationMs <= maxAbortAfterContinuationMs &&
      restartAfterContinuationMs <= maxRestartAfterContinuationMs,
  };
}

export interface OptimisticRollbackRestartInput {
  speechPauseAtMs: number;
  continuationAtMs: number;
  checkpointSavedAtMs?: number | null;
  speculativeStartedAtMs?: number | null;
  speculativeAbortedAtMs?: number | null;
  checkpointRestoredAtMs?: number | null;
  restartedAtMs?: number | null;
  maxRestoreAfterContinuationMs?: number;
  maxRestartAfterRestoreMs?: number;
}

export interface OptimisticRollbackRestartResult {
  kind: "optimistic-rollback-restart";
  saveAfterPauseMs: number | null;
  abortAfterContinuationMs: number;
  restoreAfterContinuationMs: number;
  restartAfterRestoreMs: number;
  passed: boolean;
}

export function scoreOptimisticRollbackRestart(
  input: OptimisticRollbackRestartInput,
): OptimisticRollbackRestartResult {
  const maxRestoreAfterContinuationMs =
    input.maxRestoreAfterContinuationMs ?? 300;
  const maxRestartAfterRestoreMs = input.maxRestartAfterRestoreMs ?? 1000;
  const saveAfterPauseMs = optionalDuration(
    "speechPauseAtMs",
    input.speechPauseAtMs,
    "checkpointSavedAtMs",
    input.checkpointSavedAtMs,
  );
  const abortAfterContinuationMs = duration(
    "continuationAtMs",
    input.continuationAtMs,
    "speculativeAbortedAtMs",
    required(input.speculativeAbortedAtMs, "speculativeAbortedAtMs"),
  );
  const restoreAfterContinuationMs = duration(
    "continuationAtMs",
    input.continuationAtMs,
    "checkpointRestoredAtMs",
    required(input.checkpointRestoredAtMs, "checkpointRestoredAtMs"),
  );
  const restartAfterRestoreMs = duration(
    "checkpointRestoredAtMs",
    required(input.checkpointRestoredAtMs, "checkpointRestoredAtMs"),
    "restartedAtMs",
    required(input.restartedAtMs, "restartedAtMs"),
  );

  return {
    kind: "optimistic-rollback-restart",
    saveAfterPauseMs:
      saveAfterPauseMs === null ? null : round1(saveAfterPauseMs),
    abortAfterContinuationMs: round1(abortAfterContinuationMs),
    restoreAfterContinuationMs: round1(restoreAfterContinuationMs),
    restartAfterRestoreMs: round1(restartAfterRestoreMs),
    passed:
      restoreAfterContinuationMs <= maxRestoreAfterContinuationMs &&
      restartAfterRestoreMs <= maxRestartAfterRestoreMs &&
      abortAfterContinuationMs <= maxRestoreAfterContinuationMs,
  };
}

export interface FirstResponseLatencyInput {
  turnStartedAtMs: number;
  asrFinalAtMs?: number | null;
  llmFirstTokenAtMs?: number | null;
  ttsFirstAudioAtMs?: number | null;
  audioFirstPlayedAtMs?: number | null;
  maxFirstAudioMs?: number;
}

export interface FirstResponseLatencyResult {
  kind: "first-response-latency";
  asrFinalMs: number | null;
  firstTokenMs: number | null;
  firstAudioMs: number;
  firstPlayedMs: number | null;
  maxFirstAudioMs: number;
  passed: boolean;
}

export function scoreFirstResponseLatency(
  input: FirstResponseLatencyInput,
): FirstResponseLatencyResult {
  const maxFirstAudioMs = input.maxFirstAudioMs ?? 1500;
  const asrFinalMs = optionalDuration(
    "turnStartedAtMs",
    input.turnStartedAtMs,
    "asrFinalAtMs",
    input.asrFinalAtMs,
  );
  const firstTokenMs = optionalDuration(
    "turnStartedAtMs",
    input.turnStartedAtMs,
    "llmFirstTokenAtMs",
    input.llmFirstTokenAtMs,
  );
  const firstAudioMs = duration(
    "turnStartedAtMs",
    input.turnStartedAtMs,
    "ttsFirstAudioAtMs",
    required(input.ttsFirstAudioAtMs, "ttsFirstAudioAtMs"),
  );
  const firstPlayedMs = optionalDuration(
    "turnStartedAtMs",
    input.turnStartedAtMs,
    "audioFirstPlayedAtMs",
    input.audioFirstPlayedAtMs,
  );

  return {
    kind: "first-response-latency",
    asrFinalMs: asrFinalMs === null ? null : round1(asrFinalMs),
    firstTokenMs: firstTokenMs === null ? null : round1(firstTokenMs),
    firstAudioMs: round1(firstAudioMs),
    firstPlayedMs: firstPlayedMs === null ? null : round1(firstPlayedMs),
    maxFirstAudioMs,
    passed: firstAudioMs <= maxFirstAudioMs,
  };
}

export type VoiceE2eCaseResult =
  | TtsAsrRoundTripResult
  | BargeInInterruptionResult
  | PauseContinuationResult
  | OptimisticRollbackRestartResult
  | FirstResponseLatencyResult;

export interface VoiceE2eSummary {
  passed: boolean;
  cases: VoiceE2eCaseResult[];
}

export function summarizeVoiceE2e(
  cases: ReadonlyArray<VoiceE2eCaseResult>,
): VoiceE2eSummary {
  return {
    passed: cases.length > 0 && cases.every((c) => c.passed),
    cases: [...cases],
  };
}

function required(value: number | null | undefined, name: string): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw missingMeasurement(name);
  }
  return value;
}

function optionalDuration(
  fromName: string,
  from: number,
  toName: string,
  to: number | null | undefined,
): number | null {
  if (to === null || to === undefined) return null;
  return duration(fromName, from, toName, to);
}

function duration(
  fromName: string,
  from: number,
  toName: string,
  to: number,
): number {
  if (!Number.isFinite(from)) throw missingMeasurement(fromName);
  if (!Number.isFinite(to)) throw missingMeasurement(toName);
  const delta = to - from;
  if (delta < 0) {
    throw new VoiceE2eHarnessError(
      "invalid-measurement",
      `Invalid voice E2E measurement: ${toName} (${to}) is before ${fromName} (${from})`,
      { fromName, from, toName, to },
    );
  }
  return delta;
}

function missingMeasurement(name: string): VoiceE2eHarnessError {
  return new VoiceE2eHarnessError(
    "missing-measurement",
    `Missing required voice E2E measurement: ${name}`,
    { name },
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
