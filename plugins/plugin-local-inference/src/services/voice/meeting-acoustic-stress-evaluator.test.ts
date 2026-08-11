/**
 * Covers canonical manifest validation and safe artifact loading for the
 * deterministic meeting acoustic-stress evaluator without native models.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CorpusGroundTruth } from "./corpus-generator";
import {
	loadMeetingStressCorpus,
	MEETING_STRESS_CORPUS_SCHEMA_VERSION,
	type MeetingStressCorpusManifest,
	parseMeetingStressCorpusManifest,
} from "./meeting-acoustic-stress-evaluator";
import { buildMeetingAcousticStressMatrix } from "./meeting-acoustic-stress-matrix";
import { encodeMonoPcm16Wav } from "./wav-codec";

function manifestFixture(): MeetingStressCorpusManifest {
	const matrix = buildMeetingAcousticStressMatrix();
	return {
		schemaVersion: MEETING_STRESS_CORPUS_SCHEMA_VERSION,
		mode: "meeting_stress",
		meetingAcousticStressMatrix: {
			schemaVersion: matrix.schemaVersion,
			seed: matrix.seed,
			requirements: matrix.requirements,
			sourceManifests: matrix.sourceManifests,
			cases: matrix.cases.map(({ scenario: _scenario, ...entry }) => entry),
		},
		scenarios: matrix.cases.map(({ scenario, ...stress }) => ({
			scenarioId: scenario.id,
			classes: scenario.classes,
			durationSec: 1 / 16_000,
			turns: scenario.turns.length,
			degraded: true,
			dir: scenario.id,
			audioSourceMode: "synthetic_smoke",
			actualSourceManifestIds: ["synthetic_smoke"],
			stress,
		})),
	};
}

function writeCorpusFixture(): {
	dir: string;
	manifest: MeetingStressCorpusManifest;
} {
	const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-stress-evaluator-"));
	const manifest = manifestFixture();
	const matrix = buildMeetingAcousticStressMatrix();
	for (const [index, entry] of manifest.scenarios.entries()) {
		const scenario = matrix.cases[index]?.scenario;
		if (!scenario) throw new Error(`missing canonical scenario ${index}`);
		const scenarioDir = path.join(dir, entry.dir);
		mkdirSync(scenarioDir, { recursive: true });
		const groundTruth: CorpusGroundTruth = {
			schemaVersion: 1,
			scenarioId: scenario.id,
			classes: scenario.classes,
			sampleRate: 16_000,
			totalSamples: 1,
			durationSec: 1 / 16_000,
			participants: scenario.participants,
			turns: scenario.turns.map((turn, turnIndex) => ({
				index: turnIndex,
				speaker: turn.expectedSpeakerLabel ?? turn.speaker,
				speechStartSample: 0,
				speechEndSample: 1,
				segmentStartSample: 0,
				segmentEndSample: 1,
				referenceTranscript: turn.text ?? "fixture transcript",
				expectRespond: turn.expectRespond,
				synthetic: true,
				...(turn.expectedEntity ? { expectedEntity: turn.expectedEntity } : {}),
			})),
			synthetic: true,
		};
		writeFileSync(
			path.join(scenarioDir, "audio.wav"),
			encodeMonoPcm16Wav(new Float32Array(1), 16_000),
		);
		writeFileSync(
			path.join(scenarioDir, "ground-truth.json"),
			JSON.stringify(groundTruth),
		);
	}
	writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
	return { dir, manifest };
}

describe("meeting acoustic-stress evaluator", () => {
	it("accepts exactly the canonical 35-case manifest", () => {
		const parsed = parseMeetingStressCorpusManifest(manifestFixture());
		expect(parsed.scenarios).toHaveLength(35);
		expect(parsed.meetingAcousticStressMatrix.cases).toHaveLength(35);
	});

	it("rejects incomplete matrices before model execution", () => {
		const manifest = manifestFixture();
		manifest.scenarios.pop();
		expect(() => parseMeetingStressCorpusManifest(manifest)).toThrow(
			"expected 35 scenarios, found 34",
		);
	});

	it("loads artifacts, hashes them, and marks synthetic smoke non-publishable", () => {
		const { dir } = writeCorpusFixture();
		try {
			const loaded = loadMeetingStressCorpus(dir);
			expect(loaded.entries).toHaveLength(35);
			expect(loaded.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
			expect(loaded.entries[0]?.audioSha256).toMatch(/^[a-f0-9]{64}$/);
			expect(loaded.publishable).toBe(false);
			expect(loaded.nonPublishableReasons).toContain(
				"one or more scenarios use deterministic synthetic formant speech",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects scenario directories that escape the corpus root", () => {
		const { dir, manifest } = writeCorpusFixture();
		try {
			const first = manifest.scenarios[0];
			if (!first) throw new Error("fixture has no scenarios");
			first.dir = "../outside";
			writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
			expect(() => loadMeetingStressCorpus(dir)).toThrow(
				"scenario dir escapes corpus root",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
