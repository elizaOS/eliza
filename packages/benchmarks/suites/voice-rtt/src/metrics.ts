/**
 * Percentile, stage, and gate math for the voice round-trip benchmark.
 *
 * Missing checkpoints stay `null` all the way into reports; the benchmark never
 * converts absent telemetry into a zero-duration success.
 */

import type {
  BenchmarkReport,
  CaseResult,
  PercentileSummary,
  StageDurations,
  VoiceTrace,
} from "./types.ts";

const STAGE_KEYS = [
  "acousticEndToSttEagerMs",
  "acousticEndToSttFinalMs",
  "sttFinalToChatAdmissionMs",
  "chatAdmissionToPreforwardMs",
  "preforwardToFirstTokenMs",
  "firstTokenToSpeakablePhraseMs",
  "speakablePhraseToTtsRequestMs",
  "ttsRequestToFirstAudioMs",
  "firstAudioToPlayoutMs",
  "eosToFirstAudioMs",
  "interruptToSilenceMs",
] as const satisfies readonly (keyof StageDurations)[];

export const GATE_TARGETS = {
  eosToFirstAudioP50TargetMs: 1000,
  eosToFirstAudioP95TargetMs: 1500,
  interruptToSilenceTargetMs: 300,
} as const;

export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  const nums = values.filter((value) => Number.isFinite(value));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function summarize(
  values: readonly (number | null)[],
): PercentileSummary {
  const nums = values.filter((value): value is number =>
    Number.isFinite(value),
  );
  if (nums.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p90: null,
      p95: null,
    };
  }
  const sum = nums.reduce((acc, value) => acc + value, 0);
  return {
    count: nums.length,
    min: Math.min(...nums),
    max: Math.max(...nums),
    mean: sum / nums.length,
    p50: percentile(nums, 50),
    p90: percentile(nums, 90),
    p95: percentile(nums, 95),
  };
}

export function deriveStages(trace: VoiceTrace): StageDurations {
  const at = (name: Parameters<typeof findCheckpoint>[1]) =>
    findCheckpoint(trace, name);
  const diff = (
    start: Parameters<typeof findCheckpoint>[1],
    end: Parameters<typeof findCheckpoint>[1],
  ) => {
    const startAt = at(start);
    const endAt = at(end);
    return startAt === null || endAt === null ? null : endAt - startAt;
  };
  return {
    acousticEndToSttEagerMs: diff("input_acoustic_end", "stt_eager_end"),
    acousticEndToSttFinalMs: diff("input_acoustic_end", "stt_final"),
    sttFinalToChatAdmissionMs: diff("stt_final", "chat_admission"),
    chatAdmissionToPreforwardMs: diff("chat_admission", "llm_preforward"),
    preforwardToFirstTokenMs: diff("llm_preforward", "llm_first_text_token"),
    firstTokenToSpeakablePhraseMs: diff(
      "llm_first_text_token",
      "first_speakable_phrase",
    ),
    speakablePhraseToTtsRequestMs: diff(
      "first_speakable_phrase",
      "tts_request",
    ),
    ttsRequestToFirstAudioMs: diff("tts_request", "tts_first_audio_frame"),
    firstAudioToPlayoutMs: diff(
      "tts_first_audio_frame",
      "client_playout_start",
    ),
    eosToFirstAudioMs: diff("input_acoustic_end", "tts_first_audio_frame"),
    interruptToSilenceMs: diff("interrupt", "playout_silence"),
  };
}

export function summarizeStages(
  results: readonly CaseResult[],
): Record<keyof StageDurations, PercentileSummary> {
  const summaries = {} as Record<keyof StageDurations, PercentileSummary>;
  for (const key of STAGE_KEYS) {
    summaries[key] = summarize(results.map((result) => result.stages[key]));
  }
  return summaries;
}

export function stageAttribution(
  summaries: Record<keyof StageDurations, PercentileSummary>,
): BenchmarkReport["attribution"] {
  // Attribute only non-overlapping legs of the EOS-to-first-audio critical path.
  // Eager STT is diagnostic and overlaps STT final; playout starts after first
  // audio, so including either would double-count the gate's denominator.
  const stageKeys: Array<keyof StageDurations> = [
    "acousticEndToSttFinalMs",
    "sttFinalToChatAdmissionMs",
    "chatAdmissionToPreforwardMs",
    "preforwardToFirstTokenMs",
    "firstTokenToSpeakablePhraseMs",
    "speakablePhraseToTtsRequestMs",
    "ttsRequestToFirstAudioMs",
  ];
  const p50s = stageKeys.flatMap((stage) => {
    const p50Ms = summaries[stage].p50;
    return p50Ms === null ? [] : [{ stage, p50Ms }];
  });
  const total = p50s.reduce((acc, entry) => acc + entry.p50Ms, 0);
  return p50s
    .map((entry) => ({
      ...entry,
      share: total === 0 ? 0 : entry.p50Ms / total,
    }))
    .sort((a, b) => b.p50Ms - a.p50Ms);
}

export function evaluateGates(args: {
  summaries: Record<keyof StageDurations, PercentileSummary>;
  results: readonly CaseResult[];
  enforced: boolean;
}): BenchmarkReport["gates"] {
  const failures: string[] = [];
  const eos = args.summaries.eosToFirstAudioMs;
  if (eos.p50 !== null && eos.p50 >= GATE_TARGETS.eosToFirstAudioP50TargetMs) {
    failures.push(
      `EOS to first audio P50 ${Math.round(eos.p50)}ms must be less than ${GATE_TARGETS.eosToFirstAudioP50TargetMs}ms`,
    );
  }
  if (eos.p95 !== null && eos.p95 >= GATE_TARGETS.eosToFirstAudioP95TargetMs) {
    failures.push(
      `EOS to first audio P95 ${Math.round(eos.p95)}ms must be less than ${GATE_TARGETS.eosToFirstAudioP95TargetMs}ms`,
    );
  }
  const interruptValues = args.results
    .map((result) => result.stages.interruptToSilenceMs)
    .filter((value): value is number => Number.isFinite(value));
  for (const value of interruptValues) {
    if (value >= GATE_TARGETS.interruptToSilenceTargetMs) {
      failures.push(
        `interruption to silence ${Math.round(value)}ms must be less than ${GATE_TARGETS.interruptToSilenceTargetMs}ms`,
      );
    }
  }
  for (const result of args.results) {
    if (result.stages.eosToFirstAudioMs === null) {
      failures.push(
        `${result.caseId} run ${result.runIndex} is missing EOS to first audio measurement`,
      );
    }
    if (
      result.kind === "barge-in" &&
      result.stages.interruptToSilenceMs === null
    ) {
      failures.push(
        `${result.caseId} run ${result.runIndex} is missing interruption to silence measurement`,
      );
    }
    if (result.kind === "barge-in" && !result.trace.cancelled) {
      failures.push(
        `${result.caseId} run ${result.runIndex} did not cancel active TTS during barge-in`,
      );
    }
    if (result.trace.postInterruptAudioFrames > 0) {
      failures.push(
        `${result.caseId} run ${result.runIndex} emitted ${result.trace.postInterruptAudioFrames} audio frame(s) after interrupt silence`,
      );
    }
  }
  return {
    enforced: args.enforced,
    ...GATE_TARGETS,
    passed: failures.length === 0 || !args.enforced,
    failures,
  };
}

function findCheckpoint(
  trace: VoiceTrace,
  name: VoiceTrace["checkpoints"][number]["name"],
): number | null {
  const checkpoint = trace.checkpoints.find((entry) => entry.name === name);
  return checkpoint ? checkpoint.atMs : null;
}
