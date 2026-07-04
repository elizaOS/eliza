/** Implements Electrobun desktop voice latency budget ts behavior for app-core shell integration. */
export const VOICE_LATENCY_BUDGET_STAGES = [
  "input_to_vad",
  "vad_to_asr_partial",
  "asr_partial_to_runtime_prepare",
  "asr_final_to_runtime_commit",
  "runtime_to_first_token",
  "first_token_to_tts_request",
  "tts_request_to_first_audio",
  "first_audio_to_playback",
  "total_to_first_token",
  "total_to_first_audio",
  "total_to_playback",
] as const;

export type VoiceLatencyBudgetStage =
  (typeof VOICE_LATENCY_BUDGET_STAGES)[number];

export type VoiceLatencyBudget = {
  inputToVadMs: number;
  vadToAsrPartialMs: number;
  asrPartialToRuntimePrepareMs: number;
  asrFinalToRuntimeCommitMs: number;
  runtimeToFirstTokenMs: number;
  firstTokenToTtsRequestMs: number;
  ttsRequestToFirstAudioMs: number;
  firstAudioToPlaybackMs: number;
  totalToFirstTokenMs: number;
  totalToFirstAudioMs: number;
  totalToPlaybackMs: number;
};

export type VoiceLatencyBudgetResult = {
  stage: VoiceLatencyBudgetStage;
  actualMs?: number;
  budgetMs: number;
  ok: boolean;
};

type LatencySummaryLike = {
  inputToVadMs?: number;
  vadToAsrPartialMs?: number;
  asrPartialToRuntimePrepareMs?: number;
  asrFinalToRuntimeMs?: number;
  asrFinalToRuntimeCommitMs?: number;
  runtimeToFirstTokenMs?: number;
  firstTokenToTtsRequestMs?: number;
  firstTokenToTtsFirstAudioMs?: number;
  ttsRequestToFirstAudioMs?: number;
  ttsFirstAudioToPlaybackMs?: number;
  totalToFirstTokenMs?: number;
  totalToFirstAudioMs?: number;
  totalToPlaybackMs?: number;
};

const DEFAULT_VOICE_LATENCY_BUDGET: VoiceLatencyBudget = {
  inputToVadMs: 50,
  vadToAsrPartialMs: 150,
  asrPartialToRuntimePrepareMs: 100,
  asrFinalToRuntimeCommitMs: 100,
  runtimeToFirstTokenMs: 500,
  firstTokenToTtsRequestMs: 80,
  ttsRequestToFirstAudioMs: 400,
  firstAudioToPlaybackMs: 100,
  totalToFirstTokenMs: 900,
  totalToFirstAudioMs: 1200,
  totalToPlaybackMs: 1400,
};

const ENV_KEYS: Readonly<Record<keyof VoiceLatencyBudget, string>> = {
  inputToVadMs: "ELIZA_VOICE_BUDGET_INPUT_TO_VAD_MS",
  vadToAsrPartialMs: "ELIZA_VOICE_BUDGET_VAD_TO_ASR_PARTIAL_MS",
  asrPartialToRuntimePrepareMs:
    "ELIZA_VOICE_BUDGET_ASR_PARTIAL_TO_RUNTIME_PREPARE_MS",
  asrFinalToRuntimeCommitMs:
    "ELIZA_VOICE_BUDGET_ASR_FINAL_TO_RUNTIME_COMMIT_MS",
  runtimeToFirstTokenMs: "ELIZA_VOICE_BUDGET_RUNTIME_TO_FIRST_TOKEN_MS",
  firstTokenToTtsRequestMs: "ELIZA_VOICE_BUDGET_FIRST_TOKEN_TO_TTS_REQUEST_MS",
  ttsRequestToFirstAudioMs: "ELIZA_VOICE_BUDGET_TTS_REQUEST_TO_FIRST_AUDIO_MS",
  firstAudioToPlaybackMs: "ELIZA_VOICE_BUDGET_FIRST_AUDIO_TO_PLAYBACK_MS",
  totalToFirstTokenMs: "ELIZA_VOICE_BUDGET_TOTAL_TO_FIRST_TOKEN_MS",
  totalToFirstAudioMs: "ELIZA_VOICE_BUDGET_TOTAL_TO_FIRST_AUDIO_MS",
  totalToPlaybackMs: "ELIZA_VOICE_BUDGET_TOTAL_TO_PLAYBACK_MS",
};

type StageMapping = {
  stage: VoiceLatencyBudgetStage;
  budgetKey: keyof VoiceLatencyBudget;
  actual: (summary: LatencySummaryLike) => number | undefined;
};

const STAGE_MAPPINGS: readonly StageMapping[] = [
  {
    stage: "input_to_vad",
    budgetKey: "inputToVadMs",
    actual: (summary) => summary.inputToVadMs,
  },
  {
    stage: "vad_to_asr_partial",
    budgetKey: "vadToAsrPartialMs",
    actual: (summary) => summary.vadToAsrPartialMs,
  },
  {
    stage: "asr_partial_to_runtime_prepare",
    budgetKey: "asrPartialToRuntimePrepareMs",
    actual: (summary) => summary.asrPartialToRuntimePrepareMs,
  },
  {
    stage: "asr_final_to_runtime_commit",
    budgetKey: "asrFinalToRuntimeCommitMs",
    actual: (summary) =>
      summary.asrFinalToRuntimeCommitMs ?? summary.asrFinalToRuntimeMs,
  },
  {
    stage: "runtime_to_first_token",
    budgetKey: "runtimeToFirstTokenMs",
    actual: (summary) => summary.runtimeToFirstTokenMs,
  },
  {
    stage: "first_token_to_tts_request",
    budgetKey: "firstTokenToTtsRequestMs",
    actual: (summary) => summary.firstTokenToTtsRequestMs,
  },
  {
    stage: "tts_request_to_first_audio",
    budgetKey: "ttsRequestToFirstAudioMs",
    actual: (summary) =>
      summary.ttsRequestToFirstAudioMs ?? summary.firstTokenToTtsFirstAudioMs,
  },
  {
    stage: "first_audio_to_playback",
    budgetKey: "firstAudioToPlaybackMs",
    actual: (summary) => summary.ttsFirstAudioToPlaybackMs,
  },
  {
    stage: "total_to_first_token",
    budgetKey: "totalToFirstTokenMs",
    actual: (summary) => summary.totalToFirstTokenMs,
  },
  {
    stage: "total_to_first_audio",
    budgetKey: "totalToFirstAudioMs",
    actual: (summary) => summary.totalToFirstAudioMs,
  },
  {
    stage: "total_to_playback",
    budgetKey: "totalToPlaybackMs",
    actual: (summary) => summary.totalToPlaybackMs,
  },
];

function readPositiveInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getDefaultVoiceLatencyBudget(): VoiceLatencyBudget {
  return { ...DEFAULT_VOICE_LATENCY_BUDGET };
}

export function getVoiceLatencyBudgetFromEnv(
  env: Record<string, string | undefined> = process.env,
): VoiceLatencyBudget {
  const defaults = getDefaultVoiceLatencyBudget();
  return {
    inputToVadMs: readPositiveInt(
      env,
      ENV_KEYS.inputToVadMs,
      defaults.inputToVadMs,
    ),
    vadToAsrPartialMs: readPositiveInt(
      env,
      ENV_KEYS.vadToAsrPartialMs,
      defaults.vadToAsrPartialMs,
    ),
    asrPartialToRuntimePrepareMs: readPositiveInt(
      env,
      ENV_KEYS.asrPartialToRuntimePrepareMs,
      defaults.asrPartialToRuntimePrepareMs,
    ),
    asrFinalToRuntimeCommitMs: readPositiveInt(
      env,
      ENV_KEYS.asrFinalToRuntimeCommitMs,
      defaults.asrFinalToRuntimeCommitMs,
    ),
    runtimeToFirstTokenMs: readPositiveInt(
      env,
      ENV_KEYS.runtimeToFirstTokenMs,
      defaults.runtimeToFirstTokenMs,
    ),
    firstTokenToTtsRequestMs: readPositiveInt(
      env,
      ENV_KEYS.firstTokenToTtsRequestMs,
      defaults.firstTokenToTtsRequestMs,
    ),
    ttsRequestToFirstAudioMs: readPositiveInt(
      env,
      ENV_KEYS.ttsRequestToFirstAudioMs,
      defaults.ttsRequestToFirstAudioMs,
    ),
    firstAudioToPlaybackMs: readPositiveInt(
      env,
      ENV_KEYS.firstAudioToPlaybackMs,
      defaults.firstAudioToPlaybackMs,
    ),
    totalToFirstTokenMs: readPositiveInt(
      env,
      ENV_KEYS.totalToFirstTokenMs,
      defaults.totalToFirstTokenMs,
    ),
    totalToFirstAudioMs: readPositiveInt(
      env,
      ENV_KEYS.totalToFirstAudioMs,
      defaults.totalToFirstAudioMs,
    ),
    totalToPlaybackMs: readPositiveInt(
      env,
      ENV_KEYS.totalToPlaybackMs,
      defaults.totalToPlaybackMs,
    ),
  };
}

export function evaluateVoiceLatencyBudget(
  summary: LatencySummaryLike,
  budget: VoiceLatencyBudget = getDefaultVoiceLatencyBudget(),
): VoiceLatencyBudgetResult[] {
  return STAGE_MAPPINGS.map((mapping) => {
    const actualMs = mapping.actual(summary);
    const budgetMs = budget[mapping.budgetKey];
    return {
      stage: mapping.stage,
      actualMs,
      budgetMs,
      ok: actualMs !== undefined && actualMs <= budgetMs,
    };
  });
}
