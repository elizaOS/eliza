/**
 * Voice Workbench entrypoint (#8785).
 *
 * One call that generates the corpus for a scenario matrix, runs them headless
 * through the (injected) voice services, and rolls the result into the single
 * JSON + Markdown benchmark report. The CLI (`voice:workbench`) and the CI lane
 * are thin shells over this:
 *   - mocked lane (always): pass `groundTruthMockServices()` → runs + passes,
 *     exercising corpus → runner → scorers → report end-to-end with no model;
 *   - real lane (where provisioned): pass a real services adapter; absent
 *     backend → `services: null` → every scenario `skipped` (never `pass`).
 *
 * Pure orchestration over the already-tested pieces, so it is unit-testable
 * without a model or a browser.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	type CorpusTtsSynthesizer,
	generateVoiceCorpus,
} from "./corpus-generator";
import type { VoiceScenario } from "./voice-scenario";
import {
	buildVoiceWorkbenchReport,
	formatVoiceWorkbenchMarkdown,
	type VoiceWorkbenchReport,
} from "./voice-workbench-report";
import {
	runVoiceWorkbenchHeadless,
	type VoiceWorkbenchServices,
} from "./workbench-headless-runner";
import { VOICE_WORKBENCH_SCENARIOS } from "./workbench-scenarios";

export interface BuildAndRunVoiceWorkbenchArgs {
	/** Scenario matrix to run (defaults to the built-in set). */
	scenarios?: ReadonlyArray<VoiceScenario>;
	/** Voice services; null → every scenario is skipped (no backend). */
	services: VoiceWorkbenchServices | null;
	/** Corpus sample rate (default 16 kHz). */
	sampleRate?: number;
	/** Real TTS for the corpus; omitted → deterministic synthetic speech. */
	synthesizer?: CorpusTtsSynthesizer;
}

export interface VoiceWorkbenchResult {
	report: VoiceWorkbenchReport;
	markdown: string;
}

/** Generate corpus → run headless → build the report + Markdown. */
export async function buildAndRunVoiceWorkbench(
	args: BuildAndRunVoiceWorkbenchArgs,
): Promise<VoiceWorkbenchResult> {
	const scenarios = args.scenarios ?? VOICE_WORKBENCH_SCENARIOS;
	const entries = [];
	for (const scenario of scenarios) {
		const corpus = await generateVoiceCorpus(scenario, {
			...(args.sampleRate !== undefined ? { sampleRate: args.sampleRate } : {}),
			...(args.synthesizer ? { synthesizer: args.synthesizer } : {}),
		});
		entries.push({ scenario, corpus });
	}
	const runs = await runVoiceWorkbenchHeadless({
		scenarios: entries,
		services: args.services,
	});
	const report = buildVoiceWorkbenchReport(runs);
	return { report, markdown: formatVoiceWorkbenchMarkdown(report) };
}

export interface VoiceWorkbenchArtifacts {
	reportJsonPath: string;
	reportMarkdownPath: string;
}

/** Persist the workbench result as `report.json` + `report.md` under `outDir`. */
export function writeVoiceWorkbenchResult(
	result: VoiceWorkbenchResult,
	outDir: string,
): VoiceWorkbenchArtifacts {
	mkdirSync(outDir, { recursive: true });
	const reportJsonPath = path.join(outDir, "report.json");
	const reportMarkdownPath = path.join(outDir, "report.md");
	writeFileSync(reportJsonPath, `${JSON.stringify(result.report, null, 2)}\n`);
	writeFileSync(reportMarkdownPath, result.markdown);
	return { reportJsonPath, reportMarkdownPath };
}
