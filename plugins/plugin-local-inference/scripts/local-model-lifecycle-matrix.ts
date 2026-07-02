#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import {
	buildLocalModelLifecycleMatrix,
	collectLocalLifecycleFileChecks,
	formatLocalModelLifecycleMatrixMarkdown,
	listLocalModelLifecycleArtifacts,
	type LifecycleBundleRemoteCheck,
	type LifecycleRemoteCheck,
} from "../src/services/local-model-lifecycle-matrix";
import {
	buildHuggingFaceResolveUrlForPath,
	MODEL_CATALOG,
} from "../src/services/catalog";
import { probeHardware } from "../src/services/hardware";
import { readEffectiveAssignments } from "../src/services/assignments";
import { listInstalledModels } from "../src/services/registry";

interface CliOptions {
	format: "json" | "markdown";
	out: string | null;
	checkRemote: boolean;
	requireComplete: boolean;
	timeoutMs: number;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		format: "markdown",
		out: null,
		checkRemote: false,
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

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function checkUrl(
	url: string,
	timeoutMs: number,
): Promise<LifecycleRemoteCheck> {
	const checkedAt = new Date().toISOString();
	try {
		let response = await fetchWithTimeout(
			url,
			{ method: "HEAD", redirect: "follow" },
			timeoutMs,
		);
		if (response.status === 405 || response.status === 403) {
			response = await fetchWithTimeout(
				url,
				{
					method: "GET",
					redirect: "follow",
					headers: { Range: "bytes=0-0" },
				},
				timeoutMs,
			);
		}
		const status = response.ok || response.status === 206 ? "pass" : "fail";
		return {
			status,
			detail: `HTTP ${response.status} ${response.statusText}`.trim(),
			checkedAt,
			httpStatus: response.status,
		};
	} catch (error) {
		return {
			status: "warn",
			detail: `remote check failed: ${error instanceof Error ? error.message : String(error)}`,
			checkedAt,
		};
	}
}

async function collectRemoteChecks(
	timeoutMs: number,
): Promise<Record<string, LifecycleRemoteCheck>> {
	const checks: Record<string, LifecycleRemoteCheck> = {};
	for (const artifact of listLocalModelLifecycleArtifacts(MODEL_CATALOG)) {
		if (!artifact.downloadUrl) continue;
		checks[artifact.key] = await checkUrl(artifact.downloadUrl, timeoutMs);
	}
	return checks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function flattenManifestFilePaths(manifest: unknown): string[] {
	if (!isRecord(manifest) || !isRecord(manifest.files)) return [];
	const paths = new Set<string>();
	for (const value of Object.values(manifest.files)) {
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (isRecord(entry) && typeof entry.path === "string") {
					paths.add(entry.path);
				}
			}
			continue;
		}
		if (isRecord(value) && typeof value.path === "string") {
			paths.add(value.path);
		}
	}
	return [...paths].sort();
}

async function collectBundleChecks(
	timeoutMs: number,
): Promise<Record<string, LifecycleBundleRemoteCheck>> {
	const checks: Record<string, LifecycleBundleRemoteCheck> = {};
	for (const model of MODEL_CATALOG) {
		if (!model.bundleManifestFile) continue;
		const manifestUrl = buildHuggingFaceResolveUrlForPath(
			model,
			model.bundleManifestFile,
		);
		const manifestCheck = await checkUrl(manifestUrl, timeoutMs);
		if (manifestCheck.status !== "pass") {
			checks[model.id] = {
				status: manifestCheck.status,
				detail: `manifest unavailable: ${manifestCheck.detail}`,
				checkedAt: manifestCheck.checkedAt,
				manifestUrl,
				fileCount: 0,
				failingFiles: [],
			};
			continue;
		}

		let manifest: unknown;
		try {
			const response = await fetchWithTimeout(
				manifestUrl,
				{ method: "GET", redirect: "follow" },
				timeoutMs,
			);
			manifest = await response.json();
		} catch (error) {
			checks[model.id] = {
				status: "warn",
				detail: `manifest JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
				checkedAt: new Date().toISOString(),
				manifestUrl,
				fileCount: 0,
				failingFiles: [],
			};
			continue;
		}

		const filePaths = flattenManifestFilePaths(manifest);
		const failingFiles: LifecycleBundleRemoteCheck["failingFiles"] = [];
		for (const filePath of filePaths) {
			const fileUrl = buildHuggingFaceResolveUrlForPath(model, filePath);
			const fileCheck = await checkUrl(fileUrl, timeoutMs);
			if (fileCheck.status !== "pass") {
				failingFiles.push({
					path: filePath,
					status: fileCheck.status,
					detail: fileCheck.detail,
					httpStatus: fileCheck.httpStatus,
				});
			}
		}
		checks[model.id] = {
			status: failingFiles.length > 0 ? "fail" : "pass",
			detail:
				failingFiles.length > 0
					? `${failingFiles.length}/${filePaths.length} manifest file(s) failed remote checks`
					: `${filePaths.length} manifest file(s) passed remote checks`,
			checkedAt: new Date().toISOString(),
			manifestUrl,
			fileCount: filePaths.length,
			failingFiles,
		};
	}
	return checks;
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
	const [localFileChecks, remoteChecks, bundleChecks] = await Promise.all([
		collectLocalLifecycleFileChecks(artifacts, installed),
		options.checkRemote ? collectRemoteChecks(options.timeoutMs) : {},
		options.checkRemote ? collectBundleChecks(options.timeoutMs) : {},
	]);
	const matrix = buildLocalModelLifecycleMatrix({
		catalog: MODEL_CATALOG,
		installed,
		assignments,
		hardware,
		remoteChecks,
		bundleChecks,
		localFileChecks,
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
