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
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType, resolveStateDir } from "@elizaos/core";
import {
	createSelfApiRequestHeaders,
	resolveDesktopApiPort,
} from "@elizaos/shared";
import { createViewsRequestHeaders } from "../actions/views-request-auth.js";
import { getAppControlApiBase } from "../loopback-api.js";

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

export interface RegisteredAppItem {
	slug: string;
	canonicalName: string;
}

/**
 * Register a freshly built app into the running runtime via the loopback agent
 * API so a subsequent `launch <name>` resolves. The
 * `/api/apps/load-from-directory` route scans a *parent* directory for app
 * subdirs and registers each valid one through the AppRegistryService
 * (`trust: "external"`), so we pass the workdir's parent, not the workdir
 * itself. That register is idempotent by slug and the worker host returns the
 * existing worker for an already-registered sibling, so re-scanning the shared
 * apps dir does not churn unrelated apps. Returns the registered items so
 * callers can confirm the app is actually launchable instead of promising a
 * `launch` that would fail with "No installed app matches". Used by the
 * verification launch check (register-before-launch) and by the room bridge's
 * pass message.
 */
export async function loadAppFromWorkdir(
	workdir: string,
): Promise<
	{ ok: true; items: RegisteredAppItem[] } | { ok: false; error: string }
> {
	const directory = path.dirname(workdir);
	try {
		const resp = await fetch(
			`${getAppControlApiBase()}/api/apps/load-from-directory`,
			{
				method: "POST",
				headers: createViewsRequestHeaders(),
				body: JSON.stringify({ directory }),
				signal: AbortSignal.timeout(30_000),
			},
		);
		const body = (await resp.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		if (resp.ok && body.ok === true) {
			const items = Array.isArray(body.items)
				? body.items.filter(
						(item): item is RegisteredAppItem =>
							typeof item === "object" &&
							item !== null &&
							typeof (item as RegisteredAppItem).slug === "string" &&
							typeof (item as RegisteredAppItem).canonicalName === "string",
					)
				: [];
			return { ok: true, items };
		}
		return {
			ok: false,
			error:
				typeof body.error === "string"
					? body.error
					: `register returned HTTP ${resp.status}`,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Removes ANSI escape sequences (colors, cursor moves) so the line-anchored
 * parsers below see plain text. Vitest's color lib (tinyrainbow) enables color
 * on the PRESENCE of `FORCE_COLOR`/`CI` in the env regardless of value, so
 * captured output can carry escapes even from a non-TTY pipe.
 */
export function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC is the target
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
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

export type VitestCounts = {
	passed: number;
	failed: number;
};

/**
 * Parse the aggregate `Tests` line emitted by Vitest. Counts are located
 * independently because reporters may place passed and failed totals in
 * either order. A missing or unrecognized summary remains distinct from a
 * valid zero count so callers never manufacture proof from unrelated output.
 */
export function parseVitestCounts(output: string): VitestCounts | null {
	const testsLine = /^\s*Tests\s+(.+)$/m.exec(output)?.[1];
	if (!testsLine) return null;

	const failedMatch = /\b(\d+)\s+failed\b/.exec(testsLine);
	const passedMatch = /\b(\d+)\s+passed\b/.exec(testsLine);
	if (!failedMatch && !passedMatch) return null;

	return {
		passed: passedMatch ? Number.parseInt(passedMatch[1] ?? "0", 10) : 0,
		failed: failedMatch ? Number.parseInt(failedMatch[1] ?? "0", 10) : 0,
	};
}

export type VitestSummary = VitestCounts & {
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

	const counts = parseVitestCounts(output);
	if (counts) {
		summary.failed = counts.failed;
		summary.passed = counts.passed;
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
 * Resolve the root state directory honoring `ELIZA_STATE_DIR` >
 * `ELIZA_STATE_DIR` > `~/.${ELIZA_NAMESPACE ?? "eliza"}` precedence.
 */
export function getStateDir(): string {
	return resolveStateDir();
}

/**
 * Ensure `<stateDir>/app-verifications/<runId>/` exists and return the path.
 */
export async function ensureVerificationDir(runId: string): Promise<string> {
	const dir = path.join(getStateDir(), "app-verifications", runId);
	await mkdir(dir, { recursive: true });
	return dir;
}

function resolveLoopbackApiBase(): string {
	return `http://127.0.0.1:${resolveDesktopApiPort()}`;
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
	const url = `${resolveLoopbackApiBase()}/api/dev/cursor-screenshot`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: createSelfApiRequestHeaders(
				token ? { ELIZA_API_TOKEN: token } : process.env,
			),
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
		const runModel = runtime.useModel.bind(runtime);
		const raw = (await runModel(ModelType.IMAGE_DESCRIPTION, {
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
