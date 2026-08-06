#!/usr/bin/env bun
/**
 * Evaluate the complete meeting acoustic-stress corpus through the real fused
 * voice stack. The lane refuses synthetic or partial evidence by default and
 * writes raw scorer cases, aggregate metrics, corpus provenance, and hashes for
 * every native/model artifact used by a publishable run.
 *
 * Usage:
 *   bun run meetingstress:real --corpus <dir> [--out <dir>]
 *   bun run meetingstress:real --corpus <dir> --validate-only
 *   bun run meetingstress:real --corpus <dir> --allow-synthetic [--case <id>]
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
	loadMeetingStressCorpus,
	type LoadedMeetingStressCorpus,
} from "../src/services/voice/meeting-acoustic-stress-evaluator.ts";
import {
	buildVoiceWorkbenchReport,
	formatVoiceWorkbenchMarkdown,
} from "../src/services/voice/voice-workbench-report.ts";
import { createRealVoiceWorkbenchRuntimeFromEnv } from "../src/services/voice/workbench-real-services.ts";
import { runVoiceWorkbenchHeadless } from "../src/services/voice/workbench-headless-runner.ts";
import {
	defaultReportDir,
	writeBenchReport,
} from "./voice-bench-shared.ts";

const TAG = "meeting-acoustic-stress";

interface ArtifactDigest {
	role: string;
	path: string;
	bytes: number;
	sha256: string;
}

function fail(message: string): never {
	process.stderr.write(`[${TAG}] FAIL: ${message}\n`);
	process.exit(1);
}

function argValue(args: string[], name: string): string | null {
	const index = args.indexOf(name);
	if (index < 0) return null;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		fail(`${name} requires a value`);
	}
	return value;
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

async function artifactDigest(
	role: string,
	filePath: string,
): Promise<ArtifactDigest> {
	if (!existsSync(filePath) || !statSync(filePath).isFile()) {
		fail(`${role} artifact is missing: ${filePath}`);
	}
	return {
		role,
		path: path.resolve(filePath),
		bytes: statSync(filePath).size,
		sha256: await sha256File(filePath),
	};
}

function gitRevision(): string {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: path.resolve(import.meta.dirname, "../../.."),
		encoding: "utf8",
	});
	return result.status === 0 ? result.stdout.trim() : "unavailable";
}

function corpusEvidence(corpus: LoadedMeetingStressCorpus): object {
	return {
		rootDir: corpus.rootDir,
		manifestPath: corpus.manifestPath,
		manifestSha256: corpus.manifestSha256,
		seed: corpus.manifest.meetingAcousticStressMatrix.seed,
		cases: corpus.entries.length,
		publishable: corpus.publishable,
		nonPublishableReasons: corpus.nonPublishableReasons,
		artifacts: corpus.entries.map((entry) => ({
			scenarioId: entry.manifest.scenarioId,
			audioSourceMode: entry.manifest.audioSourceMode,
			actualSourceManifestIds: entry.manifest.actualSourceManifestIds,
			audioPath: entry.audioPath,
			audioSha256: entry.audioSha256,
			groundTruthPath: entry.groundTruthPath,
			groundTruthSha256: entry.groundTruthSha256,
		})),
	};
}

function measuredMetrics(
	runs: Awaited<ReturnType<typeof runVoiceWorkbenchHeadless>>,
	corpus: LoadedMeetingStressCorpus,
): {
	blankOutputRate: number | null;
	hallucinatedResponseRate: number | null;
	speakerAttributionErrorRate: number | null;
} {
	const transcriptCases = runs
		.flatMap((run) => run.cases)
		.filter((entry) => entry.kind === "tts-asr-roundtrip");
	const respondCases = runs
		.flatMap((run) => run.cases)
		.filter((entry) => entry.kind === "respond-decision");
	const diarizationCases = runs
		.flatMap((run) => run.cases)
		.filter((entry) => entry.kind === "diarization");
	const blank = transcriptCases.filter(
		(entry) => entry.normalizedHypothesis.length === 0,
	).length;
	const negativeTurnsByScenario = new Map(
		corpus.entries.map((entry) => [
			entry.manifest.scenarioId,
			entry.corpus.groundTruth.turns.filter((turn) => !turn.expectRespond).length,
		]),
	);
	let falsePositiveResponses = 0;
	let negativeTurns = 0;
	for (const run of runs) {
		const respond = run.cases.find((entry) => entry.kind === "respond-decision");
		const scenarioNegativeTurns = negativeTurnsByScenario.get(run.scenarioId) ?? 0;
		if (!respond || scenarioNegativeTurns === 0) continue;
		falsePositiveResponses += respond.falsePositiveRate * scenarioNegativeTurns;
		negativeTurns += scenarioNegativeTurns;
	}
	return {
		blankOutputRate:
			transcriptCases.length > 0 ? blank / transcriptCases.length : null,
		// The real respond gate's false-positive rate is the operational
		// hallucinated-response measure: the agent spoke when ground truth said no.
		hallucinatedResponseRate:
			negativeTurns > 0 ? falsePositiveResponses / negativeTurns : null,
		speakerAttributionErrorRate:
			diarizationCases.length > 0
				? diarizationCases.reduce((total, entry) => total + entry.der, 0) /
					diarizationCases.length
				: null,
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const corpusArg = argValue(args, "--corpus");
	if (!corpusArg) fail("--corpus <dir> is required");
	const outArg = argValue(args, "--out");
	const caseId = argValue(args, "--case");
	const validateOnly = args.includes("--validate-only");
	const allowSynthetic = args.includes("--allow-synthetic");
	const corpus = loadMeetingStressCorpus(path.resolve(corpusArg));
	const outDir = outArg ? path.resolve(outArg) : defaultReportDir();

	if (validateOnly) {
		const { jsonPath, mdPath } = writeBenchReport(
			outDir,
			"meeting-acoustic-stress-validation",
			{
				schemaVersion: 1,
				generatedAt: new Date().toISOString(),
				gitRevision: gitRevision(),
				corpus: corpusEvidence(corpus),
			},
			[
				"# Meeting acoustic-stress corpus validation",
				"",
				`Canonical cases: ${corpus.entries.length}`,
				`Publishable real evidence: ${corpus.publishable ? "yes" : "no"}`,
				...(corpus.nonPublishableReasons.length > 0
					? ["", "Non-publishable reasons:", ...corpus.nonPublishableReasons.map((reason) => `- ${reason}`)]
					: []),
			].join("\n"),
		);
		process.stdout.write(
			`[${TAG}] VALID: ${corpus.entries.length} canonical cases\n[${TAG}] report: ${jsonPath}\n[${TAG}] report: ${mdPath}\n`,
		);
		return;
	}

	if (!corpus.publishable && !allowSynthetic) {
		fail(
			`corpus is smoke-only, not publishable real evidence: ${corpus.nonPublishableReasons.join("; ")} (use --allow-synthetic only for evaluator plumbing)`,
		);
	}
	const selectedEntries = caseId
		? corpus.entries.filter((entry) => entry.manifest.scenarioId === caseId)
		: corpus.entries;
	if (selectedEntries.length === 0) fail(`unknown --case ${caseId}`);

	const runtime = await createRealVoiceWorkbenchRuntimeFromEnv();
	let runs!: Awaited<ReturnType<typeof runVoiceWorkbenchHeadless>>;
	try {
		runs = await runVoiceWorkbenchHeadless({
			scenarios: selectedEntries.map((entry) => ({
				scenario: entry.scenario,
				corpus: entry.corpus,
			})),
			services: runtime.services,
		});
	} finally {
		await runtime.dispose();
	}
	const report = buildVoiceWorkbenchReport(runs);
	const runtimeArtifacts = await Promise.all([
		artifactDigest("fused-library", runtime.artifacts.fusedLib),
		artifactDigest(
			"asr-model",
			path.join(runtime.artifacts.bundle, "asr", "eliza-1-asr.gguf"),
		),
		artifactDigest(
			"asr-projector",
			path.join(runtime.artifacts.bundle, "asr", "eliza-1-asr-mmproj.gguf"),
		),
		artifactDigest("speaker-model", runtime.artifacts.speakerGguf),
		artifactDigest("diarizer-model", runtime.artifacts.diarizGguf),
	]);
	const selectionPublishable = !caseId && selectedEntries.length === 35;
	const evidencePublishable = corpus.publishable && selectionPublishable;
	const extraMetrics = measuredMetrics(runs, corpus);
	const markdown = [
		"# Meeting acoustic-stress real evaluation",
		"",
		`Publishable: ${evidencePublishable ? "yes" : "no"}`,
		`Corpus mode: ${corpus.publishable ? "real evidence" : "synthetic smoke"}`,
		`Cases run: ${selectedEntries.length}/35`,
		`Git revision: ${gitRevision()}`,
		"",
		"## Acoustic evidence metrics",
		"",
		`- Blank/dropout rate: ${extraMetrics.blankOutputRate ?? "N/A"}`,
		`- Hallucinated-response rate: ${extraMetrics.hallucinatedResponseRate ?? "N/A"}`,
		`- Speaker-attribution error rate: ${extraMetrics.speakerAttributionErrorRate ?? "N/A"}`,
		"",
		formatVoiceWorkbenchMarkdown(report),
	].join("\n");
	const { jsonPath, mdPath } = writeBenchReport(
		outDir,
		"meeting-acoustic-stress-real",
		{
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			gitRevision: gitRevision(),
			publishable: evidencePublishable,
			corpus: corpusEvidence(corpus),
			selection: {
				caseId,
				casesRun: selectedEntries.length,
				completeMatrix: selectionPublishable,
			},
			runtimeArtifacts,
			metrics: extraMetrics,
			report,
			rawRuns: runs,
		},
		markdown,
	);
	process.stdout.write(
		`${markdown}\n\n[${TAG}] report: ${jsonPath}\n[${TAG}] report: ${mdPath}\n`,
	);
	if (report.overall !== "pass") {
		fail(`real workbench verdict is ${report.overall}`);
	}
	if (!evidencePublishable) {
		process.stdout.write(
			`[${TAG}] PASS (non-publishable evaluator plumbing only)\n`,
		);
		return;
	}
	process.stdout.write(`[${TAG}] PASS (publishable 35-case real evidence)\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(
		`[${TAG}] FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
	process.exit(1);
});
