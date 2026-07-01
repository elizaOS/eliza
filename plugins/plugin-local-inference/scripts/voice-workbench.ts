#!/usr/bin/env bun
/**
 * `voice:workbench` CLI (#8785). Runs the Voice Workbench scenario matrix and
 * writes one JSON + Markdown benchmark report.
 *
 * Modes:
 *   --mock  (default)  ground-truth mock services → runs + passes; the CI
 *                      plumbing lane (no model, no network).
 *   --logic            real-decision-logic services → runs the SHIPPED EOT /
 *                      respond / echo / bystander / wake-word gate + name
 *                      extraction over the corpus (no acoustic models). CI-
 *                      runnable; catches a regression in the decision logic.
 *   --real             provisioned real backend: ElevenLabs-generated human
 *                      speech + fused local TTS/ASR + WeSpeaker + pyannote.
 *                      Missing real deps are a hard failure, not a skipped pass.
 *   --out <dir>        output directory (default ./voice-workbench-output).
 *   --baseline <path>  golden report JSON to compare metrics against; exit 1 if
 *                      any metric regressed past tolerance (regression gate).
 *
 * Exit 1 on an overall `fail` OR a metric regression vs the baseline; 0 on
 * `pass` or `skipped`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
	regressionsAgainstBaseline,
	type VoiceWorkbenchReport,
} from "../src/services/voice/voice-workbench-report.ts";
import { buildAndRunVoiceWorkbench, writeVoiceWorkbenchResult } from "../src/services/voice/workbench-entrypoint.ts";
import { realDecisionLogicServices } from "../src/services/voice/workbench-logic-services.ts";
import { createRealVoiceWorkbenchRuntimeFromEnv } from "../src/services/voice/workbench-real-services.ts";
import { groundTruthMockServices } from "../src/services/voice/workbench-scenarios.ts";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const real = args.includes("--real");
	const logic = args.includes("--logic");
	const outIdx = args.indexOf("--out");
	const baselineIdx = args.indexOf("--baseline");
	const baselinePath =
		baselineIdx >= 0 && args[baselineIdx + 1]
			? path.resolve(args[baselineIdx + 1])
			: null;
	const outDir =
		outIdx >= 0 && args[outIdx + 1]
			? path.resolve(args[outIdx + 1])
			: path.resolve("voice-workbench-output");

	// --real: real-backend (acoustic) services are gated and fail fast when not
	// provisioned. No all-skipped success: #9147 needs numbers, not skip evidence.
	// --logic: the real shipped decision logic (no acoustic models).
	// default (--mock): echoes ground truth so the runner → scorers → report path
	// runs end-to-end.
	const realRuntime = real
		? await createRealVoiceWorkbenchRuntimeFromEnv()
		: null;
	const services = realRuntime
		? realRuntime.services
		: logic
			? realDecisionLogicServices()
			: groundTruthMockServices();

	let result!: Awaited<ReturnType<typeof buildAndRunVoiceWorkbench>>;
	try {
		result = await buildAndRunVoiceWorkbench({
			services,
			...(realRuntime ? { synthesizer: realRuntime.synthesizer } : {}),
		});
	} finally {
		await realRuntime?.dispose();
	}
	const artifacts = writeVoiceWorkbenchResult(result, outDir);

	process.stdout.write(`${result.markdown}\n\nReport: ${artifacts.reportJsonPath}\n`);

	if (result.report.overall === "fail") {
		process.stderr.write(
			"[voice:workbench] FAIL — one or more scenarios regressed\n",
		);
		process.exit(1);
	}

	// Regression gate: compare metrics against a committed golden baseline.
	if (baselinePath) {
		const baseline = JSON.parse(
			readFileSync(baselinePath, "utf8"),
		) as VoiceWorkbenchReport;
		const regressions = regressionsAgainstBaseline(result.report, baseline);
		if (regressions.length > 0) {
			process.stderr.write(
				`[voice:workbench] REGRESSION vs baseline (${baselinePath}):\n`,
			);
			for (const r of regressions) {
				process.stderr.write(
					`  ${r.metric}: baseline ${r.baseline} → current ${r.current} (Δ ${r.delta})\n`,
				);
			}
			process.exit(1);
		}
		process.stdout.write(
			`[voice:workbench] no regressions vs baseline (${path.basename(baselinePath)})\n`,
		);
	}

	process.stdout.write(
		`[voice:workbench] ${result.report.overall.toUpperCase()}\n`,
	);
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
