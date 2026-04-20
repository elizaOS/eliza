/**
 * Atropos training backend.
 *
 * Atropos is the open-source RL/SFT training stack used elsewhere in the
 * elizaOS ecosystem. There is no in-repo TypeScript SDK, so this backend
 * stages the dataset to the location atropos expects and prints next steps.
 *
 * Activation:
 *   bun run train -- --backend atropos --dataset <path> [--task <task>]
 *
 * Environment:
 *   ATROPOS_DATA_DIR  Where atropos picks up datasets. Defaults to
 *                     `<repo>/.milady/training/atropos`.
 *   ATROPOS_BIN       Optional path to a local atropos CLI binary.
 */

import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveStateDir } from "@elizaos/core";

export interface AtroposBackendOptions {
	datasetPath: string;
	task?: string;
	dataDir?: string;
	bin?: string;
}

export interface AtroposBackendResult {
	stagedPath: string;
	bin: string | null;
	invoked: boolean;
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
}

function resolveDataDir(override?: string): string {
	if (override) return override;
	const fromEnv = process.env.ATROPOS_DATA_DIR?.trim();
	if (fromEnv) return fromEnv;
	return join(resolveStateDir(), "training", "atropos");
}

export async function runAtroposBackend(
	options: AtroposBackendOptions,
): Promise<AtroposBackendResult> {
	if (!existsSync(options.datasetPath)) {
		throw new Error(`Dataset not found at ${options.datasetPath}`);
	}
	const dataDir = resolveDataDir(options.dataDir);
	const taskDir = options.task ? join(dataDir, options.task) : dataDir;
	mkdirSync(taskDir, { recursive: true });
	const stagedPath = join(taskDir, basename(options.datasetPath));
	copyFileSync(resolve(options.datasetPath), stagedPath);
	const bin = options.bin ?? process.env.ATROPOS_BIN ?? null;

	if (!bin) {
		console.log("[atropos] Dataset staged to:", stagedPath);
		console.log(
			"[atropos] Atropos CLI not configured. Set ATROPOS_BIN or pass --bin to invoke it directly.",
		);
		console.log("[atropos] Next steps:");
		console.log(`  1. Install atropos and point ATROPOS_BIN at the binary.`);
		console.log(`  2. Re-run with --backend atropos to launch training.`);
		return { stagedPath, bin: null, invoked: false };
	}

	const spawnArgs = ["--dataset", stagedPath];
	if (options.task) spawnArgs.push("--task", options.task);
	const result = spawnSync(bin, spawnArgs, {
		stdio: "pipe",
		encoding: "utf-8",
	});
	return {
		stagedPath,
		bin,
		invoked: true,
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.status,
	};
}
