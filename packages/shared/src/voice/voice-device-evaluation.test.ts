/**
 * Deterministic adversarial coverage for the content-free voice device matrix
 * contract. The harness exercises schema and release-gate behavior only; it is
 * not evidence of a physical device or live provider session.
 */

import { describe, expect, it } from "vitest";
import {
  parseVoiceDeviceEvaluationJson,
  parseVoiceDeviceEvaluationObservation,
  summarizeVoiceDeviceEvaluation,
  type VoiceDeviceEvaluationObservation,
  type VoiceDeviceEvaluationProfile,
  type VoiceDeviceEvaluationRequirements,
  type VoiceDeviceEvidenceKind,
  type VoiceEvaluationDeviceClass,
} from "./voice-device-evaluation";

let nextEvaluationId = 1;

function evaluationId(): string {
  const suffix = String(nextEvaluationId).padStart(12, "0");
  nextEvaluationId += 1;
  return `00000000-0000-4000-8000-${suffix}`;
}

function observation(
  profile: VoiceDeviceEvaluationProfile,
  evidenceKind: VoiceDeviceEvidenceKind,
  inputDeviceClass: VoiceEvaluationDeviceClass = evidenceKind ===
  "deterministic_fake_media"
    ? "virtual"
    : "builtin",
  outputDeviceClass: VoiceEvaluationDeviceClass = evidenceKind ===
  "deterministic_fake_media"
    ? "virtual"
    : "speakerphone",
): VoiceDeviceEvaluationObservation {
  const live = evidenceKind === "real_device_live_provider";
  const offline = evidenceKind === "real_device_offline";
  return {
    schemaVersion: 1,
    evaluationId: evaluationId(),
    profile,
    evidenceKind,
    providerPath: {
      sttProvider: live ? "cartesia-ink-2" : offline ? "none" : "deterministic",
      modelProvider: live ? "cerebras" : offline ? "none" : "deterministic",
      ttsProvider: live ? "cartesia-sonic" : offline ? "none" : "deterministic",
      transport: live ? "websocket" : "local",
      roundTrip: live ? "passed" : offline ? "unsupported" : "not_measured",
    },
    measurementWindow: {
      startedAt: {
        clockDomain: live ? "browser_monotonic" : "synthetic_monotonic",
        atMs: 100,
      },
      endedAt: {
        clockDomain: live ? "browser_monotonic" : "synthetic_monotonic",
        atMs: 1_100,
      },
    },
    capture: {
      requested: {
        sampleRateHz: 16_000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      granted: {
        sampleRateHz: 48_000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      inputDeviceClass,
      inputSelection: "passed",
      deviceChangeHandling: "passed",
    },
    playback: {
      requestedSampleRateHz: 16_000,
      actualSampleRateHz: 48_000,
      outputDeviceClass,
      outputSelection: "passed",
      sampleRateConversion: "passed",
    },
    transport: {
      sampleRateHz: 16_000,
      channelCount: 1,
      requestedFrameDurationMs: 40,
      observedFrameDurationMs: 40,
      sentFrameCount: 25,
      receivedFrameCount: 25,
      packetGapCount: 0,
      duplicateFrameCount: 0,
      outOfOrderFrameCount: 0,
      continuity: "passed",
    },
    bargeIn: {
      trialCount: 10,
      successfulInterruptionCount: 10,
      localSpeechToSilenceP95Ms: 75,
      serverSpeechToAckP95Ms: 180,
      lateAudioFrames: 0,
      replacementContextIntegrity: "passed",
      status: "passed",
    },
    doubleTalk: {
      trialCount: 10,
      successfulUserSpeechDetectionCount: 10,
      echoOnlyTrialCount: 10,
      echoOnlyFalseTurnCount: 0,
      status: "passed",
    },
  };
}

type DevicePair = readonly [
  VoiceEvaluationDeviceClass,
  VoiceEvaluationDeviceClass,
];

const PROFILES: readonly VoiceDeviceEvaluationProfile[] = [
  "capture_routing",
  "transport_continuity",
  "barge_in",
  "double_talk",
];

function requirements(
  pairs: readonly DevicePair[],
  minimumRealProviderRuns = pairs.length,
): VoiceDeviceEvaluationRequirements {
  return {
    profileMinimums: PROFILES.map((profile) => ({
      profile,
      minimumSyntheticRuns: 1,
      minimumRealProviderRuns,
    })),
    deviceMatrixMinimums: pairs.flatMap(
      ([inputDeviceClass, outputDeviceClass]) =>
        PROFILES.map((profile) => ({
          profile,
          inputDeviceClass,
          outputDeviceClass,
          minimumRealProviderRuns: 1,
        })),
    ),
  };
}

function completeMatrix(
  pairs: readonly DevicePair[],
): VoiceDeviceEvaluationObservation[] {
  return PROFILES.flatMap((profile) => [
    observation(profile, "deterministic_fake_media"),
    ...pairs.map(([inputDeviceClass, outputDeviceClass]) =>
      observation(
        profile,
        "real_device_live_provider",
        inputDeviceClass,
        outputDeviceClass,
      ),
    ),
  ]);
}

describe("voice device evaluation evidence", () => {
  it("strictly parses and freezes a content-free observation", () => {
    const candidate = observation(
      "capture_routing",
      "real_device_live_provider",
    );
    const parsed = parseVoiceDeviceEvaluationObservation(candidate);
    expect(parsed).toEqual(candidate);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.capture.granted)).toBe(true);
    expect(Object.isFrozen(parsed?.measurementWindow.startedAt)).toBe(true);
    expect(parseVoiceDeviceEvaluationJson(JSON.stringify(candidate))).toEqual(
      candidate,
    );
  });

  it("rejects device identifiers, content, secrets, and invented ERLE", () => {
    const candidate = observation("double_talk", "real_device_live_provider");
    expect(
      parseVoiceDeviceEvaluationObservation({
        ...candidate,
        transcript: "content must never enter this artifact",
      }),
    ).toBeNull();
    expect(
      parseVoiceDeviceEvaluationObservation({
        ...candidate,
        capture: {
          ...candidate.capture,
          inputDeviceId: "raw-device-id",
        },
      }),
    ).toBeNull();
    expect(
      parseVoiceDeviceEvaluationObservation({
        ...candidate,
        playback: {
          ...candidate.playback,
          groupId: "raw-group-id",
        },
      }),
    ).toBeNull();
    expect(
      parseVoiceDeviceEvaluationObservation({
        ...candidate,
        providerPath: {
          ...candidate.providerPath,
          sttProvider: "sk_test_not-a-secret",
        },
      }),
    ).toBeNull();
    expect(
      parseVoiceDeviceEvaluationObservation({
        ...candidate,
        doubleTalk: { ...candidate.doubleTalk, erleDb: 31 },
      }),
    ).toBeNull();
    expect(
      parseVoiceDeviceEvaluationObservation({
        ...candidate,
        capture: {
          ...candidate.capture,
          inputDeviceClass: "Built-in microphone serial 123",
        },
      }),
    ).toBeNull();
  });

  it("rejects malformed JSON and oversized serialized input", () => {
    expect(parseVoiceDeviceEvaluationJson("{not-json")).toBeNull();
    expect(parseVoiceDeviceEvaluationJson('{"schemaVersion":1}')).toBeNull();
    expect(parseVoiceDeviceEvaluationJson(" ")).toBeNull();
    expect(parseVoiceDeviceEvaluationJson("x".repeat(100_001))).toBeNull();
  });

  it("rejects cross-clock windows and negative or non-finite durations", () => {
    const candidate = observation("barge_in", "deterministic_fake_media");
    expect(
      parseVoiceDeviceEvaluationObservation({
        ...candidate,
        measurementWindow: {
          ...candidate.measurementWindow,
          endedAt: {
            clockDomain: "server_monotonic",
            atMs: 1_100,
          },
        },
      }),
    ).toBeNull();
    expect(
      parseVoiceDeviceEvaluationObservation({
        ...candidate,
        measurementWindow: {
          startedAt: candidate.measurementWindow.startedAt,
          endedAt: {
            ...candidate.measurementWindow.endedAt,
            atMs: 99,
          },
        },
      }),
    ).toBeNull();
    expect(
      parseVoiceDeviceEvaluationObservation({
        ...candidate,
        bargeIn: {
          ...candidate.bargeIn,
          localSpeechToSilenceP95Ms: -1,
        },
      }),
    ).toBeNull();
    expect(
      parseVoiceDeviceEvaluationObservation({
        ...candidate,
        transport: {
          ...candidate.transport,
          observedFrameDurationMs: Number.POSITIVE_INFINITY,
        },
      }),
    ).toBeNull();
  });

  it("passes only a complete synthetic plus real-provider physical matrix", () => {
    const pairs: readonly DevicePair[] = [
      ["builtin", "speakerphone"],
      ["bluetooth", "bluetooth"],
    ];
    const report = summarizeVoiceDeviceEvaluation(
      completeMatrix(pairs),
      requirements(pairs),
    );
    expect(report).toMatchObject({
      inputValid: true,
      requirementsValid: true,
      observationCount: 12,
      validObservationCount: 12,
      invalidObservationCount: 0,
      measurementPassedCount: 12,
      captureSettingsMeasuredCount: 12,
      captureGrantDifferenceCount: 12,
      profileCoveragePassed: true,
      deviceMatrixPassed: true,
      lateAudioFrames: 0,
      zeroLateAudioPassed: true,
      passed: true,
    });
    expect(report.profiles.barge_in).toMatchObject({
      syntheticPassedCount: 1,
      realProviderPassedCount: 2,
      syntheticCoveragePassed: true,
      realProviderCoveragePassed: true,
    });
    expect(report.matrix).toHaveLength(8);
    expect(report.matrix.every((cell) => cell.coveragePassed)).toBe(true);
  });

  it("does not let synthetic or real-device offline evidence satisfy live providers", () => {
    const pair: DevicePair = ["builtin", "speakerphone"];
    const observations = PROFILES.flatMap((profile) => [
      observation(profile, "deterministic_fake_media"),
      observation(profile, "real_device_offline", pair[0], pair[1]),
    ]);
    const report = summarizeVoiceDeviceEvaluation(
      observations,
      requirements([pair], 1),
    );
    expect(report.profiles.capture_routing).toMatchObject({
      syntheticPassedCount: 1,
      realDeviceOfflinePassedCount: 1,
      realProviderPassedCount: 0,
      syntheticCoveragePassed: true,
      realProviderCoveragePassed: false,
    });
    expect(report.profileCoveragePassed).toBe(false);
    expect(report.deviceMatrixPassed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("fails a matrix whose marginal profile and device counts hide missing cells", () => {
    const builtin: DevicePair = ["builtin", "speakerphone"];
    const bluetooth: DevicePair = ["bluetooth", "bluetooth"];
    const observations = PROFILES.flatMap((profile, index) => {
      const pair = index < 2 ? builtin : bluetooth;
      return [
        observation(profile, "deterministic_fake_media"),
        observation(profile, "real_device_live_provider", pair[0], pair[1]),
      ];
    });
    const report = summarizeVoiceDeviceEvaluation(
      observations,
      requirements([builtin, bluetooth], 1),
    );
    expect(report.profileCoveragePassed).toBe(true);
    expect(report.deviceMatrixPassed).toBe(false);
    expect(report.matrix.filter((cell) => !cell.coveragePassed)).toHaveLength(
      4,
    );
    expect(report.passed).toBe(false);
  });

  it("rejects partial or malformed requirement manifests", () => {
    const pair: DevicePair = ["builtin", "speakerphone"];
    const observations = completeMatrix([pair]);
    const complete = requirements([pair], 1);
    const partial = {
      ...complete,
      deviceMatrixMinimums: complete.deviceMatrixMinimums.slice(0, -1),
    };
    expect(summarizeVoiceDeviceEvaluation(observations, partial)).toMatchObject(
      { requirementsValid: false, passed: false },
    );
    expect(
      summarizeVoiceDeviceEvaluation(observations, {
        ...complete,
        profileMinimums: complete.profileMinimums.map((minimum, index) =>
          index === 0
            ? { ...minimum, minimumSyntheticRuns: Number.POSITIVE_INFINITY }
            : minimum,
        ),
      }),
    ).toMatchObject({ requirementsValid: false, passed: false });
    expect(summarizeVoiceDeviceEvaluation(null, complete)).toMatchObject({
      inputValid: false,
      invalidObservationCount: 1,
      passed: false,
    });
  });

  it("surfaces unsupported and not-measured states without false success", () => {
    const pair: DevicePair = ["builtin", "speakerphone"];
    const observations = completeMatrix([pair]);
    const captureIndex = observations.findIndex(
      (candidate) =>
        candidate.profile === "capture_routing" &&
        candidate.evidenceKind === "real_device_live_provider",
    );
    const capture = observations[captureIndex];
    if (!capture) throw new Error("expected real capture observation");
    observations[captureIndex] = {
      ...capture,
      playback: { ...capture.playback, outputSelection: "unsupported" },
    };
    const supportedReport = summarizeVoiceDeviceEvaluation(
      observations,
      requirements([pair], 1),
    );
    expect(supportedReport.measurementStatusCounts.unsupported).toBe(1);
    expect(supportedReport.passed).toBe(true);

    observations[captureIndex] = {
      ...observations[captureIndex],
      playback: {
        ...observations[captureIndex].playback,
        sampleRateConversion: "not_measured",
      },
    };
    const unmeasuredReport = summarizeVoiceDeviceEvaluation(
      observations,
      requirements([pair], 1),
    );
    expect(
      unmeasuredReport.measurementStatusCounts.not_measured,
    ).toBeGreaterThan(0);
    expect(unmeasuredReport.measurementFailedCount).toBe(1);
    expect(
      unmeasuredReport.profiles.capture_routing.realProviderCoveragePassed,
    ).toBe(false);
    expect(unmeasuredReport.passed).toBe(false);

    const unknownGrantMatrix = completeMatrix([pair]);
    const unknownCaptureIndex = unknownGrantMatrix.findIndex(
      (candidate) =>
        candidate.profile === "capture_routing" &&
        candidate.evidenceKind === "real_device_live_provider",
    );
    const unknownCapture = unknownGrantMatrix[unknownCaptureIndex];
    if (!unknownCapture) throw new Error("expected real capture observation");
    unknownGrantMatrix[unknownCaptureIndex] = {
      ...unknownCapture,
      capture: {
        ...unknownCapture.capture,
        granted: {
          ...unknownCapture.capture.granted,
          echoCancellation: "unknown",
        },
      },
    };
    const unknownGrantReport = summarizeVoiceDeviceEvaluation(
      unknownGrantMatrix,
      requirements([pair], 1),
    );
    expect(unknownGrantReport.captureSettingsUnknownCount).toBe(1);
    expect(unknownGrantReport.captureSettingsIncompleteCount).toBe(1);
    expect(unknownGrantReport.passed).toBe(false);
  });

  it("hard-fails late audio and 100 ms client framing even when status says passed", () => {
    const pair: DevicePair = ["builtin", "speakerphone"];
    const lateAudioMatrix = completeMatrix([pair]);
    const liveBargeIndex = lateAudioMatrix.findIndex(
      (candidate) =>
        candidate.profile === "barge_in" &&
        candidate.evidenceKind === "real_device_live_provider",
    );
    const liveBarge = lateAudioMatrix[liveBargeIndex];
    if (!liveBarge) throw new Error("expected real barge-in observation");
    lateAudioMatrix[liveBargeIndex] = {
      ...liveBarge,
      bargeIn: { ...liveBarge.bargeIn, lateAudioFrames: 1 },
    };
    const lateAudioReport = summarizeVoiceDeviceEvaluation(
      lateAudioMatrix,
      requirements([pair], 1),
    );
    expect(lateAudioReport.lateAudioFrames).toBe(1);
    expect(lateAudioReport.zeroLateAudioPassed).toBe(false);
    expect(lateAudioReport.passed).toBe(false);

    const slowFrameMatrix = completeMatrix([pair]);
    const liveTransportIndex = slowFrameMatrix.findIndex(
      (candidate) =>
        candidate.profile === "transport_continuity" &&
        candidate.evidenceKind === "real_device_live_provider",
    );
    const liveTransport = slowFrameMatrix[liveTransportIndex];
    if (!liveTransport) throw new Error("expected real transport observation");
    slowFrameMatrix[liveTransportIndex] = {
      ...liveTransport,
      transport: {
        ...liveTransport.transport,
        requestedFrameDurationMs: 100,
        observedFrameDurationMs: 100,
      },
    };
    const slowFrameReport = summarizeVoiceDeviceEvaluation(
      slowFrameMatrix,
      requirements([pair], 1),
    );
    expect(slowFrameReport.measurementFailedCount).toBe(1);
    expect(
      slowFrameReport.profiles.transport_continuity.realProviderCoveragePassed,
    ).toBe(false);
    expect(slowFrameReport.passed).toBe(false);
  });

  it("rejects duplicate run IDs instead of inflating cohort counts", () => {
    const pair: DevicePair = ["builtin", "speakerphone"];
    const observations = completeMatrix([pair]);
    observations.push(observations[0]);
    const report = summarizeVoiceDeviceEvaluation(
      observations,
      requirements([pair], 1),
    );
    expect(report.duplicateObservationCount).toBe(1);
    expect(report.invalidObservationCount).toBe(1);
    expect(report.passed).toBe(false);
  });

  it("does not hide a failed live-provider run behind a passing minimum", () => {
    const pair: DevicePair = ["builtin", "speakerphone"];
    const observations = completeMatrix([pair]);
    const failedRoundTrip = observation(
      "capture_routing",
      "real_device_live_provider",
      pair[0],
      pair[1],
    );
    observations.push({
      ...failedRoundTrip,
      providerPath: {
        ...failedRoundTrip.providerPath,
        roundTrip: "failed",
      },
    });
    const report = summarizeVoiceDeviceEvaluation(
      observations,
      requirements([pair], 1),
    );
    expect(report.profileCoveragePassed).toBe(true);
    expect(report.deviceMatrixPassed).toBe(true);
    expect(report.measurementFailedCount).toBe(1);
    expect(report.allMeasurementsPassed).toBe(false);
    expect(report.passed).toBe(false);
  });
});
