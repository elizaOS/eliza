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
 *   --real             real local backend (acoustic models). No real services
 *                      adapter is provisioned here yet, so every scenario reports
 *                      `skipped` — never a false `pass` (the honesty contract).
 *   --out <dir>        output directory (default ./voice-workbench-output).
 *
 * Exit 1 on an overall `fail`; 0 on `pass` or `skipped`.
 */

import path from "node:path";
import { buildAndRunVoiceWorkbench, writeVoiceWorkbenchResult } from "../src/services/voice/workbench-entrypoint.ts";
import { realDecisionLogicServices } from "../src/services/voice/workbench-logic-services.ts";
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

	// --real: real-backend (acoustic) services are gated; when none is provisioned
	// we pass `null`, making every scenario `skipped` (never a false pass).
	// --logic: the real shipped decision logic (no acoustic models).
	// default (--mock): echoes ground truth so the runner → scorers → report path
	// runs end-to-end.
	const services = real
		? null
		: logic
			? realDecisionLogicServices()
			: groundTruthMockServices();

	const result = await buildAndRunVoiceWorkbench({ services });
	const artifacts = writeVoiceWorkbenchResult(result, outDir);

	process.stdout.write(`${result.markdown}\n\nReport: ${artifacts.reportJsonPath}\n`);

	if (result.report.overall === "fail") {
		process.stderr.write(
			"[voice:workbench] FAIL — one or more scenarios regressed\n",
		);
		process.exit(1);
	}
	process.stdout.write(
		`[voice:workbench] ${result.report.overall.toUpperCase()}\n`,
	);
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
