/**
 * Loads and validates an on-disk meeting acoustic-stress corpus for real voice
 * evaluation. The boundary is deliberately strict: every canonical matrix case
 * and artifact must be present, paths must remain inside the corpus root, and a
 * synthetic corpus is identified as smoke evidence rather than publishable proof.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
	CORPUS_SCHEMA_VERSION,
	type CorpusGroundTruth,
	type GeneratedVoiceCorpus,
} from "./corpus-generator";
import { decodeMonoPcm16Wav } from "./engine-bridge";
import {
	buildMeetingAcousticStressMatrix,
	type MeetingAcousticStressCase,
	type MeetingAcousticStressSourceManifest,
} from "./meeting-acoustic-stress-matrix";
import { type VoiceScenario, validateVoiceScenario } from "./voice-scenario";

export const MEETING_STRESS_CORPUS_SCHEMA_VERSION = 2 as const;

export type MeetingStressAudioSourceMode = "synthetic_smoke" | "real_evidence";

export interface MeetingStressCorpusScenarioManifest {
	scenarioId: string;
	classes: VoiceScenario["classes"];
	durationSec: number;
	turns: number;
	degraded: boolean;
	dir: string;
	audioSourceMode: MeetingStressAudioSourceMode;
	actualSourceManifestIds: string[];
	stress: Omit<MeetingAcousticStressCase, "scenario">;
}

export interface MeetingStressCorpusManifest {
	schemaVersion: typeof MEETING_STRESS_CORPUS_SCHEMA_VERSION;
	mode: "meeting_stress";
	meetingAcousticStressMatrix: {
		schemaVersion: 1;
		seed: number;
		requirements: ReturnType<
			typeof buildMeetingAcousticStressMatrix
		>["requirements"];
		sourceManifests: MeetingAcousticStressSourceManifest[];
		cases: Array<Omit<MeetingAcousticStressCase, "scenario">>;
	};
	scenarios: MeetingStressCorpusScenarioManifest[];
}

export interface LoadedMeetingStressScenario {
	manifest: MeetingStressCorpusScenarioManifest;
	scenario: VoiceScenario;
	corpus: GeneratedVoiceCorpus;
	audioPath: string;
	groundTruthPath: string;
	audioSha256: string;
	groundTruthSha256: string;
}

export interface LoadedMeetingStressCorpus {
	rootDir: string;
	manifestPath: string;
	manifestSha256: string;
	manifest: MeetingStressCorpusManifest;
	entries: LoadedMeetingStressScenario[];
	publishable: boolean;
	nonPublishableReasons: string[];
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`[meeting-stress] ${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`[meeting-stress] ${label} must be a non-empty string`);
	}
	return value;
}

function numberValue(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`[meeting-stress] ${label} must be a finite number`);
	}
	return value;
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`[meeting-stress] ${label} must be a boolean`);
	}
	return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`[meeting-stress] ${label} must be an array`);
	}
	return value;
}

function stringArray(value: unknown, label: string): string[] {
	return arrayValue(value, label).map((entry, index) =>
		stringValue(entry, `${label}[${index}]`),
	);
}

function exactJson(actual: unknown, expected: unknown, label: string): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`[meeting-stress] ${label} does not match the canonical matrix`,
		);
	}
}

function parseStressCase(
	value: unknown,
	label: string,
): Omit<MeetingAcousticStressCase, "scenario"> {
	const input = record(value, label);
	return {
		id: stringValue(input.id, `${label}.id`),
		snrDb: numberValue(
			input.snrDb,
			`${label}.snrDb`,
		) as MeetingAcousticStressCase["snrDb"],
		background: stringValue(
			input.background,
			`${label}.background`,
		) as MeetingAcousticStressCase["background"],
		room: stringValue(
			input.room,
			`${label}.room`,
		) as MeetingAcousticStressCase["room"],
		quality: stringValue(
			input.quality,
			`${label}.quality`,
		) as MeetingAcousticStressCase["quality"],
		speechStructure: stringValue(
			input.speechStructure,
			`${label}.speechStructure`,
		) as MeetingAcousticStressCase["speechStructure"],
		speakerCount: numberValue(
			input.speakerCount,
			`${label}.speakerCount`,
		) as MeetingAcousticStressCase["speakerCount"],
		expectedBehavior: stringValue(
			input.expectedBehavior,
			`${label}.expectedBehavior`,
		) as MeetingAcousticStressCase["expectedBehavior"],
		seed: numberValue(input.seed, `${label}.seed`),
		sourceManifestIds: stringArray(
			input.sourceManifestIds,
			`${label}.sourceManifestIds`,
		),
	};
}

function parseSourceManifest(
	value: unknown,
	label: string,
): MeetingAcousticStressSourceManifest {
	const input = record(value, label);
	const mode = stringValue(input.mode, `${label}.mode`);
	if (mode !== "synthetic_smoke" && mode !== "real_evidence") {
		throw new Error(`[meeting-stress] ${label}.mode is invalid: ${mode}`);
	}
	return {
		id: stringValue(input.id, `${label}.id`),
		source: stringValue(input.source, `${label}.source`),
		license: stringValue(input.license, `${label}.license`),
		mode,
		covers: stringArray(input.covers, `${label}.covers`),
	};
}

function parseScenarioManifest(
	value: unknown,
	label: string,
): MeetingStressCorpusScenarioManifest {
	const input = record(value, label);
	const audioSourceMode = stringValue(
		input.audioSourceMode,
		`${label}.audioSourceMode`,
	);
	if (
		audioSourceMode !== "synthetic_smoke" &&
		audioSourceMode !== "real_evidence"
	) {
		throw new Error(
			`[meeting-stress] ${label}.audioSourceMode is invalid: ${audioSourceMode}`,
		);
	}
	return {
		scenarioId: stringValue(input.scenarioId, `${label}.scenarioId`),
		classes: stringArray(
			input.classes,
			`${label}.classes`,
		) as VoiceScenario["classes"],
		durationSec: numberValue(input.durationSec, `${label}.durationSec`),
		turns: numberValue(input.turns, `${label}.turns`),
		degraded: booleanValue(input.degraded, `${label}.degraded`),
		dir: stringValue(input.dir, `${label}.dir`),
		audioSourceMode,
		actualSourceManifestIds: stringArray(
			input.actualSourceManifestIds,
			`${label}.actualSourceManifestIds`,
		),
		stress: parseStressCase(input.stress, `${label}.stress`),
	};
}

/** Parse and prove that a manifest is the complete canonical 35-case matrix. */
export function parseMeetingStressCorpusManifest(
	value: unknown,
): MeetingStressCorpusManifest {
	const input = record(value, "manifest");
	if (input.schemaVersion !== MEETING_STRESS_CORPUS_SCHEMA_VERSION) {
		throw new Error(
			`[meeting-stress] manifest.schemaVersion must be ${MEETING_STRESS_CORPUS_SCHEMA_VERSION}`,
		);
	}
	if (input.mode !== "meeting_stress") {
		throw new Error('[meeting-stress] manifest.mode must be "meeting_stress"');
	}
	const matrixInput = record(
		input.meetingAcousticStressMatrix,
		"manifest.meetingAcousticStressMatrix",
	);
	if (matrixInput.schemaVersion !== 1) {
		throw new Error(
			"[meeting-stress] meetingAcousticStressMatrix.schemaVersion must be 1",
		);
	}
	const seed = numberValue(
		matrixInput.seed,
		"manifest.meetingAcousticStressMatrix.seed",
	);
	const canonical = buildMeetingAcousticStressMatrix(seed);
	const sources = arrayValue(
		matrixInput.sourceManifests,
		"manifest.meetingAcousticStressMatrix.sourceManifests",
	).map((entry, index) =>
		parseSourceManifest(
			entry,
			`manifest.meetingAcousticStressMatrix.sourceManifests[${index}]`,
		),
	);
	const cases = arrayValue(
		matrixInput.cases,
		"manifest.meetingAcousticStressMatrix.cases",
	).map((entry, index) =>
		parseStressCase(
			entry,
			`manifest.meetingAcousticStressMatrix.cases[${index}]`,
		),
	);
	const scenarios = arrayValue(input.scenarios, "manifest.scenarios").map(
		(entry, index) =>
			parseScenarioManifest(entry, `manifest.scenarios[${index}]`),
	);

	exactJson(matrixInput.requirements, canonical.requirements, "requirements");
	exactJson(sources, canonical.sourceManifests, "source manifests");
	exactJson(
		cases,
		canonical.cases.map(({ scenario: _scenario, ...entry }) => entry),
		"matrix cases",
	);
	if (scenarios.length !== canonical.cases.length) {
		throw new Error(
			`[meeting-stress] expected ${canonical.cases.length} scenarios, found ${scenarios.length}`,
		);
	}
	const scenarioIds = new Set(scenarios.map((entry) => entry.scenarioId));
	if (scenarioIds.size !== scenarios.length) {
		throw new Error("[meeting-stress] scenario ids must be unique");
	}
	for (const [index, canonicalCase] of canonical.cases.entries()) {
		const scenario = scenarios[index];
		if (!scenario) {
			throw new Error(`[meeting-stress] missing scenario at index ${index}`);
		}
		if (scenario.scenarioId !== canonicalCase.id) {
			throw new Error(
				`[meeting-stress] scenario order/id drift at index ${index}: expected ${canonicalCase.id}, found ${scenario.scenarioId}`,
			);
		}
		const { scenario: _scenario, ...canonicalStress } = canonicalCase;
		exactJson(
			scenario.stress,
			canonicalStress,
			`scenario ${scenario.scenarioId}`,
		);
		exactJson(
			scenario.classes,
			canonicalCase.scenario.classes,
			`scenario ${scenario.scenarioId} classes`,
		);
		if (scenario.turns !== canonicalCase.scenario.turns.length) {
			throw new Error(
				`[meeting-stress] ${scenario.scenarioId} expected ${canonicalCase.scenario.turns.length} turns, found ${scenario.turns}`,
			);
		}
		if (
			!scenario.actualSourceManifestIds.includes("synthetic_smoke") &&
			scenario.audioSourceMode === "synthetic_smoke"
		) {
			throw new Error(
				`[meeting-stress] ${scenario.scenarioId} synthetic smoke is missing synthetic_smoke provenance`,
			);
		}
		for (const sourceId of scenario.actualSourceManifestIds) {
			if (!sources.some((source) => source.id === sourceId)) {
				throw new Error(
					`[meeting-stress] ${scenario.scenarioId} references unknown actual source ${sourceId}`,
				);
			}
		}
		if (
			scenario.audioSourceMode === "real_evidence" &&
			!scenario.actualSourceManifestIds.some(
				(sourceId) =>
					sources.find((source) => source.id === sourceId)?.mode ===
					"real_evidence",
			)
		) {
			throw new Error(
				`[meeting-stress] ${scenario.scenarioId} real evidence declares no real source manifest`,
			);
		}
	}

	return {
		schemaVersion: MEETING_STRESS_CORPUS_SCHEMA_VERSION,
		mode: "meeting_stress",
		meetingAcousticStressMatrix: {
			schemaVersion: 1,
			seed,
			requirements: canonical.requirements,
			sourceManifests: sources,
			cases,
		},
		scenarios,
	};
}

function sha256File(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function containedRealPath(rootDir: string, relativeDir: string): string {
	if (path.isAbsolute(relativeDir)) {
		throw new Error(
			`[meeting-stress] scenario dir must be relative: ${relativeDir}`,
		);
	}
	const candidate = path.resolve(rootDir, relativeDir);
	if (candidate !== rootDir && !candidate.startsWith(`${rootDir}${path.sep}`)) {
		throw new Error(
			`[meeting-stress] scenario dir escapes corpus root: ${relativeDir}`,
		);
	}
	if (!existsSync(candidate)) {
		throw new Error(`[meeting-stress] scenario dir is missing: ${candidate}`);
	}
	const real = realpathSync(candidate);
	if (real !== rootDir && !real.startsWith(`${rootDir}${path.sep}`)) {
		throw new Error(
			`[meeting-stress] scenario dir symlink escapes corpus root: ${relativeDir}`,
		);
	}
	return real;
}

function assertGroundTruth(
	value: unknown,
	expected: MeetingStressCorpusScenarioManifest,
): CorpusGroundTruth {
	const input = record(value, `${expected.scenarioId}/ground-truth.json`);
	if (input.schemaVersion !== CORPUS_SCHEMA_VERSION) {
		throw new Error(
			`[meeting-stress] ${expected.scenarioId} ground-truth schema is incompatible`,
		);
	}
	if (input.scenarioId !== expected.scenarioId) {
		throw new Error(
			`[meeting-stress] ground-truth scenario id mismatch for ${expected.scenarioId}`,
		);
	}
	const turns = arrayValue(input.turns, `${expected.scenarioId}.turns`);
	if (turns.length !== expected.turns) {
		throw new Error(
			`[meeting-stress] ${expected.scenarioId} expected ${expected.turns} turns, found ${turns.length}`,
		);
	}
	for (const [index, rawTurn] of turns.entries()) {
		const turn = record(rawTurn, `${expected.scenarioId}.turns[${index}]`);
		stringValue(turn.speaker, `${expected.scenarioId}.turns[${index}].speaker`);
		stringValue(
			turn.referenceTranscript,
			`${expected.scenarioId}.turns[${index}].referenceTranscript`,
		);
		booleanValue(
			turn.expectRespond,
			`${expected.scenarioId}.turns[${index}].expectRespond`,
		);
		numberValue(
			turn.segmentStartSample,
			`${expected.scenarioId}.turns[${index}].segmentStartSample`,
		);
		numberValue(
			turn.segmentEndSample,
			`${expected.scenarioId}.turns[${index}].segmentEndSample`,
		);
	}
	const participants = arrayValue(
		input.participants,
		`${expected.scenarioId}.participants`,
	);
	if (participants.length !== expected.stress.speakerCount) {
		throw new Error(
			`[meeting-stress] ${expected.scenarioId} expected ${expected.stress.speakerCount} participants, found ${participants.length}`,
		);
	}
	for (const [index, rawParticipant] of participants.entries()) {
		const participant = record(
			rawParticipant,
			`${expected.scenarioId}.participants[${index}]`,
		);
		stringValue(
			participant.label,
			`${expected.scenarioId}.participants[${index}].label`,
		);
	}
	exactJson(input.classes, expected.classes, `${expected.scenarioId} classes`);
	const sampleRate = numberValue(
		input.sampleRate,
		`${expected.scenarioId}.sampleRate`,
	);
	const totalSamples = numberValue(
		input.totalSamples,
		`${expected.scenarioId}.totalSamples`,
	);
	if (sampleRate <= 0 || totalSamples < 0 || !Number.isInteger(totalSamples)) {
		throw new Error(
			`[meeting-stress] ${expected.scenarioId} has invalid sample metadata`,
		);
	}
	const durationSec = numberValue(
		input.durationSec,
		`${expected.scenarioId}.durationSec`,
	);
	if (Math.abs(durationSec - expected.durationSec) > 0.001) {
		throw new Error(
			`[meeting-stress] ${expected.scenarioId} duration disagrees with manifest`,
		);
	}
	const synthetic = booleanValue(
		input.synthetic,
		`${expected.scenarioId}.synthetic`,
	);
	if ((expected.audioSourceMode === "synthetic_smoke") !== synthetic) {
		throw new Error(
			`[meeting-stress] ${expected.scenarioId} audioSourceMode disagrees with ground truth synthetic=${synthetic}`,
		);
	}
	return input as unknown as CorpusGroundTruth;
}

function scenarioFromGroundTruth(
	groundTruth: CorpusGroundTruth,
): VoiceScenario {
	const scenario: VoiceScenario = {
		id: groundTruth.scenarioId,
		description: "Loaded meeting acoustic-stress corpus evidence",
		classes: groundTruth.classes,
		participants: groundTruth.participants,
		turns: groundTruth.turns.map((turn, index) => ({
			// Corpus labels carry the expected diarization label (including the
			// deliberate "unknown" class), which need not be an enrollable
			// participant. The scenario shell uses the corresponding participant
			// for validation while preserving the scored label explicitly.
			speaker:
				groundTruth.participants.find(
					(participant) => participant.label === turn.speaker,
				)?.label ??
				groundTruth.participants[index % groundTruth.participants.length]
					?.label ??
				turn.speaker,
			text: turn.referenceTranscript,
			expectedTranscript: turn.referenceTranscript,
			expectedSpeakerLabel: turn.speaker,
			expectRespond: turn.expectRespond,
			...(turn.expectEndOfTurn !== undefined
				? { expectEndOfTurn: turn.expectEndOfTurn }
				: {}),
			...(turn.expectedEntity ? { expectedEntity: turn.expectedEntity } : {}),
			...(turn.ttsVoiceId ? { ttsVoiceId: turn.ttsVoiceId } : {}),
			...(turn.isAgentEcho ? { isAgentEcho: true } : {}),
			...(turn.agentReplyText ? { agentReplyText: turn.agentReplyText } : {}),
			...(turn.bargeIn ? { bargeIn: true } : {}),
			...(turn.expectBargeInCancel !== undefined
				? { expectBargeInCancel: turn.expectBargeInCancel }
				: {}),
		})),
		...(groundTruth.agents ? { agents: groundTruth.agents } : {}),
		...(groundTruth.knownSpeakerEntityIds
			? { knownSpeakerEntityIds: groundTruth.knownSpeakerEntityIds }
			: {}),
	};
	const validation = validateVoiceScenario(scenario);
	if (!validation.valid) {
		throw new Error(
			`[meeting-stress] ${scenario.id} cannot reconstruct a valid scenario: ${validation.errors.join("; ")}`,
		);
	}
	return scenario;
}

/** Load all audio/labels only after the manifest passes canonical coverage. */
export function loadMeetingStressCorpus(
	corpusDir: string,
): LoadedMeetingStressCorpus {
	const rootDir = realpathSync(path.resolve(corpusDir));
	const manifestPath = path.join(rootDir, "manifest.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`[meeting-stress] manifest is missing: ${manifestPath}`);
	}
	const manifest = parseMeetingStressCorpusManifest(
		JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
	);
	const entries = manifest.scenarios.map((entry) => {
		const scenarioDir = containedRealPath(rootDir, entry.dir);
		const audioPath = path.join(scenarioDir, "audio.wav");
		const groundTruthPath = path.join(scenarioDir, "ground-truth.json");
		if (!existsSync(audioPath) || !existsSync(groundTruthPath)) {
			throw new Error(
				`[meeting-stress] ${entry.scenarioId} is missing audio.wav or ground-truth.json`,
			);
		}
		const groundTruth = assertGroundTruth(
			JSON.parse(readFileSync(groundTruthPath, "utf8")) as unknown,
			entry,
		);
		const { pcm, sampleRate } = decodeMonoPcm16Wav(
			new Uint8Array(readFileSync(audioPath)),
		);
		if (
			sampleRate !== groundTruth.sampleRate ||
			pcm.length !== groundTruth.totalSamples
		) {
			throw new Error(
				`[meeting-stress] ${entry.scenarioId} WAV metadata disagrees with ground truth`,
			);
		}
		return {
			manifest: entry,
			scenario: scenarioFromGroundTruth(groundTruth),
			corpus: { pcm, sampleRate, groundTruth },
			audioPath,
			groundTruthPath,
			audioSha256: sha256File(audioPath),
			groundTruthSha256: sha256File(groundTruthPath),
		};
	});
	const nonPublishableReasons: string[] = [];
	if (entries.some((entry) => entry.corpus.groundTruth.synthetic)) {
		nonPublishableReasons.push(
			"one or more scenarios use deterministic synthetic formant speech",
		);
	}
	if (
		entries.some((entry) => entry.manifest.audioSourceMode !== "real_evidence")
	) {
		nonPublishableReasons.push(
			"one or more scenarios declare audioSourceMode=synthetic_smoke",
		);
	}
	return {
		rootDir,
		manifestPath,
		manifestSha256: sha256File(manifestPath),
		manifest,
		entries,
		publishable: nonPublishableReasons.length === 0,
		nonPublishableReasons,
	};
}
