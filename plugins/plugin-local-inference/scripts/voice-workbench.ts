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
 * Scenario verdicts remain in the report as diagnostic context. The CLI exits
 * nonzero only when the harness cannot execute or write its artifacts; CI does
 * not turn benchmark thresholds or recorded baselines into release gates.
 */

import path from "node:path";
import { buildAndRunVoiceWorkbench, writeVoiceWorkbenchResult } from "../src/services/voice/workbench-entrypoint.ts";
import { realDecisionLogicServices } from "../src/services/voice/workbench-logic-services.ts";
import { createRealVoiceWorkbenchRuntimeFromEnv } from "../src/services/voice/workbench-real-services.ts";
import { groundTruthMockServices } from "../src/services/voice/workbench-scenarios.ts";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const real = args.includes("--real");
	const logic = args.includes("--logic");
	const outIdx = args.indexOf("--out");
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

	process.stdout.write(
		`[voice:workbench] telemetry complete (scenario verdict: ${result.report.overall})\n`,
	);
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
