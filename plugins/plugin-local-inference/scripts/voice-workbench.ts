#!/usr/bin/env bun
/**
 * Runs the voice scenario matrix and writes scored JSON and Markdown reports.
 * The default decision-logic lane uses the shipped gates without acoustic models.
 * --real requires provisioned speech and inference backends; --out selects the
 * report directory and --baseline compares metrics against a prior report.
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

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const real = args.includes("--real");
	if (args.includes("--mock")) {
		throw new Error("The mock benchmark mode was removed. Use --logic or --real.");
	}
	if (real && args.includes("--logic")) {
		throw new Error("Choose either --logic or --real.");
	}
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

	const realRuntime = real
		? await createRealVoiceWorkbenchRuntimeFromEnv()
		: null;
	const services = realRuntime
		? realRuntime.services
		: realDecisionLogicServices();

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
	// error-policy:J1 The CLI reports the failure and exits unsuccessfully.
	process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
