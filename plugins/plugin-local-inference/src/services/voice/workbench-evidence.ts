/**
 * Maps Voice Workbench observations onto the shared content-free realtime
 * trace and device-evaluation contracts. Synthetic corpus runs remain useful
 * diagnostics, but only explicitly measured physical-device/live-provider
 * runs can contribute to the release latency or device matrix gates.
 */

import { createHash } from "node:crypto";
import {
	createRealtimeVoiceTrace,
	finalizeRealtimeVoiceTrace,
	markRealtimeVoiceTrace,
	noteLateRealtimeVoiceAudioFrame,
	parseVoiceDeviceEvaluationObservation,
	type RealtimeVoiceLatencyReport,
	type RealtimeVoiceTrace,
	type RealtimeVoiceTraceDimensionsInput,
	type RealtimeVoiceTraceMark,
	summarizeRealtimeVoiceLatency,
	summarizeVoiceDeviceEvaluation,
	type VoiceBargeInEvaluation,
	type VoiceCaptureEvaluation,
	type VoiceDeviceEvaluationObservation,
	type VoiceDeviceEvaluationProfile,
	type VoiceDeviceEvaluationRequirements,
	type VoiceDeviceEvaluationSummary,
	type VoiceDeviceEvidenceKind,
	type VoiceDeviceMeasurementStatus,
	type VoiceDoubleTalkEvaluation,
	type VoiceEvaluationMeasurementWindow,
	type VoiceEvaluationProviderPath,
	type VoicePlaybackEvaluation,
	type VoiceTransportContinuityEvaluation,
} from "@elizaos/shared";

export type VoiceWorkbenchEvidenceLane =
	| "mock"
	| "logic"
	| "offline_provider"
	| "live_device_provider";

/**
 * Physical settings are accepted only for a live-device-provider lane. The
 * fields are observations from the capture/playback APIs and transport hop,
 * not requested defaults or inferred browser capabilities.
 */
export interface VoiceWorkbenchLiveDeviceEvidence {
	measurementWindow: VoiceEvaluationMeasurementWindow;
	capture: VoiceCaptureEvaluation;
	playback: VoicePlaybackEvaluation;
	transport: VoiceTransportContinuityEvaluation;
}

export interface VoiceWorkbenchEvidenceSettings {
	lane: VoiceWorkbenchEvidenceLane;
	providerPath: VoiceEvaluationProviderPath;
	requestedFrameDurationMs: number;
	/** Absent for corpus-only/mock/logic runs; absence deliberately blocks release. */
	liveDevice?: VoiceWorkbenchLiveDeviceEvidence;
	/** Explicit release cohort. Defaults to one built-in input/output run per profile. */
	releaseRequirements?: VoiceDeviceEvaluationRequirements;
}

/** Optional content-free observations supplied by a real runtime adapter. */
export interface VoiceWorkbenchRealtimeTurnEvidence {
	/** Run-relative monotonic offsets. The adapter never derives missing marks. */
	responseMarks?: Readonly<Partial<Record<RealtimeVoiceTraceMark, number>>>;
	/** Run-relative monotonic offsets for the interruption attempt. */
	interruptionMarks?: Readonly<Partial<Record<RealtimeVoiceTraceMark, number>>>;
	lateAudioFrames?: number;
	lastLateAudioFrameAtMs?: number;
	replacementContextIntegrity?: boolean;
	doubleTalkUserSpeechDetected?: boolean;
}

export interface VoiceWorkbenchObservedTurnEvidence {
	turnIndex: number;
	expectRespond: boolean;
	responded: boolean;
	isAgentEcho: boolean;
	bargeIn: boolean;
	expectBargeInCancel: boolean;
	firstAudioMs?: number;
	bargeInCancelMs?: number | null;
	realtime?: VoiceWorkbenchRealtimeTurnEvidence;
}

export interface VoiceWorkbenchScenarioEvidence {
	schemaVersion: 1;
	lane: VoiceWorkbenchEvidenceLane;
	evidenceKind: VoiceDeviceEvidenceKind;
	classificationPassed: boolean;
	classificationBlockers: string[];
	expectedResponseTraceCount: number;
	observedResponseTraceCount: number;
	expectedInterruptionTraceCount: number;
	observedInterruptionTraceCount: number;
	requirements: VoiceDeviceEvaluationRequirements;
	traces: RealtimeVoiceTrace[];
	deviceObservations: VoiceDeviceEvaluationObservation[];
}

export interface VoiceWorkbenchEvidenceReport {
	schemaVersion: 1;
	contentFree: true;
	laneCounts: Record<VoiceWorkbenchEvidenceLane, number>;
	evidenceKindCounts: Record<VoiceDeviceEvidenceKind, number>;
	traceCount: number;
	liveProviderTraceCount: number;
	expectedTraceCount: number;
	traceArtifactCoveragePassed: boolean;
	/** All traces, including synthetic traces. Never used as release proof. */
	diagnosticLatency: RealtimeVoiceLatencyReport;
	/** Only real-device/live-provider traces. This is the release latency gate. */
	releaseLatency: RealtimeVoiceLatencyReport;
	traces: RealtimeVoiceTrace[];
	deviceObservations: VoiceDeviceEvaluationObservation[];
	deviceRequirements: VoiceDeviceEvaluationRequirements;
	deviceEvaluation: VoiceDeviceEvaluationSummary;
	releaseGatePassed: boolean;
	releaseBlockers: string[];
}

const PROFILES: readonly VoiceDeviceEvaluationProfile[] = [
	"capture_routing",
	"transport_continuity",
	"barge_in",
	"double_talk",
];

export const DEFAULT_VOICE_WORKBENCH_RELEASE_REQUIREMENTS: VoiceDeviceEvaluationRequirements =
	Object.freeze({
		profileMinimums: Object.freeze(
			PROFILES.map((profile) =>
				Object.freeze({
					profile,
					minimumSyntheticRuns: 1,
					minimumRealProviderRuns: 1,
				}),
			),
		),
		deviceMatrixMinimums: Object.freeze(
			PROFILES.map((profile) =>
				Object.freeze({
					profile,
					inputDeviceClass: "builtin" as const,
					outputDeviceClass: "builtin" as const,
					minimumRealProviderRuns: 1,
				}),
			),
		),
	});

const RELEASE_TRACE_PROFILE_MINIMUMS = Object.freeze({
	transcription: 1,
	model_response: 1,
	spoken_response: 1,
	interruption: 1,
	reconnect: 1,
	mutating_tool: 1,
});

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteNonNegativeInteger(value: unknown): value is number {
	return finiteNonNegative(value) && Number.isSafeInteger(value);
}

function percentile95(values: readonly number[]): number | "not_measured" {
	if (values.length === 0) return "not_measured";
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.ceil(sorted.length * 0.95) - 1;
	return sorted[Math.max(0, index)] ?? "not_measured";
}

function deterministicUuid(seed: string): string {
	const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function physicalDeviceClass(deviceClass: string): boolean {
	return [
		"builtin",
		"speakerphone",
		"usb",
		"bluetooth",
		"wired",
		"hearing_device",
	].includes(deviceClass);
}

function hasMeasuredLiveDeviceEvidence(
	settings: VoiceWorkbenchEvidenceSettings,
): boolean {
	const live = settings.liveDevice;
	if (
		settings.lane !== "live_device_provider" ||
		!live ||
		settings.providerPath.roundTrip !== "passed" ||
		settings.providerPath.transport === "local" ||
		settings.providerPath.transport === "unknown" ||
		live.measurementWindow.startedAt.clockDomain === "synthetic_monotonic" ||
		!physicalDeviceClass(live.capture.inputDeviceClass) ||
		!physicalDeviceClass(live.playback.outputDeviceClass)
	) {
		return false;
	}
	return (
		live.capture.granted.sampleRateHz !== "unknown" &&
		live.capture.granted.channelCount !== "unknown" &&
		live.capture.granted.echoCancellation !== "unknown" &&
		live.capture.granted.noiseSuppression !== "unknown" &&
		live.capture.granted.autoGainControl !== "unknown" &&
		live.playback.actualSampleRateHz !== "not_measured"
	);
}

function safeTraceDeviceClass(
	deviceClass: string,
): RealtimeVoiceTraceDimensionsInput["inputDeviceClass"] {
	return ["builtin", "usb", "bluetooth", "wired", "virtual"].includes(
		deviceClass,
	)
		? (deviceClass as RealtimeVoiceTraceDimensionsInput["inputDeviceClass"])
		: "unknown";
}

function traceDimensions(
	settings: VoiceWorkbenchEvidenceSettings,
	evidenceKind: VoiceDeviceEvidenceKind,
	sampleRate: number,
): RealtimeVoiceTraceDimensionsInput {
	const live = settings.liveDevice;
	return {
		sttProvider: settings.providerPath.sttProvider,
		modelProvider: settings.providerPath.modelProvider,
		modelRoute: settings.lane,
		ttsProvider: settings.providerPath.ttsProvider,
		transport: settings.providerPath.transport,
		frameDurationMs: settings.requestedFrameDurationMs,
		sampleRateHz: sampleRate,
		echoCancellation:
			evidenceKind === "real_device_live_provider" && live
				? live.capture.granted.echoCancellation
				: false,
		noiseSuppression:
			evidenceKind === "real_device_live_provider" && live
				? live.capture.granted.noiseSuppression
				: false,
		autoGainControl:
			evidenceKind === "real_device_live_provider" && live
				? live.capture.granted.autoGainControl
				: false,
		inputDeviceClass:
			evidenceKind === "real_device_live_provider" && live
				? safeTraceDeviceClass(live.capture.inputDeviceClass)
				: "virtual",
		outputDeviceClass:
			evidenceKind === "real_device_live_provider" && live
				? safeTraceDeviceClass(live.playback.outputDeviceClass)
				: "virtual",
	};
}

function applyOffsets(
	trace: RealtimeVoiceTrace,
	marks: Readonly<Partial<Record<RealtimeVoiceTraceMark, number>>> | undefined,
): RealtimeVoiceTrace {
	let next = trace;
	for (const [mark, offset] of Object.entries(marks ?? {})) {
		if (mark === "turn_ended" || !finiteNonNegative(offset)) continue;
		next = markRealtimeVoiceTrace(
			next,
			mark as RealtimeVoiceTraceMark,
			trace.createdAtMs + offset,
		);
	}
	return next;
}

function addLateAudio(
	trace: RealtimeVoiceTrace,
	evidence: VoiceWorkbenchRealtimeTurnEvidence | undefined,
): RealtimeVoiceTrace {
	if (
		!finiteNonNegativeInteger(evidence?.lateAudioFrames) ||
		evidence.lateAudioFrames === 0 ||
		!finiteNonNegative(evidence.lastLateAudioFrameAtMs)
	) {
		return trace;
	}
	let next = trace;
	for (let index = 0; index < evidence.lateAudioFrames; index += 1) {
		next = noteLateRealtimeVoiceAudioFrame(
			next,
			trace.createdAtMs + evidence.lastLateAudioFrameAtMs,
		);
	}
	return next;
}

function buildResponseTrace(args: {
	scenarioId: string;
	turn: VoiceWorkbenchObservedTurnEvidence;
	dimensions: RealtimeVoiceTraceDimensionsInput;
}): RealtimeVoiceTrace | null {
	const explicitMarks = args.turn.realtime?.responseMarks;
	if (
		!args.turn.responded ||
		(!explicitMarks && args.turn.firstAudioMs === undefined)
	) {
		return null;
	}
	let trace = createRealtimeVoiceTrace({
		sessionId: `workbench:${args.scenarioId}`,
		turnId: `${args.scenarioId}:${args.turn.turnIndex}:response`,
		responseId: `${args.scenarioId}:${args.turn.turnIndex}`,
		atMs: 0,
		profiles: ["spoken_response"],
		dimensions: args.dimensions,
	});
	trace = applyOffsets(trace, explicitMarks);
	if (finiteNonNegative(args.turn.firstAudioMs)) {
		trace = markRealtimeVoiceTrace(trace, "capture_started", 0);
		trace = markRealtimeVoiceTrace(
			trace,
			"first_audio_playout",
			args.turn.firstAudioMs,
		);
	}
	const finalizedAtMs = Math.max(0, ...Object.values(trace.marks));
	trace = finalizeRealtimeVoiceTrace(trace, "spoken", finalizedAtMs);
	return addLateAudio(trace, args.turn.realtime);
}

function buildInterruptionTrace(args: {
	scenarioId: string;
	turn: VoiceWorkbenchObservedTurnEvidence;
	dimensions: RealtimeVoiceTraceDimensionsInput;
}): RealtimeVoiceTrace | null {
	const explicitMarks = args.turn.realtime?.interruptionMarks;
	if (
		!args.turn.bargeIn ||
		(!explicitMarks && typeof args.turn.bargeInCancelMs !== "number")
	) {
		return null;
	}
	let trace = createRealtimeVoiceTrace({
		sessionId: `workbench:${args.scenarioId}`,
		turnId: `${args.scenarioId}:${args.turn.turnIndex}:interruption`,
		atMs: 0,
		profiles: ["interruption"],
		dimensions: args.dimensions,
	});
	trace = applyOffsets(trace, explicitMarks);
	if (finiteNonNegative(args.turn.bargeInCancelMs)) {
		trace = markRealtimeVoiceTrace(trace, "local_speech_detected", 0);
		trace = markRealtimeVoiceTrace(
			trace,
			"local_playback_paused",
			args.turn.bargeInCancelMs,
		);
	}
	const finalizedAtMs = Math.max(0, ...Object.values(trace.marks));
	trace = finalizeRealtimeVoiceTrace(trace, "interrupted", finalizedAtMs);
	return addLateAudio(trace, args.turn.realtime);
}

function syntheticBase(args: {
	sampleRate: number;
	settings: VoiceWorkbenchEvidenceSettings;
	windowEndMs: number;
}): {
	measurementWindow: VoiceEvaluationMeasurementWindow;
	capture: VoiceCaptureEvaluation;
	playback: VoicePlaybackEvaluation;
	transport: VoiceTransportContinuityEvaluation;
} {
	return {
		measurementWindow: {
			startedAt: { clockDomain: "synthetic_monotonic", atMs: 0 },
			endedAt: {
				clockDomain: "synthetic_monotonic",
				atMs: Math.max(1, args.windowEndMs),
			},
		},
		capture: {
			requested: {
				sampleRateHz: args.sampleRate,
				channelCount: 1,
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false,
			},
			granted: {
				sampleRateHz: args.sampleRate,
				channelCount: 1,
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false,
			},
			inputDeviceClass: "virtual",
			inputSelection: "unsupported",
			deviceChangeHandling: "unsupported",
		},
		playback: {
			requestedSampleRateHz: args.sampleRate,
			actualSampleRateHz: args.sampleRate,
			outputDeviceClass: "virtual",
			outputSelection: "unsupported",
			sampleRateConversion: "passed",
		},
		transport: {
			sampleRateHz: args.sampleRate,
			channelCount: 1,
			requestedFrameDurationMs: args.settings.requestedFrameDurationMs,
			observedFrameDurationMs: "not_measured",
			sentFrameCount: 0,
			receivedFrameCount: 0,
			packetGapCount: 0,
			duplicateFrameCount: 0,
			outOfOrderFrameCount: 0,
			continuity: "unsupported",
		},
	};
}

function statusFromCompleteness(args: {
	complete: boolean;
	failed: boolean;
}): VoiceDeviceMeasurementStatus {
	return args.failed ? "failed" : args.complete ? "passed" : "not_measured";
}

function bargeInEvaluation(
	turns: readonly VoiceWorkbenchObservedTurnEvidence[],
): VoiceBargeInEvaluation {
	const trials = turns.filter(
		(turn) => turn.bargeIn && turn.expectBargeInCancel,
	);
	const localDurations = trials.flatMap((turn) =>
		finiteNonNegative(turn.bargeInCancelMs) ? [turn.bargeInCancelMs] : [],
	);
	const serverDurations = trials.flatMap((turn) => {
		const marks = turn.realtime?.interruptionMarks;
		const speech = marks?.local_speech_detected;
		const ack = marks?.server_interrupt_ack;
		return finiteNonNegative(speech) && finiteNonNegative(ack) && ack >= speech
			? [ack - speech]
			: [];
	});
	const lateAudioMeasured = trials.every((turn) =>
		finiteNonNegativeInteger(turn.realtime?.lateAudioFrames),
	);
	const lateAudioFrames = lateAudioMeasured
		? trials.reduce(
				(total, turn) => total + (turn.realtime?.lateAudioFrames ?? 0),
				0,
			)
		: "not_measured";
	const replacementMeasured = trials.every(
		(turn) => typeof turn.realtime?.replacementContextIntegrity === "boolean",
	);
	const replacementFailed = trials.some(
		(turn) => turn.realtime?.replacementContextIntegrity === false,
	);
	const replacementContextIntegrity = statusFromCompleteness({
		complete: trials.length > 0 && replacementMeasured,
		failed: replacementFailed,
	});
	const successfulInterruptionCount = trials.filter((turn) =>
		finiteNonNegative(turn.bargeInCancelMs),
	).length;
	const complete =
		trials.length > 0 &&
		localDurations.length === trials.length &&
		serverDurations.length === trials.length &&
		lateAudioMeasured &&
		replacementMeasured;
	const failed =
		trials.length > 0 &&
		(successfulInterruptionCount !== trials.length || replacementFailed);
	return {
		trialCount: trials.length,
		successfulInterruptionCount,
		localSpeechToSilenceP95Ms: percentile95(localDurations),
		serverSpeechToAckP95Ms: percentile95(serverDurations),
		lateAudioFrames,
		replacementContextIntegrity,
		status: statusFromCompleteness({ complete, failed }),
	};
}

function doubleTalkEvaluation(
	turns: readonly VoiceWorkbenchObservedTurnEvidence[],
): VoiceDoubleTalkEvaluation {
	const measuredUserTrials = turns.filter(
		(turn) => typeof turn.realtime?.doubleTalkUserSpeechDetected === "boolean",
	);
	const echoTrials = turns.filter((turn) => turn.isAgentEcho);
	const successfulUserSpeechDetectionCount = measuredUserTrials.filter(
		(turn) => turn.realtime?.doubleTalkUserSpeechDetected === true,
	).length;
	const echoOnlyFalseTurnCount = echoTrials.filter(
		(turn) => turn.responded,
	).length;
	const complete = measuredUserTrials.length > 0 && echoTrials.length > 0;
	const failed =
		complete &&
		(successfulUserSpeechDetectionCount !== measuredUserTrials.length ||
			echoOnlyFalseTurnCount > 0);
	return {
		trialCount: measuredUserTrials.length,
		successfulUserSpeechDetectionCount,
		echoOnlyTrialCount: echoTrials.length,
		echoOnlyFalseTurnCount,
		status: statusFromCompleteness({ complete, failed }),
	};
}

function safeProviderPath(
	settings: VoiceWorkbenchEvidenceSettings,
	evidenceKind: VoiceDeviceEvidenceKind,
): VoiceEvaluationProviderPath {
	if (evidenceKind === "real_device_live_provider") {
		return settings.providerPath;
	}
	return {
		...settings.providerPath,
		// An offline corpus can exercise real providers, but it did not measure a
		// capture-to-playback device round trip.
		roundTrip:
			settings.lane === "mock" || settings.lane === "logic"
				? "unsupported"
				: "not_measured",
	};
}

function makeObservation(args: {
	scenarioId: string;
	profile: VoiceDeviceEvaluationProfile;
	evidenceKind: VoiceDeviceEvidenceKind;
	providerPath: VoiceEvaluationProviderPath;
	base: {
		measurementWindow: VoiceEvaluationMeasurementWindow;
		capture: VoiceCaptureEvaluation;
		playback: VoicePlaybackEvaluation;
		transport: VoiceTransportContinuityEvaluation;
	};
	bargeIn: VoiceBargeInEvaluation;
	doubleTalk: VoiceDoubleTalkEvaluation;
}): VoiceDeviceEvaluationObservation | null {
	return parseVoiceDeviceEvaluationObservation({
		schemaVersion: 1,
		evaluationId: deterministicUuid(`${args.scenarioId}:${args.profile}`),
		profile: args.profile,
		evidenceKind: args.evidenceKind,
		providerPath: args.providerPath,
		measurementWindow: args.base.measurementWindow,
		capture: args.base.capture,
		playback: args.base.playback,
		transport: args.base.transport,
		bargeIn: args.bargeIn,
		doubleTalk: args.doubleTalk,
	});
}

export function buildVoiceWorkbenchScenarioEvidence(args: {
	scenarioId: string;
	sampleRate: number;
	settings: VoiceWorkbenchEvidenceSettings;
	turns: readonly VoiceWorkbenchObservedTurnEvidence[];
}): VoiceWorkbenchScenarioEvidence {
	const classificationPassed = hasMeasuredLiveDeviceEvidence(args.settings);
	const evidenceKind: VoiceDeviceEvidenceKind = classificationPassed
		? "real_device_live_provider"
		: "deterministic_fake_media";
	const classificationBlockers: string[] = [];
	if (args.settings.lane === "live_device_provider" && !classificationPassed) {
		classificationBlockers.push("live_device_provider_evidence_incomplete");
	}
	if (
		args.settings.lane === "offline_provider" ||
		args.settings.lane === "live_device_provider"
	) {
		if (!classificationPassed) {
			classificationBlockers.push("device_round_trip_not_measured");
		}
	}

	const dimensions = traceDimensions(
		args.settings,
		evidenceKind,
		args.sampleRate,
	);
	const traces = args.turns.flatMap((turn) => {
		const response = buildResponseTrace({
			scenarioId: args.scenarioId,
			turn,
			dimensions,
		});
		const interruption = buildInterruptionTrace({
			scenarioId: args.scenarioId,
			turn,
			dimensions,
		});
		return [response, interruption].filter(
			(trace): trace is RealtimeVoiceTrace => trace !== null,
		);
	});
	const expectedResponseTraceCount = args.turns.filter(
		(turn) => turn.expectRespond && !turn.isAgentEcho,
	).length;
	const expectedInterruptionTraceCount = args.turns.filter(
		(turn) => turn.bargeIn && turn.expectBargeInCancel,
	).length;
	const observedResponseTraceCount = traces.filter((trace) =>
		trace.profiles.includes("spoken_response"),
	).length;
	const observedInterruptionTraceCount = traces.filter((trace) =>
		trace.profiles.includes("interruption"),
	).length;
	const windowEndMs = Math.max(
		1,
		...traces.flatMap((trace) => [
			trace.finalizedAtMs ?? 0,
			trace.lastLateAudioFrameAtMs ?? 0,
		]),
	);
	const base =
		evidenceKind === "real_device_live_provider" && args.settings.liveDevice
			? args.settings.liveDevice
			: syntheticBase({
					sampleRate: args.sampleRate,
					settings: args.settings,
					windowEndMs,
				});
	const bargeIn = bargeInEvaluation(args.turns);
	const doubleTalk = doubleTalkEvaluation(args.turns);
	const profiles: VoiceDeviceEvaluationProfile[] = [
		"capture_routing",
		"transport_continuity",
	];
	if (args.turns.some((turn) => turn.bargeIn)) profiles.push("barge_in");
	if (
		args.turns.some(
			(turn) =>
				turn.isAgentEcho ||
				typeof turn.realtime?.doubleTalkUserSpeechDetected === "boolean",
		)
	) {
		profiles.push("double_talk");
	}
	const providerPath = safeProviderPath(args.settings, evidenceKind);
	const deviceObservations = profiles.flatMap((profile) => {
		const observation = makeObservation({
			scenarioId: args.scenarioId,
			profile,
			evidenceKind,
			providerPath,
			base,
			bargeIn,
			doubleTalk,
		});
		return observation ? [observation] : [];
	});
	if (deviceObservations.length !== profiles.length) {
		classificationBlockers.push("device_observation_schema_invalid");
	}

	return {
		schemaVersion: 1,
		lane: args.settings.lane,
		evidenceKind,
		classificationPassed:
			args.settings.lane === "live_device_provider"
				? classificationPassed
				: true,
		classificationBlockers,
		expectedResponseTraceCount,
		observedResponseTraceCount,
		expectedInterruptionTraceCount,
		observedInterruptionTraceCount,
		requirements:
			args.settings.releaseRequirements ??
			DEFAULT_VOICE_WORKBENCH_RELEASE_REQUIREMENTS,
		traces,
		deviceObservations,
	};
}

function stableJson(value: unknown): string {
	return JSON.stringify(value);
}

export function buildVoiceWorkbenchEvidenceReport(
	scenarios: readonly VoiceWorkbenchScenarioEvidence[],
): VoiceWorkbenchEvidenceReport | undefined {
	if (scenarios.length === 0) return undefined;
	const traces = scenarios.flatMap((scenario) => scenario.traces);
	const liveTraces = scenarios.flatMap((scenario) =>
		scenario.evidenceKind === "real_device_live_provider"
			? scenario.traces
			: [],
	);
	const deviceObservations = scenarios.flatMap(
		(scenario) => scenario.deviceObservations,
	);
	const expectedTraceCount = scenarios.reduce(
		(total, scenario) =>
			total +
			scenario.expectedResponseTraceCount +
			scenario.expectedInterruptionTraceCount,
		0,
	);
	const traceArtifactCoveragePassed = scenarios.every(
		(scenario) =>
			scenario.observedResponseTraceCount ===
				scenario.expectedResponseTraceCount &&
			scenario.observedInterruptionTraceCount ===
				scenario.expectedInterruptionTraceCount,
	);
	const deviceRequirements =
		scenarios[0]?.requirements ?? DEFAULT_VOICE_WORKBENCH_RELEASE_REQUIREMENTS;
	const requirementsConsistent = scenarios.every(
		(scenario) =>
			stableJson(scenario.requirements) === stableJson(deviceRequirements),
	);
	const diagnosticLatency = summarizeRealtimeVoiceLatency(traces, {
		minimumTraceCount: 1,
	});
	const releaseLatency = summarizeRealtimeVoiceLatency(liveTraces, {
		minimumTraceCount: 1,
		minimumProfileCounts: RELEASE_TRACE_PROFILE_MINIMUMS,
	});
	const deviceEvaluation = summarizeVoiceDeviceEvaluation(
		deviceObservations,
		deviceRequirements,
	);
	const laneCounts: Record<VoiceWorkbenchEvidenceLane, number> = {
		mock: 0,
		logic: 0,
		offline_provider: 0,
		live_device_provider: 0,
	};
	const evidenceKindCounts: Record<VoiceDeviceEvidenceKind, number> = {
		deterministic_fake_media: 0,
		real_device_offline: 0,
		real_device_live_provider: 0,
	};
	for (const scenario of scenarios) {
		laneCounts[scenario.lane] += 1;
		evidenceKindCounts[scenario.evidenceKind] += 1;
	}

	const releaseBlockers = new Set<string>();
	for (const scenario of scenarios) {
		for (const blocker of scenario.classificationBlockers) {
			releaseBlockers.add(blocker);
		}
	}
	if (!requirementsConsistent) {
		releaseBlockers.add("device_requirements_inconsistent");
	}
	if (liveTraces.length === 0) {
		releaseBlockers.add("live_provider_trace_cohort_missing");
	}
	if (!traceArtifactCoveragePassed) {
		releaseBlockers.add("trace_artifact_coverage_incomplete");
	}
	if (!releaseLatency.coveragePassed) {
		releaseBlockers.add("live_provider_trace_coverage_incomplete");
	}
	if (!releaseLatency.sloPassed) {
		releaseBlockers.add("live_provider_latency_slo_failed");
	}
	if (
		!releaseLatency.zeroLateAudioPassed ||
		!diagnosticLatency.zeroLateAudioPassed
	) {
		releaseBlockers.add("late_audio_detected");
	}
	if (!deviceEvaluation.requirementsValid) {
		releaseBlockers.add("device_requirements_invalid");
	}
	if (!deviceEvaluation.allMeasurementsPassed) {
		releaseBlockers.add("device_measurements_incomplete_or_failed");
	}
	if (!deviceEvaluation.profileCoveragePassed) {
		releaseBlockers.add("device_profile_coverage_missing");
	}
	if (!deviceEvaluation.deviceMatrixPassed) {
		releaseBlockers.add("device_matrix_coverage_missing");
	}
	if (!deviceEvaluation.zeroLateAudioPassed) {
		releaseBlockers.add("device_late_audio_not_zero");
	}
	const releaseGatePassed =
		requirementsConsistent &&
		traceArtifactCoveragePassed &&
		releaseLatency.passed &&
		deviceEvaluation.passed &&
		scenarios.every((scenario) => scenario.classificationPassed);

	return {
		schemaVersion: 1,
		contentFree: true,
		laneCounts,
		evidenceKindCounts,
		traceCount: traces.length,
		liveProviderTraceCount: liveTraces.length,
		expectedTraceCount,
		traceArtifactCoveragePassed,
		diagnosticLatency,
		releaseLatency,
		traces,
		deviceObservations,
		deviceRequirements,
		deviceEvaluation,
		releaseGatePassed,
		releaseBlockers: [...releaseBlockers],
	};
}
