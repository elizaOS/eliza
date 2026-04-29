import {
	type CoordinatorEvalChannel,
	runCoordinatorLiveScenarios,
} from "@elizaos/agent";

function takeFlag(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index < 0) return undefined;
	return process.argv[index + 1];
}

function takeRepeatedFlag(name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < process.argv.length; i += 1) {
		if (process.argv[i] !== name) continue;
		const next = process.argv[i + 1];
		if (next && !next.startsWith("--")) {
			values.push(next);
		}
	}
	return values;
}

function takeIntegerFlag(name: string): number | undefined {
	const raw = takeFlag(name);
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid integer value for ${name}: ${raw}`);
	}
	return value;
}

try {
	const profile = takeFlag("--profile") as
		| "smoke"
		| "core"
		| "full"
		| undefined;
	const outputRoot = takeFlag("--output");
	const batchId = takeFlag("--batch-id");
	const scenarioTimeoutMs = takeIntegerFlag("--scenario-timeout-ms");
	const scenarioIds = [
		...takeRepeatedFlag("--scenario"),
		...(takeFlag("--scenarios")
			?.split(",")
			.map((value) => value.trim())
			.filter(Boolean) ?? []),
	];
	const channelValues = [
		...takeRepeatedFlag("--channel"),
		...(takeFlag("--channels")
			?.split(",")
			.map((value) => value.trim())
			.filter(Boolean) ?? []),
	] as CoordinatorEvalChannel[];

	const result = await runCoordinatorLiveScenarios({
		baseUrl: process.env.ELIZA_BASE_URL,
		batchId,
		profile,
		outputRoot,
		...(scenarioTimeoutMs ? { scenarioTimeoutMs } : {}),
		...(scenarioIds.length > 0 ? { scenarioIds } : {}),
		...(channelValues.length > 0 ? { channels: channelValues } : {}),
	});

	const passed = result.runs.filter((run) => run.passed).length;
	const failed = result.runs.length - passed;
	const coverageGaps = result.skippedChannels.length;
	console.log(
		JSON.stringify(
			{
				batchId: result.batchId,
				baseUrl: result.baseUrl,
				outputRoot: result.outputRoot,
				requestedChannels: result.requestedChannels,
				usableChannels: result.usableChannels,
				skippedChannels: result.skippedChannels,
				channelReadiness: result.preflight.channelReadiness,
				runnableFrameworks: result.runnableFrameworks,
				preflightFailures: result.preflightFailures,
				preflightWarnings: result.preflightWarnings,
				scenarioTimeoutMs: scenarioTimeoutMs ?? null,
				runCount: result.runs.length,
				passed,
				failed,
				coverageGaps,
			},
			null,
			2,
		),
	);

	process.exit(
		failed === 0 &&
			result.preflightHardBlockers.length === 0 &&
			coverageGaps === 0
			? 0
			: 1,
	);
} catch (error) {
	console.error("[coordinator-scenario-live] FAIL");
	console.error(error);
	process.exit(1);
}
