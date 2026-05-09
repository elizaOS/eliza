/**
 * @module plugin-app-control/services/verification-helpers
 * @description Standalone utilities consumed by `AppVerificationService`.
 *
 * These are split from the main service so they can be unit-tested without
 * spinning up a runtime, and so the parsing helpers can be reused by other
 * verification surfaces (e.g. an action that reports a single tsc result).
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";

export type Diagnostic = {
	file: string;
	line?: number;
	column?: number;
	message: string;
	severity: "error" | "warning";
};

export type PackageManager = "bun" | "npm";

/**
 * Detect the package manager for a workdir by looking at lockfiles.
 * Falls back to `npm` when no lockfile is present.
 */
export function detectPackageManager(workdir: string): PackageManager {
	let current = path.resolve(workdir);
	while (true) {
		if (existsSync(path.join(current, "bun.lock"))) return "bun";
		if (existsSync(path.join(current, "bun.lockb"))) return "bun";
		if (existsSync(path.join(current, "package-lock.json"))) return "npm";
		if (existsSync(path.join(current, "yarn.lock"))) return "npm"; // best fallback

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return "npm";
}

/**
 * UTF-8 safe truncation. Appends a `...truncated N chars` suffix when the
 * input exceeds `max`.
 */
export function truncate(text: string, max: number): string {
	if (typeof text !== "string") return "";
	// Use Array.from to count Unicode code points so we don't slice a
	// surrogate pair in half.
	const codePoints = Array.from(text);
	if (codePoints.length <= max) return text;
	const head = codePoints.slice(0, max).join("");
	const dropped = codePoints.length - max;
	return `${head}\n...truncated ${dropped} chars`;
}

/**
 * Parse `tsc --noEmit` style output. Both stdout and stderr can carry the
 * diagnostics depending on tsc version, so we accept a single string.
 *
 * Format: `path/to/file.ts(line,col): error TS1234: message`
 */
export function parseTscOutput(output: string): Diagnostic[] {
	if (!output) return [];
	const diagnostics: Diagnostic[] = [];
	const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm;
	let match: RegExpExecArray | null;
	match = re.exec(output);
	while (match !== null) {
		const [, file, lineStr, colStr, severity, message] = match;
		if (file && lineStr && colStr && severity && message) {
			diagnostics.push({
				file,
				line: Number.parseInt(lineStr, 10),
				column: Number.parseInt(colStr, 10),
				message: message.trim(),
				severity: severity === "warning" ? "warning" : "error",
			});
		}
		match = re.exec(output);
	}
	return diagnostics;
}

/**
 * Parse eslint stylish output (the default for `eslint .`). Bails to `[]`
 * when the format does not look like stylish output so we never crash on
 * an unexpected formatter.
 *
 * Stylish format:
 * ```
 * /abs/path/file.ts
 *   12:5  error  Something is wrong  rule-name
 * ```
 */
export function parseEslintOutput(output: string): Diagnostic[] {
	if (!output) return [];
	const diagnostics: Diagnostic[] = [];
	const lines = output.split(/\r?\n/);
	let currentFile: string | null = null;
	const issueRe =
		/^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s+([\w@/-]+))?\s*$/;
	for (const line of lines) {
		if (!line.trim()) {
			currentFile = null;
			continue;
		}
		// Absolute or repo-relative path on its own line.
		if (
			!line.startsWith(" ") &&
			(line.startsWith("/") ||
				/^[A-Za-z]:[\\/]/.test(line) ||
				line.includes("/")) &&
			!issueRe.test(line)
		) {
			currentFile = line.trim();
			continue;
		}
		const match = issueRe.exec(line);
		if (!match || !currentFile) continue;
		const [, lineStr, colStr, severity, message] = match;
		if (!lineStr || !colStr || !severity || !message) continue;
		diagnostics.push({
			file: currentFile,
			line: Number.parseInt(lineStr, 10),
			column: Number.parseInt(colStr, 10),
			message: message.trim(),
			severity: severity === "warning" ? "warning" : "error",
		});
	}
	return diagnostics;
}

export type VitestSummary = {
	passed: number;
	failed: number;
	failures: string[];
};

/**
 * Parse a vitest summary block. Vitest writes a `Test Files`/`Tests` block
 * near the end of stdout that we use to compute pass/fail counts. Failures
 * are captured by name from the `× test name` markers vitest emits per
 * failing test.
 *
 * Returns zeroed counts on unrecognized output rather than throwing.
 */
export function parseVitestOutput(output: string): VitestSummary {
	const summary: VitestSummary = { passed: 0, failed: 0, failures: [] };
	if (!output) return summary;

	const testsLine =
		/^\s*Tests\s+(?:(\d+)\s+failed)?[\s|]*?(?:(\d+)\s+passed)?/m;
	const match = testsLine.exec(output);
	if (match) {
		summary.failed = match[1] ? Number.parseInt(match[1], 10) : 0;
		summary.passed = match[2] ? Number.parseInt(match[2], 10) : 0;
	}

	// Vitest prints `× <test name>` lines for failing tests in default reporter.
	const failureRe = /^\s*[×✗xX]\s+(.+?)(?:\s+\d+ms)?$/gm;
	let failureMatch: RegExpExecArray | null;
	const seen = new Set<string>();
	failureMatch = failureRe.exec(output);
	while (failureMatch !== null) {
		const name = failureMatch[1]?.trim();
		if (name && !seen.has(name)) {
			seen.add(name);
			summary.failures.push(name);
		}
		failureMatch = failureRe.exec(output);
	}
	if (summary.failed === 0 && summary.failures.length > 0) {
		summary.failed = summary.failures.length;
	}
	return summary;
}

/**
 * Resolve the root state directory honoring Eliza/Eliza env overrides.
 */
export function getStateDir(): string {
	const fromEnv = process.env.ELIZA_STATE_DIR?.trim();
	return fromEnv && fromEnv.length > 0
		? fromEnv
		: path.join(homedir(), ".eliza");
}

/**
 * Ensure `~/.eliza/app-verifications/<runId>/` exists and return the path.
 */
export async function ensureVerificationDir(runId: string): Promise<string> {
	const dir = path.join(getStateDir(), "app-verifications", runId);
	await mkdir(dir, { recursive: true });
	return dir;
}

function resolveLoopbackApiBase(): string {
	const port =
		process.env.ELIZA_API_PORT?.trim() ||
		process.env.ELIZA_PORT?.trim() ||
		"31337";
	return `http://127.0.0.1:${port}`;
}

function resolveDevApiToken(): string | undefined {
	return (
		process.env.ELIZA_API_TOKEN?.trim() ||
		process.env.ELIZA_API_AUTH_TOKEN?.trim() ||
		undefined
	);
}

/**
 * Capture a desktop screenshot via the dev `/api/dev/cursor-screenshot`
 * endpoint. Returns `null` when the endpoint is missing or unreachable —
 * verification should treat that as "no screenshot available" rather than
 * a hard failure.
 */
export async function captureScreenshotViaDevApi(
	token?: string,
): Promise<Buffer | null> {
	const bearer = token ?? resolveDevApiToken();
	const url = `${resolveLoopbackApiBase()}/api/dev/cursor-screenshot`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) return null;
	return Buffer.from(bytes);
}

type ImageDescriptionResultLike =
	| string
	| { description?: unknown }
	| null
	| undefined;

function extractImageDescription(
	raw: ImageDescriptionResultLike,
): string | undefined {
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (raw && typeof raw === "object") {
		const description = (raw as { description?: unknown }).description;
		if (typeof description === "string" && description.trim().length > 0) {
			return description.trim();
		}
	}
	return undefined;
}

/**
 * Ask the runtime's vision model to describe a screenshot. Returns
 * `undefined` on any failure — callers should treat the description as
 * advisory metadata, never gating verification on its presence.
 */
export async function describeScreenshotWithVision(
	runtime: IAgentRuntime,
	imagePath: string,
	prompt?: string,
): Promise<string | undefined> {
	try {
		const fs = await import("node:fs/promises");
		const bytes = await fs.readFile(imagePath);
		const dataUri = `data:image/png;base64,${bytes.toString("base64")}`;
		const raw = (await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
			imageUrl: dataUri,
			prompt:
				prompt ??
				[
					"task: describe_app_screenshot",
					"focus: visible UI, error banners, obvious failure states",
					"length: brief",
					"output: plain description",
				].join("\n"),
		})) as ImageDescriptionResultLike;
		return extractImageDescription(raw);
	} catch {
		return undefined;
	}
}
