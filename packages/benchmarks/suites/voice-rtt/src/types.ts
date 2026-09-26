/**
 * Shared contracts for the voice round-trip benchmark.
 *
 * The interfaces keep provider I/O separate from scoring so alternate STT,
 * LLM, and TTS implementations can be dropped into the same trace schema
 * without introducing an elizaOS runtime or changing production routes.
 */

export type BenchmarkMode = "mock" | "live";

export type CorpusKind = "short" | "long" | "pause" | "barge-in";

export type CheckpointName =
  | "input_acoustic_end"
  | "stt_eager_end"
  | "stt_final"
  | "chat_admission"
  | "llm_preforward"
  | "llm_first_text_token"
  | "first_speakable_phrase"
  | "tts_request"
  | "tts_first_audio_frame"
  | "client_playout_start"
  | "interrupt"
  | "playout_silence";

export interface MockTimings {
  sttEagerAfterInputEnd: number;
  sttFinalAfterInputEnd: number;
  llmFirstTokenAfterAdmission: number;
  llmCompleteAfterAdmission: number;
  ttsFirstAudioAfterRequest: number;
  playoutBufferMs: number;
  interruptSilenceAfterBargeIn?: number;
}

export interface CorpusCase {
  id: string;
  kind: CorpusKind;
  transcript: string;
  inputAudioMs: number;
  pauseAfterMs: number;
  expectedReply: string;
  bargeInAtMs?: number;
  bargeInTranscript?: string;
  mockTimingsMs: MockTimings;
  audio?: {
    encoding: "linear16";
    sampleRateHz: number;
    base64: string;
  };
}

export interface RunConfig {
  mode: BenchmarkMode;
  runs: number;
  outDir?: string;
  timeoutMs: number;
  unsafeTranscripts: boolean;
  enforceLiveGates: boolean;
  audioDir?: string;
  nowIso: () => string;
}

export interface TraceCheckpoint {
  name: CheckpointName;
  atMs: number;
  provider?: string;
}

export interface ServerTimingComponent {
  name: string;
  durMs: number;
  desc?: string;
}

export interface VoiceTrace {
  traceId: string;
  mode: BenchmarkMode;
  caseId: string;
  runIndex: number;
  checkpoints: TraceCheckpoint[];
  serverTiming: ServerTimingComponent[];
  lengths: {
    inputAudioMs: number;
    transcriptChars: number;
    replyChars: number;
    firstSpeakablePhraseChars: number;
    firstAudioBytes: number;
  };
  transcript?: string;
  replyText?: string;
  cancelled: boolean;
  postInterruptAudioFrames: number;
  providerRequestIds: Record<string, string>;
  errors: string[];
}

export interface StageDurations {
  acousticEndToSttEagerMs: number | null;
  acousticEndToSttFinalMs: number | null;
  sttFinalToChatAdmissionMs: number | null;
  chatAdmissionToPreforwardMs: number | null;
  preforwardToFirstTokenMs: number | null;
  firstTokenToSpeakablePhraseMs: number | null;
  speakablePhraseToTtsRequestMs: number | null;
  ttsRequestToFirstAudioMs: number | null;
  firstAudioToPlayoutMs: number | null;
  eosToFirstAudioMs: number | null;
  interruptToSilenceMs: number | null;
}

export interface CaseResult {
  caseId: string;
  kind: CorpusKind;
  runIndex: number;
  trace: VoiceTrace;
  stages: StageDurations;
}

export interface PercentileSummary {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: BenchmarkMode;
  providers: {
    stt: string;
    llm: string;
    tts: string;
  };
  gates: {
    enforced: boolean;
    eosToFirstAudioP50TargetMs: number;
    eosToFirstAudioP95TargetMs: number;
    interruptToSilenceTargetMs: number;
    passed: boolean;
    failures: string[];
  };
  summaries: Record<keyof StageDurations, PercentileSummary>;
  attribution: Array<{
    stage: keyof StageDurations;
    p50Ms: number;
    share: number;
  }>;
  results: CaseResult[];
}

export interface SttResult {
  transcript: string;
  transcriptChars: number;
  eagerEndAtMs: number;
  finalAtMs: number;
  requestId?: string;
}

export interface LlmToken {
  text: string;
  atMs: number;
}

export interface LlmResult {
  replyText: string;
  firstTokenAtMs: number;
  completeAtMs: number;
  tokens: LlmToken[];
  requestId?: string;
}

export interface TtsFrame {
  atMs: number;
  bytes: number;
}

export interface TtsResult {
  firstAudioAtMs: number;
  frames: TtsFrame[];
  cancelled: boolean;
  requestId?: string;
}

export interface SttAdapter {
  name: string;
  transcribe(input: {
    traceId: string;
    corpus: CorpusCase;
    signal: AbortSignal;
    unsafeTranscripts: boolean;
    audioDir?: string;
  }): Promise<SttResult>;
}

export interface LlmAdapter {
  name: string;
  complete(input: {
    traceId: string;
    corpus: CorpusCase;
    transcript: string;
    admissionAtMs: number;
    signal: AbortSignal;
  }): Promise<LlmResult>;
}

export interface TtsAdapter {
  name: string;
  synthesize(input: {
    traceId: string;
    corpus: CorpusCase;
    text: string;
    requestAtMs: number;
    signal: AbortSignal;
    onAudioFrame(frame: TtsFrame): boolean;
  }): Promise<TtsResult>;
}
