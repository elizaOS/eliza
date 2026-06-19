import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type CommandResult = {
	exitCode: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	durationMs: number;
};

type FailoverRunReport = {
	runNumber: number;
	ok: boolean;
	exitCode: number;
	durationMs: number;
	blockedEvents: number;
	claudeDialogs: number;
	stallClassifiedEvents: number;
	artifact?: {
		workdir: string;
		outputFile: string;
		sentinel: string;
		byteCount: number;
		hasTrailingNewline: boolean;
	};
	error?: string;
	stdoutPath: string;
	stderrPath: string;
};

function runCommand(
	command: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		timeoutMs: number;
	},
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({
				exitCode: code ?? -1,
				signal: signal ?? null,
				stdout,
				stderr,
				timedOut,
				durationMs: Date.now() - startedAt,
			});
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({
				exitCode: -1,
				signal: null,
				stdout,
				stderr: `${stderr}${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
				timedOut,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

const repoRoot = process.cwd();
const qaRoot = path.join(repoRoot, ".tmp", "qa");
fs.mkdirSync(qaRoot, { recursive: true });
const reportDir = fs.mkdtempSync(
	path.join(qaRoot, "orchestrator-failover-review-"),
);
const runCount = Math.max(
	1,
	Number.parseInt(process.env.FAILOVER_REVIEW_RUNS ?? "2", 10) || 2,
);
const timeoutMs = Math.max(
	60_000,
	Number.parseInt(process.env.FAILOVER_REVIEW_TIMEOUT_MS ?? "", 10) ||
		15 * 60_000,
);

const runs: FailoverRunReport[] = [];

for (let index = 0; index < runCount; index += 1) {
	const runNumber = index + 1;
	const result = await runCommand(
		process.execPath,
		[
			"--import",
			"tsx",
			"eliza/packages/core/test/live/orchestrator-live-failover.ts",
		],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				ELIZA_KEEP_LIVE_ARTIFACTS: "1",
				ORCHESTRATOR_LIVE_PRIMARY:
					process.env.ORCHESTRATOR_LIVE_PRIMARY ?? "codex",
				ORCHESTRATOR_LIVE_FALLBACK:
					process.env.ORCHESTRATOR_LIVE_FALLBACK ?? "claude",
			},
			timeoutMs,
		},
	);

	const stdoutPath = path.join(reportDir, `run-${runNumber}.stdout.log`);
	const stderrPath = path.join(reportDir, `run-${runNumber}.stderr.log`);
	fs.writeFileSync(stdoutPath, result.stdout, "utf8");
	fs.writeFileSync(stderrPath, result.stderr, "utf8");

	const passMatch = result.stdout.match(
		/\[orchestrator-live-failover\] PASS (\{.+\})/,
	);
	const blockedEvents = (result.stdout.match(/"event":"blocked"/g) ?? [])
		.length;
	const claudeDialogs = (
		result.stdout.match(/Claude dialog awaiting navigation/g) ?? []
	).length;
	const stallClassifiedEvents = (result.stdout.match(/stall_classified/g) ?? [])
		.length;

	let runReport: FailoverRunReport = {
		runNumber,
		ok: false,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		blockedEvents,
		claudeDialogs,
		stallClassifiedEvents,
		stdoutPath,
		stderrPath,
	};

	if (result.exitCode === 0 && passMatch) {
		try {
			const parsed = JSON.parse(passMatch[1]) as {
				workdir: string;
				outputFile: string;
			};
			const raw = fs.readFileSync(parsed.outputFile);
			const sentinel = raw.toString("utf8");
			runReport = {
				...runReport,
				ok: true,
				artifact: {
					workdir: parsed.workdir,
					outputFile: parsed.outputFile,
					sentinel,
					byteCount: raw.byteLength,
					hasTrailingNewline: raw.at(-1) === 0x0a,
				},
			};
			if (runReport.artifact.hasTrailingNewline) {
				runReport.ok = false;
				runReport.error = "failover artifact has a trailing newline";
			}
		} catch (error) {
			runReport.error = error instanceof Error ? error.message : String(error);
		}
	} else {
		runReport.error = result.timedOut
			? "failover review timed out"
			: `run failed with exit ${result.exitCode}`;
	}

	runs.push(runReport);
}

const passedRuns = runs.filter((run) => run.ok);
const failedRuns = runs.filter((run) => !run.ok);
const report = {
	generatedAt: new Date().toISOString(),
	reportDir,
	runCount,
	passedRuns: passedRuns.length,
	failedRuns: failedRuns.length,
	runs,
};

const markdown = [
	"# Orchestrator Live Failover Review",
	"",
	`Generated: ${report.generatedAt}`,
	`Report dir: ${reportDir}`,
	`Runs: ${runCount}`,
	`Passed: ${passedRuns.length}`,
	`Failed: ${failedRuns.length}`,
	"",
	"## Runs",
	"",
	...runs.flatMap((run) => [
		`### Run ${run.runNumber}`,
		"",
		`- Status: ${run.ok ? "pass" : "fail"}`,
		`- Exit: ${run.exitCode}`,
		`- Duration ms: ${run.durationMs}`,
		`- Blocked events: ${run.blockedEvents}`,
		`- Claude dialogs: ${run.claudeDialogs}`,
		`- Stall-classified prompts: ${run.stallClassifiedEvents}`,
		...(run.artifact
			? [
					`- Output file: ${run.artifact.outputFile}`,
					`- Byte count: ${run.artifact.byteCount}`,
					`- Trailing newline: ${run.artifact.hasTrailingNewline}`,
					`- Sentinel: ${run.artifact.sentinel}`,
				]
			: []),
		...(run.error ? [`- Error: ${run.error}`] : []),
		`- Stdout log: ${run.stdoutPath}`,
		`- Stderr log: ${run.stderrPath}`,
		"",
	]),
].join("\n");

fs.writeFileSync(
	path.join(reportDir, "report.json"),
	`${JSON.stringify(report, null, 2)}\n`,
);
fs.writeFileSync(path.join(reportDir, "report.md"), `${markdown}\n`);

console.log(
	"[orchestrator-failover-review] REPORT",
	JSON.stringify({
		reportDir,
		runCount,
		passedRuns: passedRuns.length,
		failedRuns: failedRuns.length,
	}),
);

process.exit(failedRuns.length === 0 ? 0 : 1);
