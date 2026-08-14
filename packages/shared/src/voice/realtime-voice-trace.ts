export type RealtimeVoiceTraceMark =
  | "capture_started"
  | "local_speech_detected"
  | "local_playback_paused"
  | "server_interrupt_ack"
  | "acoustic_speech_ended"
  | "stt_final"
  | "turn_committed"
  | "router_decided"
  | "llm_requested"
  | "llm_first_useful_text"
  | "speakable_text_ready"
  | "tts_requested"
  | "tts_first_byte"
  | "first_audio_playout"
  | "last_audio_playout"
  | "reconnect_started"
  | "reconnect_ready"
  | "tool_mutation_committed"
  | "turn_ended";

export type VoiceDeviceClass =
  | "builtin"
  | "usb"
  | "bluetooth"
  | "wired"
  | "virtual"
  | "unknown";

export type VoiceTransportKind =
  | "websocket"
  | "webrtc"
  | "http_sse"
  | "local"
  | "unknown";

export type GrantedConstraint = boolean | "unknown";

export interface RealtimeVoiceTraceDimensionsInput {
  sttProvider?: string;
  modelProvider?: string;
  modelRoute?: string;
  ttsProvider?: string;
  transport?: VoiceTransportKind;
  frameDurationMs?: number;
  sampleRateHz?: number;
  echoCancellation?: GrantedConstraint;
  noiseSuppression?: GrantedConstraint;
  autoGainControl?: GrantedConstraint;
  inputDeviceClass?: VoiceDeviceClass;
  outputDeviceClass?: VoiceDeviceClass;
}

export interface RealtimeVoiceTraceDimensions {
  sttProvider: string;
  modelProvider: string;
  modelRoute: string;
  ttsProvider: string;
  transport: VoiceTransportKind;
  frameDurationMs: number | null;
  sampleRateHz: number | null;
  echoCancellation: GrantedConstraint;
  noiseSuppression: GrantedConstraint;
  autoGainControl: GrantedConstraint;
  inputDeviceClass: VoiceDeviceClass;
  outputDeviceClass: VoiceDeviceClass;
}

export interface RealtimeVoiceTraceExpectations {
  transcription: boolean;
  modelResponse: boolean;
  spokenResponse: boolean;
  interruption: boolean;
  reconnect: boolean;
  mutatingTool: boolean;
}

export type RealtimeVoiceTraceProfile =
  | "transcription"
  | "model_response"
  | "spoken_response"
  | "interruption"
  | "reconnect"
  | "mutating_tool";

export type RealtimeVoiceTraceOutcome =
  | "open"
  | "spoken"
  | "no_response"
  | "interrupted"
  | "error";

export interface RealtimeVoiceTrace {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly responseId: string | null;
  readonly createdAtMs: number;
  readonly finalizedAtMs: number | null;
  readonly outcome: RealtimeVoiceTraceOutcome;
  readonly profiles: readonly RealtimeVoiceTraceProfile[];
  readonly dimensions: RealtimeVoiceTraceDimensions;
  readonly expectations: RealtimeVoiceTraceExpectations;
  readonly marks: Readonly<Partial<Record<RealtimeVoiceTraceMark, number>>>;
  readonly lateAudioFrames: number;
  readonly lastLateAudioFrameAtMs: number | null;
}

export interface CreateRealtimeVoiceTraceInput {
  sessionId: string;
  turnId: string;
  responseId?: string | null;
  atMs: number;
  dimensions?: RealtimeVoiceTraceDimensionsInput;
  /** Explicit measurement manifest. Defaults to a normal spoken response. */
  profiles?: readonly RealtimeVoiceTraceProfile[];
}

export type VoiceLatencyMetricName =
  | "speech_to_local_silence"
  | "speech_to_server_ack"
  | "acoustic_end_to_stt_final"
  | "commit_to_first_model_text"
  | "speakable_text_to_tts_byte"
  | "acoustic_end_to_audible"
  | "reconnect_recovery"
  | "commit_to_tool_mutation";

export interface VoiceLatencyMetricSummary {
  metric: VoiceLatencyMetricName;
  count: number;
  expectedCount: number;
  invalidCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  coveragePassed: boolean;
  sloPassed: boolean;
}

export interface RealtimeVoiceTraceCoverage {
  complete: boolean;
  finalized: boolean;
  outcomePassed: boolean;
  requiredMarks: readonly RealtimeVoiceTraceMark[];
  missingMarks: readonly RealtimeVoiceTraceMark[];
}

export interface RealtimeVoiceLatencyReport {
  traceCount: number;
  completedTraceCount: number;
  invalidTraceCount: number;
  minimumTraceCount: number;
  cohortSizePassed: boolean;
  completionPassed: boolean;
  traceValidityPassed: boolean;
  requirementsValid: boolean;
  profileCounts: Readonly<Record<RealtimeVoiceTraceProfile, number>>;
  minimumProfileCounts: Readonly<Record<RealtimeVoiceTraceProfile, number>>;
  profileCoveragePassed: boolean;
  metrics: Readonly<Record<VoiceLatencyMetricName, VoiceLatencyMetricSummary>>;
  lateAudioFrames: number;
  zeroLateAudioPassed: boolean;
  coveragePassed: boolean;
  sloPassed: boolean;
  passed: boolean;
}

export interface RealtimeVoiceLatencyReportOptions {
  /** Release gates must set their real scenario minimum; never below one. */
  minimumTraceCount?: number;
  minimumProfileCounts?: Partial<Record<RealtimeVoiceTraceProfile, number>>;
}

const TRACE_PROFILE_LIST: readonly RealtimeVoiceTraceProfile[] = [
  "transcription",
  "model_response",
  "spoken_response",
  "interruption",
  "reconnect",
  "mutating_tool",
];

const TRACE_PROFILES = new Set(TRACE_PROFILE_LIST);
const FINAL_OUTCOMES = new Set<Exclude<RealtimeVoiceTraceOutcome, "open">>([
  "spoken",
  "no_response",
  "interrupted",
  "error",
]);
const TRACE_MARKS = new Set<RealtimeVoiceTraceMark>([
  "capture_started",
  "local_speech_detected",
  "local_playback_paused",
  "server_interrupt_ack",
  "acoustic_speech_ended",
  "stt_final",
  "turn_committed",
  "router_decided",
  "llm_requested",
  "llm_first_useful_text",
  "speakable_text_ready",
  "tts_requested",
  "tts_first_byte",
  "first_audio_playout",
  "last_audio_playout",
  "reconnect_started",
  "reconnect_ready",
  "tool_mutation_committed",
  "turn_ended",
]);

function expectationManifest(
  input: readonly RealtimeVoiceTraceProfile[] | undefined,
): {
  profiles: readonly RealtimeVoiceTraceProfile[];
  expectations: RealtimeVoiceTraceExpectations;
} {
  const profiles = [
    ...new Set(
      (Array.isArray(input) ? input : []).filter((profile) =>
        TRACE_PROFILES.has(profile),
      ),
    ),
  ];
  if (profiles.length === 0) profiles.push("spoken_response");
  const expectations: RealtimeVoiceTraceExpectations = {
    transcription: profiles.some((profile) =>
      [
        "transcription",
        "model_response",
        "spoken_response",
        "mutating_tool",
      ].includes(profile),
    ),
    modelResponse: profiles.some((profile) =>
      ["model_response", "spoken_response", "mutating_tool"].includes(profile),
    ),
    spokenResponse: profiles.includes("spoken_response"),
    interruption: profiles.includes("interruption"),
    reconnect: profiles.includes("reconnect"),
    mutatingTool: profiles.includes("mutating_tool"),
  };
  return {
    profiles: Object.freeze(profiles),
    expectations: Object.freeze(expectations),
  };
}

function frozenTrace(trace: RealtimeVoiceTrace): RealtimeVoiceTrace {
  return Object.freeze({
    ...trace,
    profiles: Object.freeze([...trace.profiles]),
    dimensions: Object.freeze({ ...trace.dimensions }),
    expectations: Object.freeze({ ...trace.expectations }),
    marks: Object.freeze({ ...trace.marks }),
  });
}

const DEVICE_CLASSES = new Set<VoiceDeviceClass>([
  "builtin",
  "usb",
  "bluetooth",
  "wired",
  "virtual",
  "unknown",
]);

const TRANSPORTS = new Set<VoiceTransportKind>([
  "websocket",
  "webrtc",
  "http_sse",
  "local",
  "unknown",
]);

const GRANTED_CONSTRAINTS = new Set<GrantedConstraint>([
  true,
  false,
  "unknown",
]);

function staticLabel(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) ||
    /(?:^|[-_:])(?:sk|csk|gsk|ghp|token|secret|key)(?:[-_:]|$)/i.test(value)
  ) {
    return "unknown";
  }
  return value;
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}

function opaqueId(value: unknown, field: string): string {
  if (!isOpaqueId(value)) throw new TypeError(`${field} must be an opaque id`);
  return value;
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function grantedConstraint(value: unknown): GrantedConstraint {
  return GRANTED_CONSTRAINTS.has(value as GrantedConstraint)
    ? (value as GrantedConstraint)
    : "unknown";
}

export function sanitizeRealtimeVoiceTraceDimensions(
  input: RealtimeVoiceTraceDimensionsInput = {},
): RealtimeVoiceTraceDimensions {
  return {
    sttProvider: staticLabel(input.sttProvider),
    modelProvider: staticLabel(input.modelProvider),
    modelRoute: staticLabel(input.modelRoute),
    ttsProvider: staticLabel(input.ttsProvider),
    transport: TRANSPORTS.has(input.transport as VoiceTransportKind)
      ? (input.transport as VoiceTransportKind)
      : "unknown",
    frameDurationMs: boundedNumber(input.frameDurationMs, 1, 1_000),
    sampleRateHz: boundedNumber(input.sampleRateHz, 8_000, 384_000),
    echoCancellation: grantedConstraint(input.echoCancellation),
    noiseSuppression: grantedConstraint(input.noiseSuppression),
    autoGainControl: grantedConstraint(input.autoGainControl),
    inputDeviceClass: DEVICE_CLASSES.has(
      input.inputDeviceClass as VoiceDeviceClass,
    )
      ? (input.inputDeviceClass as VoiceDeviceClass)
      : "unknown",
    outputDeviceClass: DEVICE_CLASSES.has(
      input.outputDeviceClass as VoiceDeviceClass,
    )
      ? (input.outputDeviceClass as VoiceDeviceClass)
      : "unknown",
  };
}

function validTimestamp(atMs: number): void {
  if (!Number.isFinite(atMs)) throw new TypeError("atMs must be finite");
}

export function createRealtimeVoiceTrace(
  input: CreateRealtimeVoiceTraceInput,
): RealtimeVoiceTrace {
  validTimestamp(input.atMs);
  const manifest = expectationManifest(input.profiles);
  if (input.responseId !== undefined && input.responseId !== null) {
    opaqueId(input.responseId, "responseId");
  }
  return frozenTrace({
    schemaVersion: 1,
    sessionId: opaqueId(input.sessionId, "sessionId"),
    turnId: opaqueId(input.turnId, "turnId"),
    responseId:
      typeof input.responseId === "string"
        ? opaqueId(input.responseId, "responseId")
        : null,
    createdAtMs: input.atMs,
    finalizedAtMs: null,
    outcome: "open",
    profiles: manifest.profiles,
    dimensions: sanitizeRealtimeVoiceTraceDimensions(input.dimensions),
    expectations: manifest.expectations,
    marks: {},
    lateAudioFrames: 0,
    lastLateAudioFrameAtMs: null,
  });
}

export function markRealtimeVoiceTrace(
  trace: RealtimeVoiceTrace,
  mark: RealtimeVoiceTraceMark,
  atMs: number,
): RealtimeVoiceTrace {
  validTimestamp(atMs);
  if (trace.outcome !== "open" || atMs < trace.createdAtMs) return trace;
  const previous = trace.marks[mark];
  const shouldUpdate =
    previous === undefined ||
    (mark === "first_audio_playout" && atMs < previous) ||
    (mark === "last_audio_playout" && atMs > previous);
  if (!shouldUpdate) return trace;
  return frozenTrace({
    ...trace,
    marks: { ...trace.marks, [mark]: atMs },
  });
}

export function noteLateRealtimeVoiceAudioFrame(
  trace: RealtimeVoiceTrace,
  atMs: number,
): RealtimeVoiceTrace {
  validTimestamp(atMs);
  if (atMs < trace.createdAtMs) return trace;
  return frozenTrace({
    ...trace,
    lateAudioFrames: trace.lateAudioFrames + 1,
    lastLateAudioFrameAtMs: atMs,
  });
}

export function finalizeRealtimeVoiceTrace(
  trace: RealtimeVoiceTrace,
  outcome: Exclude<RealtimeVoiceTraceOutcome, "open">,
  atMs: number,
): RealtimeVoiceTrace {
  validTimestamp(atMs);
  if (!FINAL_OUTCOMES.has(outcome)) return trace;
  if (trace.outcome !== "open" || atMs < trace.createdAtMs) return trace;
  const latestMark = Math.max(trace.createdAtMs, ...Object.values(trace.marks));
  if (atMs < latestMark) return trace;
  const marked = markRealtimeVoiceTrace(trace, "turn_ended", atMs);
  return frozenTrace({ ...marked, finalizedAtMs: atMs, outcome });
}

const DIMENSION_KEYS = new Set<keyof RealtimeVoiceTraceDimensions>([
  "sttProvider",
  "modelProvider",
  "modelRoute",
  "ttsProvider",
  "transport",
  "frameDurationMs",
  "sampleRateHz",
  "echoCancellation",
  "noiseSuppression",
  "autoGainControl",
  "inputDeviceClass",
  "outputDeviceClass",
]);

function recordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

/** Strict schema-v1 parser for rehydrated JSON; extra content-bearing keys fail. */
export function parseRealtimeVoiceTrace(
  input: unknown,
): RealtimeVoiceTrace | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const trace = input as Record<string, unknown>;
  const allowedTraceKeys = new Set([
    "schemaVersion",
    "sessionId",
    "turnId",
    "responseId",
    "createdAtMs",
    "finalizedAtMs",
    "outcome",
    "profiles",
    "dimensions",
    "expectations",
    "marks",
    "lateAudioFrames",
    "lastLateAudioFrameAtMs",
  ]);
  if (Object.keys(trace).some((key) => !allowedTraceKeys.has(key))) return null;
  if (
    trace.schemaVersion !== 1 ||
    !isOpaqueId(trace.sessionId) ||
    !isOpaqueId(trace.turnId) ||
    (trace.responseId !== null && !isOpaqueId(trace.responseId)) ||
    typeof trace.createdAtMs !== "number" ||
    !Number.isFinite(trace.createdAtMs) ||
    !Array.isArray(trace.profiles) ||
    trace.profiles.length === 0 ||
    trace.profiles.some((profile) => !TRACE_PROFILES.has(profile)) ||
    new Set(trace.profiles).size !== trace.profiles.length
  ) {
    return null;
  }
  const manifest = expectationManifest(
    trace.profiles as RealtimeVoiceTraceProfile[],
  );
  if (
    !trace.expectations ||
    typeof trace.expectations !== "object" ||
    Array.isArray(trace.expectations) ||
    !recordsEqual(
      trace.expectations as Record<string, unknown>,
      manifest.expectations as unknown as Record<string, unknown>,
    )
  ) {
    return null;
  }
  if (
    !trace.dimensions ||
    typeof trace.dimensions !== "object" ||
    Array.isArray(trace.dimensions)
  ) {
    return null;
  }
  const dimensions = trace.dimensions as Record<string, unknown>;
  if (
    Object.keys(dimensions).length !== DIMENSION_KEYS.size ||
    Object.keys(dimensions).some(
      (key) => !DIMENSION_KEYS.has(key as keyof RealtimeVoiceTraceDimensions),
    )
  ) {
    return null;
  }
  const sanitizedDimensions = sanitizeRealtimeVoiceTraceDimensions(
    dimensions as unknown as RealtimeVoiceTraceDimensionsInput,
  );
  if (
    !recordsEqual(
      dimensions,
      sanitizedDimensions as unknown as Record<string, unknown>,
    )
  ) {
    return null;
  }
  if (
    !trace.marks ||
    typeof trace.marks !== "object" ||
    Array.isArray(trace.marks)
  ) {
    return null;
  }
  const marks = trace.marks as Record<string, unknown>;
  if (
    Object.entries(marks).some(
      ([mark, atMs]) =>
        !TRACE_MARKS.has(mark as RealtimeVoiceTraceMark) ||
        typeof atMs !== "number" ||
        !Number.isFinite(atMs) ||
        atMs < (trace.createdAtMs as number),
    )
  ) {
    return null;
  }
  const outcome = trace.outcome;
  if (outcome !== "open" && !FINAL_OUTCOMES.has(outcome as never)) return null;
  const finalizedAtMs = trace.finalizedAtMs;
  const latestMark = Math.max(
    trace.createdAtMs as number,
    ...(Object.values(marks).filter(
      (value): value is number => typeof value === "number",
    ) as number[]),
  );
  if (
    (outcome === "open" && finalizedAtMs !== null) ||
    (outcome !== "open" &&
      (typeof finalizedAtMs !== "number" ||
        !Number.isFinite(finalizedAtMs) ||
        finalizedAtMs < (trace.createdAtMs as number) ||
        finalizedAtMs < latestMark ||
        marks.turn_ended !== finalizedAtMs))
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(trace.lateAudioFrames) ||
    (trace.lateAudioFrames as number) < 0 ||
    ((trace.lateAudioFrames as number) === 0) !==
      (trace.lastLateAudioFrameAtMs === null) ||
    (trace.lastLateAudioFrameAtMs !== null &&
      (typeof trace.lastLateAudioFrameAtMs !== "number" ||
        !Number.isFinite(trace.lastLateAudioFrameAtMs) ||
        trace.lastLateAudioFrameAtMs < (trace.createdAtMs as number)))
  ) {
    return null;
  }
  return frozenTrace({
    schemaVersion: 1,
    sessionId: trace.sessionId,
    turnId: trace.turnId,
    responseId: trace.responseId as string | null,
    createdAtMs: trace.createdAtMs,
    finalizedAtMs: finalizedAtMs as number | null,
    outcome: outcome as RealtimeVoiceTraceOutcome,
    profiles: manifest.profiles,
    dimensions: sanitizedDimensions,
    expectations: manifest.expectations,
    marks: marks as Partial<Record<RealtimeVoiceTraceMark, number>>,
    lateAudioFrames: trace.lateAudioFrames as number,
    lastLateAudioFrameAtMs: trace.lastLateAudioFrameAtMs as number | null,
  });
}

const METRIC_DEFINITIONS: Readonly<
  Record<
    VoiceLatencyMetricName,
    {
      from: RealtimeVoiceTraceMark;
      to: RealtimeVoiceTraceMark;
      expected: keyof RealtimeVoiceTraceExpectations;
      p50LimitMs?: number;
      p95LimitMs?: number;
    }
  >
> = {
  speech_to_local_silence: {
    from: "local_speech_detected",
    to: "local_playback_paused",
    expected: "interruption",
    p95LimitMs: 100,
  },
  speech_to_server_ack: {
    from: "local_speech_detected",
    to: "server_interrupt_ack",
    expected: "interruption",
    p95LimitMs: 250,
  },
  acoustic_end_to_stt_final: {
    from: "acoustic_speech_ended",
    to: "stt_final",
    expected: "transcription",
    p95LimitMs: 1_200,
  },
  commit_to_first_model_text: {
    from: "turn_committed",
    to: "llm_first_useful_text",
    expected: "modelResponse",
    p95LimitMs: 700,
  },
  speakable_text_to_tts_byte: {
    from: "speakable_text_ready",
    to: "tts_first_byte",
    expected: "spokenResponse",
    p95LimitMs: 350,
  },
  acoustic_end_to_audible: {
    from: "acoustic_speech_ended",
    to: "first_audio_playout",
    expected: "spokenResponse",
    p50LimitMs: 1_000,
    p95LimitMs: 1_500,
  },
  reconnect_recovery: {
    from: "reconnect_started",
    to: "reconnect_ready",
    expected: "reconnect",
    p95LimitMs: 3_000,
  },
  commit_to_tool_mutation: {
    from: "turn_committed",
    to: "tool_mutation_committed",
    expected: "mutatingTool",
  },
};

function percentile(
  sorted: readonly number[],
  quantile: number,
): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? null;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function summarizeMetric(
  traces: readonly RealtimeVoiceTrace[],
  metric: VoiceLatencyMetricName,
): VoiceLatencyMetricSummary {
  const definition = METRIC_DEFINITIONS[metric];
  const eligible = traces.filter(
    (trace) => trace.expectations[definition.expected],
  );
  const samples: number[] = [];
  let invalidCount = 0;
  for (const trace of eligible) {
    const from = trace.marks[definition.from];
    const to = trace.marks[definition.to];
    if (from === undefined || to === undefined) continue;
    const duration = to - from;
    if (!Number.isFinite(duration) || duration < 0) {
      invalidCount += 1;
    } else {
      samples.push(duration);
    }
  }
  samples.sort((left, right) => left - right);
  const p50Ms = percentile(samples, 0.5);
  const p95Ms = percentile(samples, 0.95);
  const p99Ms = percentile(samples, 0.99);
  const expectedCount = eligible.length;
  const coveragePassed = samples.length === expectedCount && invalidCount === 0;
  const sloPassed =
    coveragePassed &&
    (expectedCount === 0 ||
      ((definition.p50LimitMs === undefined ||
        (p50Ms !== null && p50Ms <= definition.p50LimitMs)) &&
        (definition.p95LimitMs === undefined ||
          (p95Ms !== null && p95Ms <= definition.p95LimitMs))));
  return {
    metric,
    count: samples.length,
    expectedCount,
    invalidCount,
    p50Ms,
    p95Ms,
    p99Ms,
    maxMs: samples.at(-1) ?? null,
    coveragePassed,
    sloPassed,
  };
}

export function inspectRealtimeVoiceTraceCoverage(
  trace: RealtimeVoiceTrace,
): RealtimeVoiceTraceCoverage {
  const required = new Set<RealtimeVoiceTraceMark>(["turn_ended"]);
  for (const definition of Object.values(METRIC_DEFINITIONS)) {
    if (trace.expectations[definition.expected]) {
      required.add(definition.from);
      required.add(definition.to);
    }
  }
  const requiredMarks = [...required];
  const missingMarks = requiredMarks.filter(
    (mark) => trace.marks[mark] === undefined,
  );
  const finalized =
    trace.outcome !== "open" &&
    trace.finalizedAtMs !== null &&
    trace.marks.turn_ended === trace.finalizedAtMs;
  const interruptionOnly =
    trace.expectations.interruption &&
    !trace.expectations.transcription &&
    !trace.expectations.modelResponse &&
    !trace.expectations.spokenResponse &&
    !trace.expectations.mutatingTool;
  const outcomePassed = trace.expectations.spokenResponse
    ? trace.outcome === "spoken"
    : interruptionOnly
      ? trace.outcome === "interrupted"
      : trace.outcome !== "open" && trace.outcome !== "error";
  return {
    complete: finalized && outcomePassed && missingMarks.length === 0,
    finalized,
    outcomePassed,
    requiredMarks,
    missingMarks,
  };
}

export function summarizeRealtimeVoiceLatency(
  traces: readonly RealtimeVoiceTrace[],
  options: RealtimeVoiceLatencyReportOptions = {},
): RealtimeVoiceLatencyReport {
  const validTraces = traces
    .map((trace) => parseRealtimeVoiceTrace(trace))
    .filter((trace): trace is RealtimeVoiceTrace => trace !== null);
  const invalidTraceCount = traces.length - validTraces.length;
  const traceValidityPassed = invalidTraceCount === 0;
  const metrics = Object.fromEntries(
    (Object.keys(METRIC_DEFINITIONS) as VoiceLatencyMetricName[]).map(
      (metric) => [metric, summarizeMetric(validTraces, metric)],
    ),
  ) as Record<VoiceLatencyMetricName, VoiceLatencyMetricSummary>;
  const lateAudioFrames = validTraces.reduce(
    (total, trace) => total + trace.lateAudioFrames,
    0,
  );
  const coveragePassed =
    traceValidityPassed &&
    Object.values(metrics).every((metric) => metric.coveragePassed) &&
    validTraces.every(
      (trace) => inspectRealtimeVoiceTraceCoverage(trace).complete,
    );
  const sloPassed = Object.values(metrics).every((metric) => metric.sloPassed);
  const zeroLateAudioPassed = lateAudioFrames === 0;
  let requirementsValid = true;
  const rawOptions: unknown = options;
  const optionsRecord =
    rawOptions !== null &&
    typeof rawOptions === "object" &&
    !Array.isArray(rawOptions)
      ? (rawOptions as Record<string, unknown>)
      : null;
  if (
    optionsRecord === null ||
    Object.keys(optionsRecord).some(
      (key) => key !== "minimumTraceCount" && key !== "minimumProfileCounts",
    )
  ) {
    requirementsValid = false;
  }
  const rawMinimumTraceCount = optionsRecord?.minimumTraceCount;
  if (
    rawMinimumTraceCount !== undefined &&
    (typeof rawMinimumTraceCount !== "number" ||
      !Number.isFinite(rawMinimumTraceCount) ||
      rawMinimumTraceCount < 0)
  ) {
    requirementsValid = false;
  }
  const minimumTraceCount = Math.max(
    1,
    Math.floor(
      typeof rawMinimumTraceCount === "number" &&
        Number.isFinite(rawMinimumTraceCount)
        ? rawMinimumTraceCount
        : 1,
    ),
  );
  const completedTraceCount = validTraces.filter(
    (trace) => inspectRealtimeVoiceTraceCoverage(trace).finalized,
  ).length;
  const cohortSizePassed = validTraces.length >= minimumTraceCount;
  const completionPassed =
    traceValidityPassed &&
    validTraces.length > 0 &&
    completedTraceCount === validTraces.length;
  const profileCounts = Object.fromEntries(
    TRACE_PROFILE_LIST.map((profile) => [
      profile,
      validTraces.filter((trace) => trace.profiles.includes(profile)).length,
    ]),
  ) as Record<RealtimeVoiceTraceProfile, number>;
  const rawMinimumProfileCounts = optionsRecord?.minimumProfileCounts;
  const profileOptions =
    rawMinimumProfileCounts === undefined
      ? {}
      : rawMinimumProfileCounts !== null &&
          typeof rawMinimumProfileCounts === "object" &&
          !Array.isArray(rawMinimumProfileCounts)
        ? (rawMinimumProfileCounts as Record<string, unknown>)
        : null;
  if (
    profileOptions === null ||
    Object.keys(profileOptions).some(
      (key) => !TRACE_PROFILES.has(key as RealtimeVoiceTraceProfile),
    )
  ) {
    requirementsValid = false;
  }
  const minimumProfileCounts = Object.fromEntries(
    TRACE_PROFILE_LIST.map((profile) => {
      const requested = profileOptions?.[profile];
      if (
        requested !== undefined &&
        (typeof requested !== "number" ||
          !Number.isFinite(requested) ||
          requested < 0)
      ) {
        requirementsValid = false;
      }
      return [
        profile,
        Math.max(
          0,
          Math.floor(
            typeof requested === "number" && Number.isFinite(requested)
              ? requested
              : 0,
          ),
        ),
      ];
    }),
  ) as Record<RealtimeVoiceTraceProfile, number>;
  const profileCoveragePassed = TRACE_PROFILE_LIST.every(
    (profile) => profileCounts[profile] >= minimumProfileCounts[profile],
  );
  return {
    traceCount: traces.length,
    completedTraceCount,
    invalidTraceCount,
    minimumTraceCount,
    cohortSizePassed,
    completionPassed,
    traceValidityPassed,
    requirementsValid,
    profileCounts,
    minimumProfileCounts,
    profileCoveragePassed,
    metrics,
    lateAudioFrames,
    zeroLateAudioPassed,
    coveragePassed,
    sloPassed,
    passed:
      cohortSizePassed &&
      completionPassed &&
      traceValidityPassed &&
      requirementsValid &&
      profileCoveragePassed &&
      coveragePassed &&
      sloPassed &&
      zeroLateAudioPassed,
  };
}
