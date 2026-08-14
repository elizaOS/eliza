/**
 * Deterministic contract tests for Voice Workbench trace/device artifacts.
 * Synthetic fixtures prove diagnostic wiring only; explicit physical settings
 * exercise classification without standing in for a real device run.
 */

import { describe, expect, it } from "vitest";
import {
	buildVoiceWorkbenchEvidenceReport,
	buildVoiceWorkbenchScenarioEvidence,
	type VoiceWorkbenchEvidenceSettings,
	type VoiceWorkbenchObservedTurnEvidence,
} from "./workbench-evidence";

const COMPLETE_RESPONSE_MARKS = {
	acoustic_speech_ended: 0,
	stt_final: 20,
	turn_committed: 25,
	llm_first_useful_text: 50,
	speakable_text_ready: 55,
	tts_first_byte: 80,
	first_audio_playout: 200,
	last_audio_playout: 400,
} as const;

const MOCK_SETTINGS: VoiceWorkbenchEvidenceSettings = {
	lane: "mock",
	providerPath: {
		sttProvider: "deterministic",
		modelProvider: "deterministic",
		ttsProvider: "deterministic",
		transport: "local",
		roundTrip: "unsupported",
	},
	requestedFrameDurationMs: 20,
};

const LIVE_SETTINGS: VoiceWorkbenchEvidenceSettings = {
	lane: "live_device_provider",
	providerPath: {
		sttProvider: "cartesia",
		modelProvider: "cerebras",
		ttsProvider: "cartesia",
		transport: "websocket",
		roundTrip: "passed",
	},
	requestedFrameDurationMs: 20,
	liveDevice: {
		measurementWindow: {
			startedAt: { clockDomain: "browser_monotonic", atMs: 10 },
			endedAt: { clockDomain: "browser_monotonic", atMs: 1_010 },
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
				sampleRateHz: 16_000,
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
			inputDeviceClass: "builtin",
			inputSelection: "passed",
			deviceChangeHandling: "passed",
		},
		playback: {
			requestedSampleRateHz: 24_000,
			actualSampleRateHz: 48_000,
			outputDeviceClass: "builtin",
			outputSelection: "passed",
			sampleRateConversion: "passed",
		},
		transport: {
			sampleRateHz: 16_000,
			channelCount: 1,
			requestedFrameDurationMs: 20,
			observedFrameDurationMs: 20,
			sentFrameCount: 50,
			receivedFrameCount: 50,
			packetGapCount: 0,
			duplicateFrameCount: 0,
			outOfOrderFrameCount: 0,
			continuity: "passed",
		},
	},
};

function responseTurn(
	overrides: Partial<VoiceWorkbenchObservedTurnEvidence> = {},
): VoiceWorkbenchObservedTurnEvidence {
	return {
		turnIndex: 0,
		expectRespond: true,
		responded: true,
		isAgentEcho: false,
		bargeIn: false,
		expectBargeInCancel: false,
		firstAudioMs: 200,
		realtime: { responseMarks: COMPLETE_RESPONSE_MARKS },
		...overrides,
	};
}

describe("Voice Workbench evidence adapter", () => {
	it("keeps a complete synthetic trace diagnostic out of the release cohort", () => {
		const scenario = buildVoiceWorkbenchScenarioEvidence({
			scenarioId: "synthetic-perfect",
			sampleRate: 16_000,
			settings: MOCK_SETTINGS,
			turns: [responseTurn()],
		});
		const report = buildVoiceWorkbenchEvidenceReport([scenario]);

		expect(scenario.evidenceKind).toBe("deterministic_fake_media");
		expect(report?.diagnosticLatency.passed).toBe(true);
		expect(report?.liveProviderTraceCount).toBe(0);
		expect(report?.releaseLatency.passed).toBe(false);
		expect(report?.releaseGatePassed).toBe(false);
		expect(report?.releaseBlockers).toContain(
			"live_provider_trace_cohort_missing",
		);
	});

	it("downgrades a claimed live lane when physical capture/playback evidence is absent", () => {
		const scenario = buildVoiceWorkbenchScenarioEvidence({
			scenarioId: "incomplete-live",
			sampleRate: 16_000,
			settings: { ...LIVE_SETTINGS, liveDevice: undefined },
			turns: [responseTurn()],
		});

		expect(scenario.evidenceKind).toBe("deterministic_fake_media");
		expect(scenario.classificationPassed).toBe(false);
		expect(scenario.classificationBlockers).toEqual(
			expect.arrayContaining([
				"live_device_provider_evidence_incomplete",
				"device_round_trip_not_measured",
			]),
		);
	});

	it("classifies only explicit physical capture/playback/provider observations as live", () => {
		const scenario = buildVoiceWorkbenchScenarioEvidence({
			scenarioId: "measured-live",
			sampleRate: 16_000,
			settings: LIVE_SETTINGS,
			turns: [responseTurn()],
		});

		expect(scenario.evidenceKind).toBe("real_device_live_provider");
		expect(scenario.classificationPassed).toBe(true);
		expect(scenario.deviceObservations).toHaveLength(2);
		expect(
			scenario.deviceObservations.every(
				(observation) =>
					observation.evidenceKind === "real_device_live_provider",
			),
		).toBe(true);
	});

	it("fails profile and device-matrix gates when barge-in/double-talk rows are missing", () => {
		const scenario = buildVoiceWorkbenchScenarioEvidence({
			scenarioId: "missing-profile-rows",
			sampleRate: 16_000,
			settings: LIVE_SETTINGS,
			turns: [responseTurn()],
		});
		const report = buildVoiceWorkbenchEvidenceReport([scenario]);

		expect(report?.deviceEvaluation.requirementsValid).toBe(true);
		expect(
			report?.deviceEvaluation.profiles.barge_in.realProviderPassedCount,
		).toBe(0);
		expect(
			report?.deviceEvaluation.profiles.double_talk.realProviderPassedCount,
		).toBe(0);
		expect(report?.deviceEvaluation.profileCoveragePassed).toBe(false);
		expect(report?.deviceEvaluation.deviceMatrixPassed).toBe(false);
		expect(report?.releaseBlockers).toEqual(
			expect.arrayContaining([
				"device_profile_coverage_missing",
				"device_matrix_coverage_missing",
			]),
		);
	});

	it("fails trace coverage when only one of two expected replies measures first audio", () => {
		const scenario = buildVoiceWorkbenchScenarioEvidence({
			scenarioId: "partial-first-audio",
			sampleRate: 16_000,
			settings: LIVE_SETTINGS,
			turns: [
				responseTurn(),
				responseTurn({
					turnIndex: 1,
					firstAudioMs: undefined,
					realtime: undefined,
				}),
			],
		});
		const report = buildVoiceWorkbenchEvidenceReport([scenario]);

		expect(scenario.expectedResponseTraceCount).toBe(2);
		expect(scenario.observedResponseTraceCount).toBe(1);
		expect(report?.traceArtifactCoveragePassed).toBe(false);
		expect(report?.releaseBlockers).toContain(
			"trace_artifact_coverage_incomplete",
		);
	});

	it("records late playout frames and fails both trace and device zero-late-audio gates", () => {
		const turn: VoiceWorkbenchObservedTurnEvidence = {
			turnIndex: 0,
			expectRespond: false,
			responded: false,
			isAgentEcho: false,
			bargeIn: true,
			expectBargeInCancel: true,
			bargeInCancelMs: 40,
			realtime: {
				interruptionMarks: {
					local_speech_detected: 0,
					local_playback_paused: 40,
					server_interrupt_ack: 70,
				},
				lateAudioFrames: 2,
				lastLateAudioFrameAtMs: 90,
				replacementContextIntegrity: true,
			},
		};
		const scenario = buildVoiceWorkbenchScenarioEvidence({
			scenarioId: "late-audio",
			sampleRate: 16_000,
			settings: LIVE_SETTINGS,
			turns: [turn],
		});
		const report = buildVoiceWorkbenchEvidenceReport([scenario]);

		expect(scenario.traces[0]?.lateAudioFrames).toBe(2);
		expect(report?.releaseLatency.lateAudioFrames).toBe(2);
		expect(report?.releaseLatency.zeroLateAudioPassed).toBe(false);
		expect(report?.deviceEvaluation.lateAudioFrames).toBe(2);
		expect(report?.deviceEvaluation.zeroLateAudioPassed).toBe(false);
		expect(report?.releaseBlockers).toContain("late_audio_detected");
	});

	it("serializes only content-free evidence fields", () => {
		const turn = {
			...responseTurn(),
			transcript: "DO-NOT-SERIALIZE-UTTERANCE",
			rawAudio: "DO-NOT-SERIALIZE-AUDIO",
			providerCredential: "DO-NOT-SERIALIZE-CREDENTIAL",
		} as VoiceWorkbenchObservedTurnEvidence;
		const scenario = buildVoiceWorkbenchScenarioEvidence({
			scenarioId: "content-free",
			sampleRate: 16_000,
			settings: MOCK_SETTINGS,
			turns: [turn],
		});
		const serialized = JSON.stringify(
			buildVoiceWorkbenchEvidenceReport([scenario]),
		);

		expect(serialized).toContain('"contentFree":true');
		expect(serialized).not.toContain("DO-NOT-SERIALIZE-UTTERANCE");
		expect(serialized).not.toContain("DO-NOT-SERIALIZE-AUDIO");
		expect(serialized).not.toContain("DO-NOT-SERIALIZE-CREDENTIAL");
		expect(serialized).not.toContain('"transcript"');
		expect(serialized).not.toContain('"rawAudio"');
		expect(serialized).not.toContain('"providerCredential"');
	});
});
