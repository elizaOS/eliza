#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { MODEL_CATALOG } from "../src/services/catalog";
import { collectLifecycleLoadRunChecks } from "../src/services/lifecycle-loadrun";
import {
	collectLifecycleBundleChecks,
	collectLifecycleRemoteChecks,
} from "../src/services/lifecycle-remote-checks";
import {
	buildLocalModelLifecycleMatrix,
	collectLocalLifecycleFileChecks,
	formatLocalModelLifecycleMatrixMarkdown,
	listLocalModelLifecycleArtifacts,
} from "../src/services/local-model-lifecycle-matrix";
import { probeHardware } from "../src/services/hardware";
import { readEffectiveAssignments } from "../src/services/assignments";
import { listInstalledModels } from "../src/services/registry";

interface CliOptions {
	format: "json" | "markdown";
	out: string | null;
	checkRemote: boolean;
	loadRun: boolean;
	loadRunModelIds: string[];
	requireComplete: boolean;
	timeoutMs: number;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		format: "markdown",
		out: null,
		checkRemote: false,
		loadRun: false,
		loadRunModelIds: [],
		requireComplete: false,
		timeoutMs: 15_000,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--format") {
			const value = argv[++i];
			if (value !== "json" && value !== "markdown") {
				throw new Error("--format must be json or markdown");
			}
			options.format = value;
			continue;
		}
		if (arg === "--out") {
			options.out = argv[++i] ?? null;
			if (!options.out) throw new Error("--out requires a path");
			continue;
		}
		if (arg === "--check-remote") {
			options.checkRemote = true;
			continue;
		}
		if (arg === "--load-run") {
			options.loadRun = true;
			continue;
		}
		if (arg === "--load-run-model") {
			const value = argv[++i];
			if (!value) throw new Error("--load-run-model requires a model id");
			options.loadRun = true;
			options.loadRunModelIds.push(value);
			continue;
		}
		if (arg === "--require-complete") {
			options.requireComplete = true;
			continue;
		}
		if (arg === "--timeout-ms") {
			const value = Number(argv[++i]);
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error("--timeout-ms requires a positive number");
			}
			options.timeoutMs = value;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(
				[
					"Usage: bun scripts/local-model-lifecycle-matrix.ts [options]",
					"",
					"Options:",
					"  --format json|markdown   Output format (default: markdown)",
					"  --out <path>             Write output to a file",
					"  --check-remote           Probe catalog download URLs with HEAD/range requests",
					"  --load-run               Load each installed model through the real FFI engine and record tok/s",
					"  --load-run-model <id>    Restrict --load-run to a model id (repeatable; implies --load-run)",
					"  --timeout-ms <ms>        Per-URL remote check timeout (default: 15000)",
					"  --require-complete       Exit non-zero when any row fails or has unknown evidence",
				].join("\n"),
			);
			process.exit(0);
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return options;
}

async function writeOutput(target: string | null, content: string): Promise<void> {
	if (!target) {
		process.stdout.write(content);
		return;
	}
	await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
	await fs.writeFile(target, content, "utf8");
	process.stdout.write(`wrote ${target}\n`);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const [hardware, installed, assignments] = await Promise.all([
		probeHardware(),
		listInstalledModels(),
		readEffectiveAssignments(),
	]);
	const artifacts = listLocalModelLifecycleArtifacts(MODEL_CATALOG);
	const remoteOptions = { timeoutMs: options.timeoutMs };
	const [localFileChecks, remoteChecks, bundleChecks] = await Promise.all([
		collectLocalLifecycleFileChecks(artifacts, installed),
		options.checkRemote ? collectLifecycleRemoteChecks(remoteOptions) : {},
		options.checkRemote ? collectLifecycleBundleChecks(remoteOptions) : {},
	]);
	// Load-run is sequential and after the cheap checks on purpose: it loads
	// real weights through the FFI engine one model at a time.
	const loadRunChecks = options.loadRun
		? await collectLifecycleLoadRunChecks({
				...(options.loadRunModelIds.length > 0
					? { modelIds: options.loadRunModelIds }
					: {}),
				hardware,
			})
		: {};
	const matrix = buildLocalModelLifecycleMatrix({
		catalog: MODEL_CATALOG,
		installed,
		assignments,
		hardware,
		remoteChecks,
		bundleChecks,
		localFileChecks,
		loadRunChecks,
	});
	const content =
		options.format === "json"
			? `${JSON.stringify(matrix, null, 2)}\n`
			: formatLocalModelLifecycleMatrixMarkdown(matrix);
	await writeOutput(options.out, content);

	if (
		options.requireComplete &&
		(matrix.summary.failingRows > 0 || matrix.summary.unknownRows > 0)
	) {
		process.stderr.write(
			`lifecycle matrix incomplete: ${matrix.summary.failingRows} failing rows, ${matrix.summary.unknownRows} rows with unknown evidence\n`,
		);
		process.exit(1);
	}
}

main().catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? error.stack || error.message : String(error)}\n`,
	);
	process.exit(1);
});
