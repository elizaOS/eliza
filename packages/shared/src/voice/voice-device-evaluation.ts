/**
 * Defines the content-free, provider-neutral evidence contract used to gate
 * realtime voice behavior across synthetic fixtures and physical devices.
 * Records contain only bounded measurements and fixed classifications: never
 * raw audio, transcripts, device identifiers, secrets, or inferred ERLE.
 */

export const VOICE_DEVICE_EVALUATION_PROFILES = [
  "capture_routing",
  "transport_continuity",
  "barge_in",
  "double_talk",
] as const;

export type VoiceDeviceEvaluationProfile =
  (typeof VOICE_DEVICE_EVALUATION_PROFILES)[number];

export const VOICE_EVALUATION_DEVICE_CLASSES = [
  "builtin",
  "speakerphone",
  "usb",
  "bluetooth",
  "wired",
  "hearing_device",
  "virtual",
  "unknown",
] as const;

export type VoiceEvaluationDeviceClass =
  (typeof VOICE_EVALUATION_DEVICE_CLASSES)[number];

export const VOICE_DEVICE_EVIDENCE_KINDS = [
  "deterministic_fake_media",
  "real_device_offline",
  "real_device_live_provider",
] as const;

export type VoiceDeviceEvidenceKind =
  (typeof VOICE_DEVICE_EVIDENCE_KINDS)[number];

export type VoiceDeviceMeasurementStatus =
  | "passed"
  | "failed"
  | "unsupported"
  | "not_measured";

export type VoiceConstraintGrant = boolean | "unknown";
export type VoiceMeasuredNumber = number | "not_measured";

export type VoiceEvaluationClockDomain =
  | "browser_monotonic"
  | "audio_context_monotonic"
  | "server_monotonic"
  | "synthetic_monotonic";

export type VoiceEvaluationTransportKind =
  | "websocket"
  | "webrtc"
  | "http_sse"
  | "local"
  | "unknown";

export interface VoiceEvaluationProviderPath {
  readonly sttProvider: string;
  readonly modelProvider: string;
  readonly ttsProvider: string;
  readonly transport: VoiceEvaluationTransportKind;
  readonly roundTrip: VoiceDeviceMeasurementStatus;
}

export interface VoiceEvaluationClockMark {
  readonly clockDomain: VoiceEvaluationClockDomain;
  readonly atMs: number;
}

export interface VoiceEvaluationMeasurementWindow {
  readonly startedAt: VoiceEvaluationClockMark;
  readonly endedAt: VoiceEvaluationClockMark;
}

export interface VoiceRequestedCaptureSettings {
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly echoCancellation: boolean;
  readonly noiseSuppression: boolean;
  readonly autoGainControl: boolean;
}

export interface VoiceGrantedCaptureSettings {
  readonly sampleRateHz: number | "unknown";
  readonly channelCount: number | "unknown";
  readonly echoCancellation: VoiceConstraintGrant;
  readonly noiseSuppression: VoiceConstraintGrant;
  readonly autoGainControl: VoiceConstraintGrant;
}

export interface VoiceCaptureEvaluation {
  readonly requested: VoiceRequestedCaptureSettings;
  readonly granted: VoiceGrantedCaptureSettings;
  readonly inputDeviceClass: VoiceEvaluationDeviceClass;
  readonly inputSelection: VoiceDeviceMeasurementStatus;
  readonly deviceChangeHandling: VoiceDeviceMeasurementStatus;
}

export interface VoicePlaybackEvaluation {
  readonly requestedSampleRateHz: number;
  readonly actualSampleRateHz: VoiceMeasuredNumber;
  readonly outputDeviceClass: VoiceEvaluationDeviceClass;
  readonly outputSelection: VoiceDeviceMeasurementStatus;
  readonly sampleRateConversion: VoiceDeviceMeasurementStatus;
}

/** Frame counts must come from the same transport hop and clock boundary. */
export interface VoiceTransportContinuityEvaluation {
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly requestedFrameDurationMs: number;
  readonly observedFrameDurationMs: VoiceMeasuredNumber;
  readonly sentFrameCount: number;
  readonly receivedFrameCount: number;
  readonly packetGapCount: number;
  readonly duplicateFrameCount: number;
  readonly outOfOrderFrameCount: number;
  readonly continuity: VoiceDeviceMeasurementStatus;
}

export interface VoiceBargeInEvaluation {
  readonly trialCount: number;
  readonly successfulInterruptionCount: number;
  readonly localSpeechToSilenceP95Ms: VoiceMeasuredNumber;
  readonly serverSpeechToAckP95Ms: VoiceMeasuredNumber;
  readonly lateAudioFrames: VoiceMeasuredNumber;
  readonly replacementContextIntegrity: VoiceDeviceMeasurementStatus;
  readonly status: VoiceDeviceMeasurementStatus;
}

/**
 * Behavioral double-talk evidence intentionally contains no ERLE estimate.
 * Boolean browser constraints do not establish echo-cancellation quality.
 */
export interface VoiceDoubleTalkEvaluation {
  readonly trialCount: number;
  readonly successfulUserSpeechDetectionCount: number;
  readonly echoOnlyTrialCount: number;
  readonly echoOnlyFalseTurnCount: number;
  readonly status: VoiceDeviceMeasurementStatus;
}

export interface VoiceDeviceEvaluationObservation {
  readonly schemaVersion: 1;
  readonly evaluationId: string;
  readonly profile: VoiceDeviceEvaluationProfile;
  readonly evidenceKind: VoiceDeviceEvidenceKind;
  readonly providerPath: VoiceEvaluationProviderPath;
  readonly measurementWindow: VoiceEvaluationMeasurementWindow;
  readonly capture: VoiceCaptureEvaluation;
  readonly playback: VoicePlaybackEvaluation;
  readonly transport: VoiceTransportContinuityEvaluation;
  readonly bargeIn: VoiceBargeInEvaluation;
  readonly doubleTalk: VoiceDoubleTalkEvaluation;
}

export interface VoiceDeviceProfileMinimum {
  readonly profile: VoiceDeviceEvaluationProfile;
  readonly minimumSyntheticRuns: number;
  readonly minimumRealProviderRuns: number;
}

export interface VoiceDeviceMatrixMinimum {
  readonly profile: VoiceDeviceEvaluationProfile;
  readonly inputDeviceClass: VoiceEvaluationDeviceClass;
  readonly outputDeviceClass: VoiceEvaluationDeviceClass;
  readonly minimumRealProviderRuns: number;
}

/**
 * Every release manifest must name all profiles and every profile/device pair.
 * Synthetic and real-provider minimums are deliberately separate.
 */
export interface VoiceDeviceEvaluationRequirements {
  readonly profileMinimums: readonly VoiceDeviceProfileMinimum[];
  readonly deviceMatrixMinimums: readonly VoiceDeviceMatrixMinimum[];
}

export interface VoiceDeviceProfileEvaluationSummary {
  readonly profile: VoiceDeviceEvaluationProfile;
  readonly syntheticPassedCount: number;
  readonly realDeviceOfflinePassedCount: number;
  readonly realProviderPassedCount: number;
  readonly minimumSyntheticRuns: number | null;
  readonly minimumRealProviderRuns: number | null;
  readonly syntheticCoveragePassed: boolean;
  readonly realProviderCoveragePassed: boolean;
}

export interface VoiceDeviceMatrixCellSummary {
  readonly profile: VoiceDeviceEvaluationProfile;
  readonly inputDeviceClass: VoiceEvaluationDeviceClass;
  readonly outputDeviceClass: VoiceEvaluationDeviceClass;
  readonly passedCount: number;
  readonly minimumRealProviderRuns: number;
  readonly coveragePassed: boolean;
}

export interface VoiceDeviceMeasurementStatusCounts {
  readonly passed: number;
  readonly failed: number;
  readonly unsupported: number;
  readonly not_measured: number;
}

export interface VoiceDeviceEvidenceCounts {
  readonly deterministic_fake_media: number;
  readonly real_device_offline: number;
  readonly real_device_live_provider: number;
}

export interface VoiceDeviceEvaluationSummary {
  readonly inputValid: boolean;
  readonly requirementsValid: boolean;
  readonly observationCount: number;
  readonly validObservationCount: number;
  readonly malformedObservationCount: number;
  readonly duplicateObservationCount: number;
  readonly invalidObservationCount: number;
  readonly measurementPassedCount: number;
  readonly measurementFailedCount: number;
  readonly allMeasurementsPassed: boolean;
  readonly evidenceCounts: VoiceDeviceEvidenceCounts;
  readonly measurementStatusCounts: VoiceDeviceMeasurementStatusCounts;
  readonly captureSettingsMeasuredCount: number;
  readonly captureSettingsIncompleteCount: number;
  readonly captureSettingsUnknownCount: number;
  readonly captureGrantDifferenceCount: number;
  readonly profiles: Readonly<
    Record<VoiceDeviceEvaluationProfile, VoiceDeviceProfileEvaluationSummary>
  >;
  readonly matrix: readonly VoiceDeviceMatrixCellSummary[];
  readonly profileCoveragePassed: boolean;
  readonly deviceMatrixPassed: boolean;
  readonly lateAudioFrames: number;
  readonly zeroLateAudioPassed: boolean;
  readonly passed: boolean;
}

const PROFILE_SET = new Set<string>(VOICE_DEVICE_EVALUATION_PROFILES);
const DEVICE_CLASS_SET = new Set<string>(VOICE_EVALUATION_DEVICE_CLASSES);
const EVIDENCE_KIND_SET = new Set<string>(VOICE_DEVICE_EVIDENCE_KINDS);
const STATUS_SET = new Set<string>([
  "passed",
  "failed",
  "unsupported",
  "not_measured",
]);
const CLOCK_DOMAIN_SET = new Set<string>([
  "browser_monotonic",
  "audio_context_monotonic",
  "server_monotonic",
  "synthetic_monotonic",
]);
const TRANSPORT_SET = new Set<string>([
  "websocket",
  "webrtc",
  "http_sse",
  "local",
  "unknown",
]);
const NON_LIVE_PROVIDER_LABELS = new Set([
  "unknown",
  "none",
  "deterministic",
  "fake",
  "mock",
  "stub",
]);
const PHYSICAL_DEVICE_CLASSES = new Set<VoiceEvaluationDeviceClass>([
  "builtin",
  "speakerphone",
  "usb",
  "bluetooth",
  "wired",
  "hearing_device",
]);

const MAX_COUNT = 1_000_000_000;
const MAX_OBSERVATION_COUNT = 10_000;
const MAX_DEVICE_MATRIX_REQUIREMENTS = 4_096;
const MAX_MEASUREMENT_WINDOW_MS = 86_400_000;
const TARGET_TRANSPORT_SAMPLE_RATE_HZ = 16_000;
const MIN_TARGET_FRAME_DURATION_MS = 20;
const MAX_TARGET_FRAME_DURATION_MS = 40;
const LOCAL_SILENCE_P95_LIMIT_MS = 100;
const SERVER_ACK_P95_LIMIT_MS = 250;

type UnknownRecord = Record<string, unknown>;

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as UnknownRecord;
  const actualKeys = Object.keys(record);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key))
  );
}

function finiteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function finiteInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return finiteNumber(value, minimum, maximum) && Number.isSafeInteger(value);
}

function measuredNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is VoiceMeasuredNumber {
  return value === "not_measured" || finiteNumber(value, minimum, maximum);
}

function constraintGrant(value: unknown): value is VoiceConstraintGrant {
  return value === true || value === false || value === "unknown";
}

function validStatus(value: unknown): value is VoiceDeviceMeasurementStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

function validEvaluationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function validProviderLabel(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(value) ||
    /(?:^|[._-])(?:sk|csk|gsk|ghp|token|secret|api[_-]?key)(?:[._-]|$)/i.test(
      value,
    )
  ) {
    return false;
  }
  return (value.match(/\./g)?.length ?? 0) < 2;
}

function physicalDeviceClass(value: VoiceEvaluationDeviceClass): boolean {
  return PHYSICAL_DEVICE_CLASSES.has(value);
}

function freezeObservation(
  observation: VoiceDeviceEvaluationObservation,
): VoiceDeviceEvaluationObservation {
  return Object.freeze({
    ...observation,
    providerPath: Object.freeze({ ...observation.providerPath }),
    measurementWindow: Object.freeze({
      startedAt: Object.freeze({ ...observation.measurementWindow.startedAt }),
      endedAt: Object.freeze({ ...observation.measurementWindow.endedAt }),
    }),
    capture: Object.freeze({
      ...observation.capture,
      requested: Object.freeze({ ...observation.capture.requested }),
      granted: Object.freeze({ ...observation.capture.granted }),
    }),
    playback: Object.freeze({ ...observation.playback }),
    transport: Object.freeze({ ...observation.transport }),
    bargeIn: Object.freeze({ ...observation.bargeIn }),
    doubleTalk: Object.freeze({ ...observation.doubleTalk }),
  });
}

function parseObservationUnsafe(
  input: unknown,
): VoiceDeviceEvaluationObservation | null {
  if (
    !exactRecord(input, [
      "schemaVersion",
      "evaluationId",
      "profile",
      "evidenceKind",
      "providerPath",
      "measurementWindow",
      "capture",
      "playback",
      "transport",
      "bargeIn",
      "doubleTalk",
    ]) ||
    input.schemaVersion !== 1 ||
    !validEvaluationId(input.evaluationId) ||
    typeof input.profile !== "string" ||
    !PROFILE_SET.has(input.profile) ||
    typeof input.evidenceKind !== "string" ||
    !EVIDENCE_KIND_SET.has(input.evidenceKind)
  ) {
    return null;
  }

  if (
    !exactRecord(input.providerPath, [
      "sttProvider",
      "modelProvider",
      "ttsProvider",
      "transport",
      "roundTrip",
    ]) ||
    !validProviderLabel(input.providerPath.sttProvider) ||
    !validProviderLabel(input.providerPath.modelProvider) ||
    !validProviderLabel(input.providerPath.ttsProvider) ||
    typeof input.providerPath.transport !== "string" ||
    !TRANSPORT_SET.has(input.providerPath.transport) ||
    !validStatus(input.providerPath.roundTrip)
  ) {
    return null;
  }

  if (
    !exactRecord(input.measurementWindow, ["startedAt", "endedAt"]) ||
    !exactRecord(input.measurementWindow.startedAt, ["clockDomain", "atMs"]) ||
    !exactRecord(input.measurementWindow.endedAt, ["clockDomain", "atMs"])
  ) {
    return null;
  }
  const startedAt = input.measurementWindow.startedAt;
  const endedAt = input.measurementWindow.endedAt;
  if (
    typeof startedAt.clockDomain !== "string" ||
    !CLOCK_DOMAIN_SET.has(startedAt.clockDomain) ||
    typeof endedAt.clockDomain !== "string" ||
    !CLOCK_DOMAIN_SET.has(endedAt.clockDomain) ||
    startedAt.clockDomain !== endedAt.clockDomain ||
    !finiteNumber(startedAt.atMs, 0, Number.MAX_SAFE_INTEGER) ||
    !finiteNumber(endedAt.atMs, 0, Number.MAX_SAFE_INTEGER) ||
    endedAt.atMs <= startedAt.atMs ||
    endedAt.atMs - startedAt.atMs > MAX_MEASUREMENT_WINDOW_MS
  ) {
    return null;
  }

  if (
    !exactRecord(input.capture, [
      "requested",
      "granted",
      "inputDeviceClass",
      "inputSelection",
      "deviceChangeHandling",
    ]) ||
    !exactRecord(input.capture.requested, [
      "sampleRateHz",
      "channelCount",
      "echoCancellation",
      "noiseSuppression",
      "autoGainControl",
    ]) ||
    !exactRecord(input.capture.granted, [
      "sampleRateHz",
      "channelCount",
      "echoCancellation",
      "noiseSuppression",
      "autoGainControl",
    ])
  ) {
    return null;
  }
  const requested = input.capture.requested;
  const granted = input.capture.granted;
  if (
    !finiteInteger(requested.sampleRateHz, 8_000, 384_000) ||
    !finiteInteger(requested.channelCount, 1, 8) ||
    typeof requested.echoCancellation !== "boolean" ||
    typeof requested.noiseSuppression !== "boolean" ||
    typeof requested.autoGainControl !== "boolean" ||
    !(
      granted.sampleRateHz === "unknown" ||
      finiteInteger(granted.sampleRateHz, 8_000, 384_000)
    ) ||
    !(
      granted.channelCount === "unknown" ||
      finiteInteger(granted.channelCount, 1, 8)
    ) ||
    !constraintGrant(granted.echoCancellation) ||
    !constraintGrant(granted.noiseSuppression) ||
    !constraintGrant(granted.autoGainControl) ||
    typeof input.capture.inputDeviceClass !== "string" ||
    !DEVICE_CLASS_SET.has(input.capture.inputDeviceClass) ||
    !validStatus(input.capture.inputSelection) ||
    !validStatus(input.capture.deviceChangeHandling)
  ) {
    return null;
  }

  if (
    !exactRecord(input.playback, [
      "requestedSampleRateHz",
      "actualSampleRateHz",
      "outputDeviceClass",
      "outputSelection",
      "sampleRateConversion",
    ]) ||
    !finiteInteger(input.playback.requestedSampleRateHz, 8_000, 384_000) ||
    !measuredNumber(input.playback.actualSampleRateHz, 8_000, 384_000) ||
    (typeof input.playback.actualSampleRateHz === "number" &&
      !Number.isSafeInteger(input.playback.actualSampleRateHz)) ||
    typeof input.playback.outputDeviceClass !== "string" ||
    !DEVICE_CLASS_SET.has(input.playback.outputDeviceClass) ||
    !validStatus(input.playback.outputSelection) ||
    !validStatus(input.playback.sampleRateConversion)
  ) {
    return null;
  }

  if (
    !exactRecord(input.transport, [
      "sampleRateHz",
      "channelCount",
      "requestedFrameDurationMs",
      "observedFrameDurationMs",
      "sentFrameCount",
      "receivedFrameCount",
      "packetGapCount",
      "duplicateFrameCount",
      "outOfOrderFrameCount",
      "continuity",
    ]) ||
    !finiteInteger(input.transport.sampleRateHz, 8_000, 384_000) ||
    !finiteInteger(input.transport.channelCount, 1, 8) ||
    !finiteNumber(input.transport.requestedFrameDurationMs, 1, 1_000) ||
    !measuredNumber(input.transport.observedFrameDurationMs, 1, 1_000) ||
    !finiteInteger(input.transport.sentFrameCount, 0, MAX_COUNT) ||
    !finiteInteger(input.transport.receivedFrameCount, 0, MAX_COUNT) ||
    !finiteInteger(input.transport.packetGapCount, 0, MAX_COUNT) ||
    !finiteInteger(input.transport.duplicateFrameCount, 0, MAX_COUNT) ||
    !finiteInteger(input.transport.outOfOrderFrameCount, 0, MAX_COUNT) ||
    !validStatus(input.transport.continuity)
  ) {
    return null;
  }

  if (
    !exactRecord(input.bargeIn, [
      "trialCount",
      "successfulInterruptionCount",
      "localSpeechToSilenceP95Ms",
      "serverSpeechToAckP95Ms",
      "lateAudioFrames",
      "replacementContextIntegrity",
      "status",
    ]) ||
    !finiteInteger(input.bargeIn.trialCount, 0, MAX_COUNT) ||
    !finiteInteger(input.bargeIn.successfulInterruptionCount, 0, MAX_COUNT) ||
    input.bargeIn.successfulInterruptionCount > input.bargeIn.trialCount ||
    !measuredNumber(input.bargeIn.localSpeechToSilenceP95Ms, 0, 60_000) ||
    !measuredNumber(input.bargeIn.serverSpeechToAckP95Ms, 0, 60_000) ||
    !(
      input.bargeIn.lateAudioFrames === "not_measured" ||
      finiteInteger(input.bargeIn.lateAudioFrames, 0, MAX_COUNT)
    ) ||
    !validStatus(input.bargeIn.replacementContextIntegrity) ||
    !validStatus(input.bargeIn.status)
  ) {
    return null;
  }

  if (
    !exactRecord(input.doubleTalk, [
      "trialCount",
      "successfulUserSpeechDetectionCount",
      "echoOnlyTrialCount",
      "echoOnlyFalseTurnCount",
      "status",
    ]) ||
    !finiteInteger(input.doubleTalk.trialCount, 0, MAX_COUNT) ||
    !finiteInteger(
      input.doubleTalk.successfulUserSpeechDetectionCount,
      0,
      MAX_COUNT,
    ) ||
    input.doubleTalk.successfulUserSpeechDetectionCount >
      input.doubleTalk.trialCount ||
    !finiteInteger(input.doubleTalk.echoOnlyTrialCount, 0, MAX_COUNT) ||
    !finiteInteger(input.doubleTalk.echoOnlyFalseTurnCount, 0, MAX_COUNT) ||
    input.doubleTalk.echoOnlyFalseTurnCount >
      input.doubleTalk.echoOnlyTrialCount ||
    !validStatus(input.doubleTalk.status)
  ) {
    return null;
  }

  const evidenceKind = input.evidenceKind as VoiceDeviceEvidenceKind;
  const inputDeviceClass = input.capture
    .inputDeviceClass as VoiceEvaluationDeviceClass;
  const outputDeviceClass = input.playback
    .outputDeviceClass as VoiceEvaluationDeviceClass;
  if (
    evidenceKind === "deterministic_fake_media" &&
    inputDeviceClass !== "virtual"
  ) {
    return null;
  }
  if (
    evidenceKind !== "deterministic_fake_media" &&
    (!physicalDeviceClass(inputDeviceClass) ||
      !physicalDeviceClass(outputDeviceClass))
  ) {
    return null;
  }
  if (evidenceKind === "real_device_live_provider") {
    const providerLabels = [
      input.providerPath.sttProvider,
      input.providerPath.modelProvider,
      input.providerPath.ttsProvider,
    ] as string[];
    if (
      providerLabels.some((label) => NON_LIVE_PROVIDER_LABELS.has(label)) ||
      input.providerPath.transport === "local" ||
      input.providerPath.transport === "unknown"
    ) {
      return null;
    }
  }

  return freezeObservation(
    input as unknown as VoiceDeviceEvaluationObservation,
  );
}

/** Strict schema-v1 parser. Unknown or content-bearing fields fail closed. */
export function parseVoiceDeviceEvaluationObservation(
  input: unknown,
): VoiceDeviceEvaluationObservation | null {
  try {
    return parseObservationUnsafe(input);
  } catch {
    // error-policy:J3 untrusted evidence objects are explicitly invalid.
    return null;
  }
}

/** Parse a bounded serialized artifact without ever accepting partial JSON. */
export function parseVoiceDeviceEvaluationJson(
  serialized: unknown,
): VoiceDeviceEvaluationObservation | null {
  if (
    typeof serialized !== "string" ||
    serialized.trim().length === 0 ||
    serialized.length > 100_000
  ) {
    return null;
  }
  try {
    return parseVoiceDeviceEvaluationObservation(JSON.parse(serialized));
  } catch {
    // error-policy:J3 malformed serialized evidence is explicitly invalid.
    return null;
  }
}

interface ParsedRequirements {
  readonly profileMinimums: Readonly<
    Map<VoiceDeviceEvaluationProfile, VoiceDeviceProfileMinimum>
  >;
  readonly deviceMatrixMinimums: readonly VoiceDeviceMatrixMinimum[];
}

function devicePairKey(
  inputDeviceClass: VoiceEvaluationDeviceClass,
  outputDeviceClass: VoiceEvaluationDeviceClass,
): string {
  return `${inputDeviceClass}->${outputDeviceClass}`;
}

function parseRequirementsUnsafe(input: unknown): ParsedRequirements | null {
  if (
    !exactRecord(input, ["profileMinimums", "deviceMatrixMinimums"]) ||
    !Array.isArray(input.profileMinimums) ||
    !Array.isArray(input.deviceMatrixMinimums) ||
    input.profileMinimums.length !== VOICE_DEVICE_EVALUATION_PROFILES.length ||
    input.deviceMatrixMinimums.length <
      VOICE_DEVICE_EVALUATION_PROFILES.length ||
    input.deviceMatrixMinimums.length > MAX_DEVICE_MATRIX_REQUIREMENTS
  ) {
    return null;
  }

  const profileMinimums = new Map<
    VoiceDeviceEvaluationProfile,
    VoiceDeviceProfileMinimum
  >();
  for (const candidate of input.profileMinimums) {
    if (
      !exactRecord(candidate, [
        "profile",
        "minimumSyntheticRuns",
        "minimumRealProviderRuns",
      ]) ||
      typeof candidate.profile !== "string" ||
      !PROFILE_SET.has(candidate.profile) ||
      !finiteInteger(candidate.minimumSyntheticRuns, 1, MAX_COUNT) ||
      !finiteInteger(candidate.minimumRealProviderRuns, 1, MAX_COUNT) ||
      profileMinimums.has(candidate.profile as VoiceDeviceEvaluationProfile)
    ) {
      return null;
    }
    const minimum = Object.freeze({
      profile: candidate.profile as VoiceDeviceEvaluationProfile,
      minimumSyntheticRuns: candidate.minimumSyntheticRuns,
      minimumRealProviderRuns: candidate.minimumRealProviderRuns,
    });
    profileMinimums.set(minimum.profile, minimum);
  }
  if (
    VOICE_DEVICE_EVALUATION_PROFILES.some(
      (profile) => !profileMinimums.has(profile),
    )
  ) {
    return null;
  }

  const matrixMinimums: VoiceDeviceMatrixMinimum[] = [];
  const matrixKeys = new Set<string>();
  const pairKeys = new Set<string>();
  for (const candidate of input.deviceMatrixMinimums) {
    if (
      !exactRecord(candidate, [
        "profile",
        "inputDeviceClass",
        "outputDeviceClass",
        "minimumRealProviderRuns",
      ]) ||
      typeof candidate.profile !== "string" ||
      !PROFILE_SET.has(candidate.profile) ||
      typeof candidate.inputDeviceClass !== "string" ||
      !DEVICE_CLASS_SET.has(candidate.inputDeviceClass) ||
      typeof candidate.outputDeviceClass !== "string" ||
      !DEVICE_CLASS_SET.has(candidate.outputDeviceClass) ||
      !finiteInteger(candidate.minimumRealProviderRuns, 1, MAX_COUNT)
    ) {
      return null;
    }
    const inputDeviceClass =
      candidate.inputDeviceClass as VoiceEvaluationDeviceClass;
    const outputDeviceClass =
      candidate.outputDeviceClass as VoiceEvaluationDeviceClass;
    if (
      !physicalDeviceClass(inputDeviceClass) ||
      !physicalDeviceClass(outputDeviceClass)
    ) {
      return null;
    }
    const pairKey = devicePairKey(inputDeviceClass, outputDeviceClass);
    const matrixKey = `${candidate.profile}:${pairKey}`;
    if (matrixKeys.has(matrixKey)) return null;
    matrixKeys.add(matrixKey);
    pairKeys.add(pairKey);
    matrixMinimums.push(
      Object.freeze({
        profile: candidate.profile as VoiceDeviceEvaluationProfile,
        inputDeviceClass,
        outputDeviceClass,
        minimumRealProviderRuns: candidate.minimumRealProviderRuns,
      }),
    );
  }

  for (const pairKey of pairKeys) {
    if (
      VOICE_DEVICE_EVALUATION_PROFILES.some(
        (profile) => !matrixKeys.has(`${profile}:${pairKey}`),
      )
    ) {
      return null;
    }
  }

  return {
    profileMinimums,
    deviceMatrixMinimums: Object.freeze(matrixMinimums),
  };
}

function parseRequirements(input: unknown): ParsedRequirements | null {
  try {
    return parseRequirementsUnsafe(input);
  } catch {
    // error-policy:J3 malformed release requirements fail closed.
    return null;
  }
}

function knownOrUnsupported(status: VoiceDeviceMeasurementStatus): boolean {
  return status === "passed" || status === "unsupported";
}

function captureMeasurementsPassed(
  observation: VoiceDeviceEvaluationObservation,
): boolean {
  const { capture, playback } = observation;
  return (
    capture.requested.channelCount === 1 &&
    capture.requested.echoCancellation &&
    capture.requested.noiseSuppression &&
    capture.requested.autoGainControl &&
    capture.granted.sampleRateHz !== "unknown" &&
    capture.granted.channelCount !== "unknown" &&
    capture.granted.echoCancellation !== "unknown" &&
    capture.granted.noiseSuppression !== "unknown" &&
    capture.granted.autoGainControl !== "unknown" &&
    capture.inputDeviceClass !== "unknown" &&
    playback.outputDeviceClass !== "unknown" &&
    knownOrUnsupported(capture.inputSelection) &&
    knownOrUnsupported(capture.deviceChangeHandling) &&
    knownOrUnsupported(playback.outputSelection) &&
    playback.actualSampleRateHz !== "not_measured" &&
    playback.sampleRateConversion === "passed"
  );
}

function transportMeasurementsPassed(
  observation: VoiceDeviceEvaluationObservation,
): boolean {
  const { transport } = observation;
  return (
    transport.continuity === "passed" &&
    transport.sampleRateHz === TARGET_TRANSPORT_SAMPLE_RATE_HZ &&
    transport.channelCount === 1 &&
    transport.requestedFrameDurationMs >= MIN_TARGET_FRAME_DURATION_MS &&
    transport.requestedFrameDurationMs <= MAX_TARGET_FRAME_DURATION_MS &&
    typeof transport.observedFrameDurationMs === "number" &&
    transport.observedFrameDurationMs >= MIN_TARGET_FRAME_DURATION_MS &&
    transport.observedFrameDurationMs <= MAX_TARGET_FRAME_DURATION_MS &&
    Math.abs(
      transport.requestedFrameDurationMs - transport.observedFrameDurationMs,
    ) <= 0.5 &&
    transport.sentFrameCount > 0 &&
    transport.receivedFrameCount === transport.sentFrameCount &&
    transport.packetGapCount === 0 &&
    transport.duplicateFrameCount === 0 &&
    transport.outOfOrderFrameCount === 0
  );
}

function bargeInMeasurementsPassed(
  observation: VoiceDeviceEvaluationObservation,
): boolean {
  const { bargeIn } = observation;
  return (
    bargeIn.status === "passed" &&
    bargeIn.trialCount > 0 &&
    bargeIn.successfulInterruptionCount === bargeIn.trialCount &&
    typeof bargeIn.localSpeechToSilenceP95Ms === "number" &&
    bargeIn.localSpeechToSilenceP95Ms <= LOCAL_SILENCE_P95_LIMIT_MS &&
    typeof bargeIn.serverSpeechToAckP95Ms === "number" &&
    bargeIn.serverSpeechToAckP95Ms <= SERVER_ACK_P95_LIMIT_MS &&
    bargeIn.lateAudioFrames === 0 &&
    bargeIn.replacementContextIntegrity === "passed"
  );
}

function doubleTalkMeasurementsPassed(
  observation: VoiceDeviceEvaluationObservation,
): boolean {
  const { doubleTalk } = observation;
  return (
    doubleTalk.status === "passed" &&
    doubleTalk.trialCount > 0 &&
    doubleTalk.successfulUserSpeechDetectionCount === doubleTalk.trialCount &&
    doubleTalk.echoOnlyTrialCount > 0 &&
    doubleTalk.echoOnlyFalseTurnCount === 0
  );
}

function observationMeasurementsPassed(
  observation: VoiceDeviceEvaluationObservation,
): boolean {
  if (!captureMeasurementsPassed(observation)) return false;
  switch (observation.profile) {
    case "capture_routing":
      return true;
    case "transport_continuity":
      return transportMeasurementsPassed(observation);
    case "barge_in":
      return bargeInMeasurementsPassed(observation);
    case "double_talk":
      return doubleTalkMeasurementsPassed(observation);
  }
}

function liveProviderEvidencePassed(
  observation: VoiceDeviceEvaluationObservation,
): boolean {
  return (
    observation.evidenceKind === "real_device_live_provider" &&
    observation.providerPath.roundTrip === "passed" &&
    observationMeasurementsPassed(observation)
  );
}

function observationOverallPassed(
  observation: VoiceDeviceEvaluationObservation,
): boolean {
  return (
    observationMeasurementsPassed(observation) &&
    (observation.evidenceKind !== "real_device_live_provider" ||
      observation.providerPath.roundTrip === "passed")
  );
}

function relevantStatuses(
  observation: VoiceDeviceEvaluationObservation,
): readonly VoiceDeviceMeasurementStatus[] {
  const statuses: VoiceDeviceMeasurementStatus[] = [
    observation.providerPath.roundTrip,
  ];
  switch (observation.profile) {
    case "capture_routing":
      statuses.push(
        observation.capture.inputSelection,
        observation.capture.deviceChangeHandling,
        observation.playback.outputSelection,
        observation.playback.sampleRateConversion,
      );
      break;
    case "transport_continuity":
      statuses.push(observation.transport.continuity);
      break;
    case "barge_in":
      statuses.push(
        observation.bargeIn.status,
        observation.bargeIn.replacementContextIntegrity,
      );
      break;
    case "double_talk":
      statuses.push(observation.doubleTalk.status);
      break;
  }
  return statuses;
}

function captureGrantDiffers(
  observation: VoiceDeviceEvaluationObservation,
): boolean {
  const { requested, granted } = observation.capture;
  if (
    granted.sampleRateHz === "unknown" ||
    granted.channelCount === "unknown" ||
    granted.echoCancellation === "unknown" ||
    granted.noiseSuppression === "unknown" ||
    granted.autoGainControl === "unknown"
  ) {
    return false;
  }
  return (
    requested.sampleRateHz !== granted.sampleRateHz ||
    requested.channelCount !== granted.channelCount ||
    requested.echoCancellation !== granted.echoCancellation ||
    requested.noiseSuppression !== granted.noiseSuppression ||
    requested.autoGainControl !== granted.autoGainControl
  );
}

function captureSettingsHaveUnknown(
  observation: VoiceDeviceEvaluationObservation,
): boolean {
  const { granted } = observation.capture;
  return (
    granted.sampleRateHz === "unknown" ||
    granted.channelCount === "unknown" ||
    granted.echoCancellation === "unknown" ||
    granted.noiseSuppression === "unknown" ||
    granted.autoGainControl === "unknown" ||
    observation.playback.actualSampleRateHz === "not_measured"
  );
}

/**
 * Summarize an explicit release matrix. Missing, duplicate, malformed,
 * synthetic-only, offline-only, or partially specified cohorts cannot pass.
 */
export function summarizeVoiceDeviceEvaluation(
  observationsInput: unknown,
  requirementsInput: unknown,
): VoiceDeviceEvaluationSummary {
  const observationCount = Array.isArray(observationsInput)
    ? observationsInput.length
    : 0;
  const inputValid =
    Array.isArray(observationsInput) &&
    observationsInput.length <= MAX_OBSERVATION_COUNT;
  const observations = inputValid ? observationsInput : [];
  const requirements = parseRequirements(requirementsInput);
  const requirementsValid = requirements !== null;
  const validObservations: VoiceDeviceEvaluationObservation[] = [];
  const seenEvaluationIds = new Set<string>();
  let malformedObservationCount = inputValid ? 0 : 1;
  let duplicateObservationCount = 0;

  for (const candidate of observations) {
    const parsed = parseVoiceDeviceEvaluationObservation(candidate);
    if (!parsed) {
      malformedObservationCount += 1;
      continue;
    }
    if (seenEvaluationIds.has(parsed.evaluationId)) {
      duplicateObservationCount += 1;
      continue;
    }
    seenEvaluationIds.add(parsed.evaluationId);
    validObservations.push(parsed);
  }

  const measurementStatusCounts: Record<VoiceDeviceMeasurementStatus, number> =
    {
      passed: 0,
      failed: 0,
      unsupported: 0,
      not_measured: 0,
    };
  const evidenceCounts: Record<VoiceDeviceEvidenceKind, number> = {
    deterministic_fake_media: 0,
    real_device_offline: 0,
    real_device_live_provider: 0,
  };
  for (const observation of validObservations) {
    evidenceCounts[observation.evidenceKind] += 1;
    for (const status of relevantStatuses(observation)) {
      measurementStatusCounts[status] += 1;
    }
  }

  const measurementPassedCount = validObservations.filter(
    observationOverallPassed,
  ).length;
  const measurementFailedCount =
    validObservations.length - measurementPassedCount;
  const allMeasurementsPassed =
    validObservations.length > 0 && measurementFailedCount === 0;

  const profileEntries = VOICE_DEVICE_EVALUATION_PROFILES.map((profile) => {
    const eligible = validObservations.filter(
      (observation) =>
        observation.profile === profile &&
        observationMeasurementsPassed(observation),
    );
    const syntheticPassedCount = eligible.filter(
      (observation) => observation.evidenceKind === "deterministic_fake_media",
    ).length;
    const realDeviceOfflinePassedCount = eligible.filter(
      (observation) => observation.evidenceKind === "real_device_offline",
    ).length;
    const realProviderPassedCount = eligible.filter(
      liveProviderEvidencePassed,
    ).length;
    const minimum = requirements?.profileMinimums.get(profile);
    const summary: VoiceDeviceProfileEvaluationSummary = Object.freeze({
      profile,
      syntheticPassedCount,
      realDeviceOfflinePassedCount,
      realProviderPassedCount,
      minimumSyntheticRuns: minimum?.minimumSyntheticRuns ?? null,
      minimumRealProviderRuns: minimum?.minimumRealProviderRuns ?? null,
      syntheticCoveragePassed:
        minimum !== undefined &&
        syntheticPassedCount >= minimum.minimumSyntheticRuns,
      realProviderCoveragePassed:
        minimum !== undefined &&
        realProviderPassedCount >= minimum.minimumRealProviderRuns,
    });
    return [profile, summary] as const;
  });
  const profiles = Object.freeze(
    Object.fromEntries(profileEntries) as Record<
      VoiceDeviceEvaluationProfile,
      VoiceDeviceProfileEvaluationSummary
    >,
  );
  const profileCoveragePassed =
    requirementsValid &&
    Object.values(profiles).every(
      (profile) =>
        profile.syntheticCoveragePassed && profile.realProviderCoveragePassed,
    );

  const matrix: readonly VoiceDeviceMatrixCellSummary[] = Object.freeze(
    (requirements?.deviceMatrixMinimums ?? []).map((minimum) => {
      const passedCount = validObservations.filter(
        (observation) =>
          observation.profile === minimum.profile &&
          observation.capture.inputDeviceClass === minimum.inputDeviceClass &&
          observation.playback.outputDeviceClass ===
            minimum.outputDeviceClass &&
          liveProviderEvidencePassed(observation),
      ).length;
      return Object.freeze({
        profile: minimum.profile,
        inputDeviceClass: minimum.inputDeviceClass,
        outputDeviceClass: minimum.outputDeviceClass,
        passedCount,
        minimumRealProviderRuns: minimum.minimumRealProviderRuns,
        coveragePassed: passedCount >= minimum.minimumRealProviderRuns,
      });
    }),
  );
  const deviceMatrixPassed =
    requirementsValid &&
    matrix.length > 0 &&
    matrix.every((cell) => cell.coveragePassed);

  const bargeInObservations = validObservations.filter(
    (observation) => observation.profile === "barge_in",
  );
  const lateAudioMeasured = bargeInObservations.every(
    (observation) => typeof observation.bargeIn.lateAudioFrames === "number",
  );
  const lateAudioFrames = bargeInObservations.reduce(
    (total, observation) =>
      total +
      (typeof observation.bargeIn.lateAudioFrames === "number"
        ? observation.bargeIn.lateAudioFrames
        : 0),
    0,
  );
  const zeroLateAudioPassed =
    bargeInObservations.length > 0 &&
    lateAudioMeasured &&
    lateAudioFrames === 0;

  const captureSettingsMeasuredCount = validObservations.filter(
    captureMeasurementsPassed,
  ).length;
  const captureSettingsIncompleteCount =
    validObservations.length - captureSettingsMeasuredCount;
  const captureSettingsUnknownCount = validObservations.filter(
    captureSettingsHaveUnknown,
  ).length;
  const captureGrantDifferenceCount =
    validObservations.filter(captureGrantDiffers).length;
  const invalidObservationCount =
    malformedObservationCount + duplicateObservationCount;

  return Object.freeze({
    inputValid,
    requirementsValid,
    observationCount,
    validObservationCount: validObservations.length,
    malformedObservationCount,
    duplicateObservationCount,
    invalidObservationCount,
    measurementPassedCount,
    measurementFailedCount,
    allMeasurementsPassed,
    evidenceCounts: Object.freeze({ ...evidenceCounts }),
    measurementStatusCounts: Object.freeze({ ...measurementStatusCounts }),
    captureSettingsMeasuredCount,
    captureSettingsIncompleteCount,
    captureSettingsUnknownCount,
    captureGrantDifferenceCount,
    profiles,
    matrix,
    profileCoveragePassed,
    deviceMatrixPassed,
    lateAudioFrames,
    zeroLateAudioPassed,
    passed:
      inputValid &&
      requirementsValid &&
      invalidObservationCount === 0 &&
      allMeasurementsPassed &&
      profileCoveragePassed &&
      deviceMatrixPassed &&
      zeroLateAudioPassed,
  });
}
