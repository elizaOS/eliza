#!/usr/bin/env bun
/**
 * Generate the labeled Voice Workbench corpus (#8785) to disk: for every
 * built-in scenario, write `audio.wav` (the synthesized + acoustically degraded
 * stream) and `ground-truth.json` (per-turn labels: speaker, transcript, respond
 * decision, entity, applied environment) under a versioned corpus directory.
 *
 *   bun run scripts/generate-voice-corpus.ts [--out <dir>] [--manifest]
 *
 * The synthetic (formant) path needs no models — it produces a reproducible,
 * audible corpus a reviewer can LISTEN to (you can hear the noise/reverb/
 * far-field/low-quality degradation on the robustness scenarios) and that the
 * real-model lane scores WER/DER against. A real-TTS corpus is produced by
 * injecting a `CorpusTtsSynthesizer` (gated; not wired here).
 *
 * Outputs are generated artifacts — write them to a gitignored dir, don't commit.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	generateVoiceCorpus,
	writeVoiceCorpus,
} from "../src/services/voice/corpus-generator.ts";
import { VOICE_WORKBENCH_SCENARIOS } from "../src/services/voice/workbench-scenarios.ts";

interface CorpusManifestEntry {
	scenarioId: string;
	classes: string[];
	durationSec: number;
	turns: number;
	degraded: boolean;
	dir: string;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const outIdx = args.indexOf("--out");
	const outDir =
		outIdx >= 0 && args[outIdx + 1]
			? path.resolve(args[outIdx + 1])
			: path.resolve("voice-corpus-output");
	mkdirSync(outDir, { recursive: true });

	const manifest: CorpusManifestEntry[] = [];
	for (const scenario of VOICE_WORKBENCH_SCENARIOS) {
		const corpus = await generateVoiceCorpus(scenario);
		const dir = path.join(outDir, scenario.id);
		writeVoiceCorpus(corpus, dir);
		const degraded = corpus.groundTruth.turns.some((t) => t.environment);
		manifest.push({
			scenarioId: scenario.id,
			classes: scenario.classes,
			durationSec: Number(corpus.groundTruth.durationSec.toFixed(3)),
			turns: corpus.groundTruth.turns.length,
			degraded,
			dir: path.relative(outDir, dir),
		});
		process.stdout.write(
			`  ${scenario.id.padEnd(28)} ${corpus.groundTruth.durationSec.toFixed(2)}s  ${corpus.groundTruth.turns.length} turns${degraded ? "  [degraded]" : ""}\n`,
		);
	}

	const manifestPath = path.join(outDir, "manifest.json");
	writeFileSync(
		manifestPath,
		`${JSON.stringify({ schemaVersion: 1, scenarios: manifest }, null, 2)}\n`,
	);
	process.stdout.write(
		`\n[corpus] wrote ${manifest.length} scenarios to ${outDir}\n[corpus] manifest: ${manifestPath}\n`,
	);
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
