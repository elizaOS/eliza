/**
 * @module plugin-app-control/services/app-verification
 * @description AppVerificationService — runs a structured verification
 * pipeline (typecheck / lint / test / build / launch / browser) against
 * an app workdir and returns a result the orchestrator can use to decide
 * pass / retry / escalate.
 *
 * Other agents wire this into the parent's APP_CREATE / PLUGIN_CREATE flow:
 * when a child coding agent claims completion, the parent calls
 * `verifyApp()` and either accepts the result, retries with the
 * `retryablePromptForChild` message, or escalates to the user.
 */

import { type ExecFileOptions, execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import {
	type AppControlClient,
	createAppControlClient,
} from "../client/api.js";
import type { AppRunSummary } from "../types.js";
import {
	captureScreenshotViaDevApi,
	type Diagnostic,
	describeScreenshotWithVision,
	detectPackageManager,
	ensureVerificationDir,
	type PackageManager,
	parseEslintOutput,
	parseTscOutput,
	parseVitestOutput,
	truncate,
} from "./verification-helpers.js";

const execFileAsync = promisify(execFile);

const OUTPUT_INLINE_LIMIT = 4 * 1024;
const RETRY_PROMPT_LIMIT = 2 * 1024;
const EXEC_BUFFER = 16 * 1024 * 1024;

const TIMEOUTS = {
	typecheck: 5 * 60_000,
	lint: 2 * 60_000,
	test: 5 * 60_000,
	build: 10 * 60_000,
	launchWaitMs: 30_000,
	browserDefaultMs: 30_000,
} as const;

const HEALTHY_STATUSES = new Set(["running", "connected", "active", "ready"]);

export type VerificationCheckKind =
	| "typecheck"
	| "lint"
	| "test"
	| "build"
	| "launch"
	| "browser"
	| "structured-proof";

export type VerificationCheck =
	| { kind: "typecheck" }
	| { kind: "lint" }
	| { kind: "test"; filter?: string }
	| { kind: "build" }
	| { kind: "launch"; appName: string }
	| {
			kind: "browser";
			routes?: string[];
			requireDom?: string;
			timeoutMs?: number;
	  };

export type CheckResult = {
	kind: VerificationCheckKind;
	passed: boolean;
	durationMs: number;
	output: string;
	outputPath?: string;
	diagnostics?: Diagnostic[];
	testSummary?: TestRunSummary;
};

export type VerificationProfile = "fast" | "full";
export type ProjectKind = "app" | "plugin";
export type StructuredProofKind = "APP_CREATE_DONE" | "PLUGIN_CREATE_DONE";

export type TestRunSummary = {
	passed: number;
	failed: number;
};

export type VerifyOptions = {
	workdir: string;
	appName?: string;
	checks?: VerificationCheck[];
	profile?: VerificationProfile;
	projectKind?: ProjectKind;
	requireStructuredProof?: boolean;
	structuredProof?: unknown;
	runId?: string;
	packageManager?: PackageManager;
};

export type VerificationResult = {
	verdict: "pass" | "fail";
	checks: CheckResult[];
	screenshot?: { path: string; visionDescription?: string };
	retryablePromptForChild: string;
	durationMs: number;
	runId: string;
};

export type LaunchContext = {
	viewerUrl: string | null;
};

type BrowserModule = {
	launch: (options: {
		headless?: boolean | "new" | "shell";
		executablePath?: string;
		args?: string[];
	}) => Promise<BrowserLike>;
};

type BrowserLike = {
	newPage: () => Promise<PageLike>;
	close: () => Promise<void>;
};

type PageLike = {
	on: (event: string, handler: (...args: unknown[]) => void) => void;
	goto: (
		url: string,
		options?: { waitUntil?: string; timeout?: number },
	) => Promise<unknown>;
	$: (selector: string) => Promise<unknown>;
	screenshot: (options: {
		path: string;
		fullPage?: boolean;
	}) => Promise<unknown>;
	close: () => Promise<void>;
};

function nowMs(): number {
	return Date.now();
}

function newRunId(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const rand = Math.random().toString(36).slice(2, 8);
	return `verify-${stamp}-${rand}`;
}

function expandProfile(
	profile: VerificationProfile | undefined,
	appName: string | undefined,
	projectKind: ProjectKind,
): VerificationCheck[] {
	if (projectKind === "plugin") {
		return [{ kind: "typecheck" }, { kind: "lint" }, { kind: "test" }];
	}
	if (profile === "fast" || profile === undefined) {
		return [{ kind: "typecheck" }, { kind: "lint" }];
	}
	const checks: VerificationCheck[] = [
		{ kind: "typecheck" },
		{ kind: "lint" },
		{ kind: "test" },
	];
	if (appName) {
		checks.push({ kind: "launch", appName });
		checks.push({ kind: "browser" });
	}
	return checks;
}

function packageScriptCommand(
	pm: PackageManager,
	script: string,
): { file: string; args: string[] } {
	if (pm === "bun") return { file: "bun", args: ["run", script] };
	return { file: "npm", args: ["run", "--silent", script] };
}

async function runScript(
	pm: PackageManager,
	script: string,
	workdir: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { file, args } = packageScriptCommand(pm, script);
	const opts: ExecFileOptions = {
		cwd: workdir,
		timeout: timeoutMs,
		maxBuffer: EXEC_BUFFER,
		// Ensure non-interactive child processes (no TTY prompts).
		env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0" },
	};
	try {
		const { stdout, stderr } = await execFileAsync(file, args, opts);
		return {
			stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
			stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
			exitCode: 0,
		};
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			code?: number | string;
			signal?: string;
		};
		const stdout =
			typeof e.stdout === "string"
				? e.stdout
				: (e.stdout?.toString("utf8") ?? "");
		const stderr =
			typeof e.stderr === "string"
				? e.stderr
				: (e.stderr?.toString("utf8") ?? "");
		const exitCode = typeof e.code === "number" ? e.code : 1;
		return { stdout, stderr, exitCode };
	}
}

async function persistOutput(
	dir: string,
	kind: VerificationCheckKind,
	full: string,
): Promise<string> {
	const outputPath = path.join(dir, `${kind}.log`);
	await writeFile(outputPath, full, "utf8");
	return outputPath;
}

function combineOutput(stdout: string, stderr: string): string {
	if (!stdout) return stderr;
	if (!stderr) return stdout;
	return `${stdout}\n--- stderr ---\n${stderr}`;
}

function parseProvenVitestSummary(output: string): TestRunSummary | null {
	const testsLine = output
		.split(/\r?\n/)
		.find((line) => /^\s*Tests\s+/.test(line));
	if (!testsLine) return null;
	const failedMatch = /(\d+)\s+failed/.exec(testsLine);
	const passedMatch = /(\d+)\s+passed/.exec(testsLine);
	if (!failedMatch && !passedMatch) return null;
	return {
		passed: passedMatch ? Number.parseInt(passedMatch[1] ?? "0", 10) : 0,
		failed: failedMatch ? Number.parseInt(failedMatch[1] ?? "0", 10) : 0,
	};
}

async function runTypecheck(
	dir: string,
	pm: PackageManager,
	workdir: string,
): Promise<CheckResult> {
	const start = nowMs();
	const { stdout, stderr, exitCode } = await runScript(
		pm,
		"typecheck",
		workdir,
		TIMEOUTS.typecheck,
	);
	const full = combineOutput(stdout, stderr);
	const outputPath = await persistOutput(dir, "typecheck", full);
	const diagnostics = parseTscOutput(full);
	return {
		kind: "typecheck",
		passed: exitCode === 0,
		durationMs: nowMs() - start,
		output: truncate(full, OUTPUT_INLINE_LIMIT),
		outputPath,
		...(diagnostics.length > 0 ? { diagnostics } : {}),
	};
}

async function runLint(
	dir: string,
	pm: PackageManager,
	workdir: string,
): Promise<CheckResult> {
	const start = nowMs();
	const { stdout, stderr, exitCode } = await runScript(
		pm,
		"lint",
		workdir,
		TIMEOUTS.lint,
	);
	const full = combineOutput(stdout, stderr);
	const outputPath = await persistOutput(dir, "lint", full);
	const diagnostics = parseEslintOutput(full);
	return {
		kind: "lint",
		passed: exitCode === 0 && diagnostics.length === 0,
		durationMs: nowMs() - start,
		output: truncate(full, OUTPUT_INLINE_LIMIT),
		outputPath,
		...(diagnostics.length > 0 ? { diagnostics } : {}),
	};
}

async function runTests(
	dir: string,
	pm: PackageManager,
	workdir: string,
	filter: string | undefined,
): Promise<CheckResult> {
	const start = nowMs();
	const { file, args } = packageScriptCommand(pm, "test");
	const fullArgs = filter ? [...args, "--", filter] : args;
	const opts: ExecFileOptions = {
		cwd: workdir,
		timeout: TIMEOUTS.test,
		maxBuffer: EXEC_BUFFER,
		env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0" },
	};
	let stdout = "";
	let stderr = "";
	let exitCode = 0;
	try {
		const result = await execFileAsync(file, fullArgs, opts);
		stdout =
			typeof result.stdout === "string"
				? result.stdout
				: result.stdout.toString("utf8");
		stderr =
			typeof result.stderr === "string"
				? result.stderr
				: result.stderr.toString("utf8");
	} catch (err) {
		const e = err as NodeJS.ErrnoException & {
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			code?: number | string;
		};
		stdout =
			typeof e.stdout === "string"
				? e.stdout
				: (e.stdout?.toString("utf8") ?? "");
		stderr =
			typeof e.stderr === "string"
				? e.stderr
				: (e.stderr?.toString("utf8") ?? "");
		exitCode = typeof e.code === "number" ? e.code : 1;
	}
	const full = combineOutput(stdout, stderr);
	const outputPath = await persistOutput(dir, "test", full);
	const summary = parseVitestOutput(full);
	const provenSummary = parseProvenVitestSummary(full);
	const diagnostics: Diagnostic[] = summary.failures.map((failure) => ({
		file: "test",
		message: failure,
		severity: "error" as const,
	}));
	const failedCount = provenSummary ? provenSummary.failed : summary.failed;
	return {
		kind: "test",
		passed: exitCode === 0 && failedCount === 0,
		durationMs: nowMs() - start,
		output: truncate(full, OUTPUT_INLINE_LIMIT),
		outputPath,
		...(diagnostics.length > 0 ? { diagnostics } : {}),
		...(provenSummary ? { testSummary: provenSummary } : {}),
	};
}

async function runBuild(
	dir: string,
	pm: PackageManager,
	workdir: string,
): Promise<CheckResult> {
	const start = nowMs();
	const { stdout, stderr, exitCode } = await runScript(
		pm,
		"build",
		workdir,
		TIMEOUTS.build,
	);
	const full = combineOutput(stdout, stderr);
	const outputPath = await persistOutput(dir, "build", full);
	return {
		kind: "build",
		passed: exitCode === 0,
		durationMs: nowMs() - start,
		output: truncate(full, OUTPUT_INLINE_LIMIT),
		outputPath,
	};
}

function isHealthyRun(run: AppRunSummary): boolean {
	return HEALTHY_STATUSES.has(run.status.trim().toLowerCase());
}

async function runLaunchCheck(
	dir: string,
	client: AppControlClient,
	appName: string,
	launchCtx: LaunchContext,
): Promise<CheckResult> {
	const start = nowMs();
	let logBuffer = `Launching app: ${appName}\n`;
	let passed = false;
	let runId: string | null = null;
	let viewerUrl: string | null = null;
	try {
		const launch = await client.launchApp(appName);
		viewerUrl = launch.launchUrl ?? launch.run?.launchUrl ?? null;
		runId = launch.run?.runId ?? null;
		logBuffer += `Launch result: displayName=${launch.displayName} launchType=${launch.launchType} runId=${runId ?? "<none>"} launchUrl=${viewerUrl ?? "<none>"}\n`;

		// Already healthy from the launch response?
		if (launch.run && isHealthyRun(launch.run)) {
			passed = true;
		} else {
			const deadline = nowMs() + TIMEOUTS.launchWaitMs;
			while (nowMs() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				const runs = await client.listAppRuns();
				const matched = runs.find((r) =>
					runId ? r.runId === runId : r.appName === appName,
				);
				if (matched) {
					runId = matched.runId;
					if (!viewerUrl && matched.launchUrl) viewerUrl = matched.launchUrl;
					logBuffer += `Poll: status=${matched.status}\n`;
					if (isHealthyRun(matched)) {
						passed = true;
						break;
					}
				} else {
					logBuffer += "Poll: no matching run found yet\n";
				}
			}
		}
		if (!passed) {
			logBuffer += `Timeout waiting ${TIMEOUTS.launchWaitMs}ms for run to become healthy\n`;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logBuffer += `Launch error: ${message}\n`;
	}
	launchCtx.viewerUrl = viewerUrl;
	const outputPath = await persistOutput(dir, "launch", logBuffer);
	return {
		kind: "launch",
		passed,
		durationMs: nowMs() - start,
		output: truncate(logBuffer, OUTPUT_INLINE_LIMIT),
		outputPath,
	};
}

type BrowserModuleLoader = () => Promise<BrowserModule | null>;

const defaultBrowserModuleLoader: BrowserModuleLoader = async () => {
	try {
		// Dynamic import keeps puppeteer-core off the bundler's resolution graph.
		const mod = (await import(/* @vite-ignore */ "puppeteer-core")) as {
			default?: BrowserModule;
		} & BrowserModule;
		return mod.default ?? mod;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
			return null;
		}
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`[AppVerificationService] failed to load puppeteer-core: ${message}`,
			{ cause: err instanceof Error ? err : undefined },
		);
	}
};

let browserModuleLoader: BrowserModuleLoader = defaultBrowserModuleLoader;

export function __setBrowserModuleLoaderForTests(
	loader: BrowserModuleLoader | null,
): void {
	browserModuleLoader = loader ?? defaultBrowserModuleLoader;
}

async function loadBrowserModule(): Promise<BrowserModule | null> {
	return browserModuleLoader();
}

function resolveChromePath(): string | undefined {
	const fromEnv =
		process.env.ELIZA_CHROME_PATH?.trim() ||
		process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
	if (fromEnv) return fromEnv;
	if (process.platform === "darwin") {
		return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	}
	return undefined;
}

type BrowserCheckOutcome = {
	check: CheckResult;
	screenshotPath?: string;
};

async function runBrowserCheck(
	dir: string,
	options: { routes?: string[]; requireDom?: string; timeoutMs?: number },
	launchCtx: LaunchContext,
	openBrowsers: Set<BrowserLike>,
): Promise<BrowserCheckOutcome> {
	const start = nowMs();
	const timeoutMs = options.timeoutMs ?? TIMEOUTS.browserDefaultMs;
	const baseUrl = launchCtx.viewerUrl;
	if (!baseUrl) {
		const output =
			"Browser check failed: launch reported success but did not surface a viewer URL. The launch contract requires a launchUrl on healthy runs; without it we cannot verify rendering.";
		logger.error(`[AppVerificationService] ${output}`);
		const outputPath = await persistOutput(dir, "browser", output);
		return {
			check: {
				kind: "browser",
				passed: false,
				durationMs: nowMs() - start,
				output,
				outputPath,
				diagnostics: [
					{
						file: "browser",
						message: "launch produced no viewerUrl; cannot verify rendering",
						severity: "error",
					},
				],
			},
		};
	}

	const browserModule = await loadBrowserModule();
	if (!browserModule) {
		if (process.env.ELIZA_BROWSER_VERIFY_OPTIONAL === "1") {
			const output =
				"browser check skipped — ELIZA_BROWSER_VERIFY_OPTIONAL=1; install puppeteer-core for full coverage";
			logger.warn(`[AppVerificationService] ${output}`);
			const outputPath = await persistOutput(dir, "browser", output);
			return {
				check: {
					kind: "browser",
					passed: true,
					durationMs: nowMs() - start,
					output,
					outputPath,
				},
			};
		}
		const output =
			"puppeteer-core not installed; cannot verify rendering. Install puppeteer-core (bun add -D puppeteer-core), or set ELIZA_BROWSER_VERIFY_OPTIONAL=1 to acknowledge skipping this check.";
		logger.error(`[AppVerificationService] ${output}`);
		const outputPath = await persistOutput(dir, "browser", output);
		return {
			check: {
				kind: "browser",
				passed: false,
				durationMs: nowMs() - start,
				output,
				outputPath,
				diagnostics: [
					{
						file: "browser",
						message:
							"puppeteer-core dependency missing — install puppeteer-core (bun add -D puppeteer-core) or set ELIZA_BROWSER_VERIFY_OPTIONAL=1 to acknowledge skipping browser verification",
						severity: "error",
					},
				],
			},
		};
	}

	const routes =
		options.routes && options.routes.length > 0 ? options.routes : [""];
	const consoleErrors: string[] = [];
	const navLog: string[] = [];
	let browser: BrowserLike | null = null;
	let screenshotPath: string | undefined;
	let passed = true;

	try {
		browser = await browserModule.launch({
			headless: true,
			executablePath: resolveChromePath(),
			args: ["--no-sandbox", "--disable-setuid-sandbox"],
		});
		openBrowsers.add(browser);
		const page = await browser.newPage();
		page.on("console", (...args: unknown[]) => {
			const msg = args[0] as
				| { type?: () => string; text?: () => string }
				| undefined;
			if (
				msg &&
				typeof msg.type === "function" &&
				typeof msg.text === "function"
			) {
				if (msg.type() === "error") {
					consoleErrors.push(msg.text());
				}
			}
		});
		page.on("pageerror", (...args: unknown[]) => {
			const err = args[0] as Error | undefined;
			if (err) consoleErrors.push(`pageerror: ${err.message}`);
		});

		for (const route of routes) {
			const target = route ? new URL(route, baseUrl).toString() : baseUrl;
			navLog.push(`navigate ${target}`);
			await page.goto(target, {
				waitUntil: "domcontentloaded",
				timeout: timeoutMs,
			});
			if (options.requireDom) {
				const handle = await page.$(options.requireDom);
				if (!handle) {
					passed = false;
					navLog.push(`required selector not found: ${options.requireDom}`);
				}
			}
		}

		screenshotPath = path.join(dir, "screenshot.png");
		await page.screenshot({ path: screenshotPath, fullPage: false });
		await page.close();
	} catch (err) {
		passed = false;
		const message = err instanceof Error ? err.message : String(err);
		navLog.push(`error: ${message}`);
	} finally {
		if (browser) {
			try {
				await browser.close();
			} catch {
				// ignore close errors — process exit will reap the chromium.
			}
			openBrowsers.delete(browser);
		}
	}

	if (consoleErrors.length > 0) {
		passed = false;
	}

	const sections: string[] = [];
	sections.push(`Routes:\n  ${navLog.join("\n  ")}`);
	if (consoleErrors.length > 0) {
		sections.push(
			`Console errors (${consoleErrors.length}):\n  ${consoleErrors.join("\n  ")}`,
		);
	}
	if (screenshotPath) {
		sections.push(`Screenshot: ${screenshotPath}`);
	}
	const full = sections.join("\n\n");
	const outputPath = await persistOutput(dir, "browser", full);

	const diagnostics: Diagnostic[] | undefined =
		consoleErrors.length > 0
			? consoleErrors.map((message) => ({
					file: "browser",
					message,
					severity: "error" as const,
				}))
			: undefined;

	return {
		check: {
			kind: "browser",
			passed,
			durationMs: nowMs() - start,
			output: truncate(full, OUTPUT_INLINE_LIMIT),
			outputPath,
			...(diagnostics ? { diagnostics } : {}),
		},
		...(screenshotPath ? { screenshotPath } : {}),
	};
}

export const __runBrowserCheckForTests = runBrowserCheck;

function isHardFail(kind: VerificationCheckKind): boolean {
	return (
		kind === "typecheck" ||
		kind === "lint" ||
		kind === "test" ||
		kind === "build" ||
		kind === "launch" ||
		kind === "browser" ||
		kind === "structured-proof"
	);
}

type ProjectPackageInfo = {
	projectKind?: ProjectKind;
};

type StructuredProofClaim = {
	kind: StructuredProofKind;
	projectName: string;
	files: string[];
	tests: TestRunSummary;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readProjectPackage(
	workdir: string,
): Promise<ProjectPackageInfo> {
	try {
		const raw = await readFile(path.join(workdir, "package.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return {};
		const elizaos = isRecord(parsed.elizaos) ? parsed.elizaos : null;
		const projectKind = elizaos
			? isRecord(elizaos.plugin)
				? "plugin"
				: isRecord(elizaos.app)
					? "app"
					: undefined
			: undefined;
		return {
			...(projectKind ? { projectKind } : {}),
		};
	} catch {
		return {};
	}
}

function projectKindFromProofKind(kind: StructuredProofKind): ProjectKind {
	return kind === "PLUGIN_CREATE_DONE" ? "plugin" : "app";
}

function expectedProofKind(projectKind: ProjectKind): StructuredProofKind {
	return projectKind === "plugin" ? "PLUGIN_CREATE_DONE" : "APP_CREATE_DONE";
}

function extractStructuredProofKind(
	structuredProof: unknown,
): StructuredProofKind | undefined {
	if (!isRecord(structuredProof)) return undefined;
	const kind = structuredProof.kind;
	return kind === "APP_CREATE_DONE" || kind === "PLUGIN_CREATE_DONE"
		? kind
		: undefined;
}

function inferProjectKind(
	opts: VerifyOptions,
	packageInfo: ProjectPackageInfo,
): ProjectKind {
	if (opts.projectKind) return opts.projectKind;
	const proofKind = extractStructuredProofKind(opts.structuredProof);
	if (proofKind) return projectKindFromProofKind(proofKind);
	if (packageInfo.projectKind) return packageInfo.projectKind;
	if (opts.appName) return "app";
	return "app";
}

function shouldRequireStructuredProof(
	opts: VerifyOptions,
	projectKind: ProjectKind,
): boolean {
	if (typeof opts.requireStructuredProof === "boolean") {
		return opts.requireStructuredProof;
	}
	if (opts.structuredProof !== undefined) return true;
	if (projectKind === "plugin") return true;
	return opts.profile === "full";
}

function proofField(proof: Record<string, unknown>, field: string): unknown {
	if (Object.hasOwn(proof, field)) {
		return proof[field];
	}
	const extra = proof.extra;
	if (isRecord(extra) && Object.hasOwn(extra, field)) {
		return extra[field];
	}
	return undefined;
}

function hasProofField(proof: Record<string, unknown>, field: string): boolean {
	if (Object.hasOwn(proof, field)) {
		return true;
	}
	const extra = proof.extra;
	return isRecord(extra) && Object.hasOwn(extra, field);
}

function isNonNegativeInteger(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		Number.isFinite(value) &&
		value >= 0
	);
}

function parseStructuredProofClaim(
	raw: unknown,
	expectedKind: StructuredProofKind,
): { claim?: StructuredProofClaim; issues: string[] } {
	const issues: string[] = [];
	if (!isRecord(raw)) {
		return {
			issues: [
				`Missing ${expectedKind} proof. Re-run verification and emit exactly one ${expectedKind} line.`,
			],
		};
	}

	for (const legacyField of ["name", "testsPassed", "lintClean"]) {
		if (hasProofField(raw, legacyField)) {
			issues.push(
				`structured proof uses legacy field ${legacyField}; emit the canonical ${expectedKind} schema`,
			);
		}
	}

	const kindValue = proofField(raw, "kind");
	const kind =
		kindValue === "APP_CREATE_DONE" || kindValue === "PLUGIN_CREATE_DONE"
			? kindValue
			: undefined;
	if (!kind) {
		issues.push(
			`structured proof kind must be ${expectedKind}; received ${String(kindValue)}`,
		);
	} else if (kind !== expectedKind) {
		issues.push(
			`structured proof kind must be ${expectedKind}; received ${kind}`,
		);
	}

	const nameField =
		expectedKind === "APP_CREATE_DONE" ? "appName" : "pluginName";
	const forbiddenNameField =
		expectedKind === "APP_CREATE_DONE" ? "pluginName" : "appName";
	const nameValue = proofField(raw, nameField);
	const projectName =
		typeof nameValue === "string" && nameValue.trim().length > 0
			? nameValue.trim()
			: undefined;
	if (!projectName) {
		issues.push(`structured proof must include a non-empty ${nameField}`);
	}
	if (hasProofField(raw, forbiddenNameField)) {
		issues.push(
			`structured proof ${forbiddenNameField} is invalid for ${expectedKind}`,
		);
	}

	const filesValue = proofField(raw, "files");
	const files =
		Array.isArray(filesValue) &&
		filesValue.every((entry) => typeof entry === "string")
			? filesValue.map((entry) => entry.trim())
			: undefined;
	if (!files) {
		issues.push("structured proof files must be an array of relative paths");
	} else if (files.length === 0) {
		issues.push("structured proof files must list at least one changed file");
	} else if (files.some((entry) => entry.length === 0)) {
		issues.push("structured proof files must not contain empty paths");
	}

	const typecheck = proofField(raw, "typecheck");
	if (typecheck !== "ok") {
		issues.push('structured proof must include typecheck:"ok"');
	}
	const lint = proofField(raw, "lint");
	if (lint !== "ok") {
		issues.push('structured proof must include lint:"ok"');
	}

	const testsValue = proofField(raw, "tests");
	let tests: TestRunSummary | undefined;
	if (!isRecord(testsValue)) {
		issues.push('structured proof must include tests:{"passed":N,"failed":0}');
	} else {
		const passed = testsValue.passed;
		const failed = testsValue.failed;
		if (!isNonNegativeInteger(passed)) {
			issues.push(
				"structured proof tests.passed must be a non-negative integer",
			);
		}
		if (!isNonNegativeInteger(failed)) {
			issues.push(
				"structured proof tests.failed must be a non-negative integer",
			);
		}
		if (isNonNegativeInteger(passed) && isNonNegativeInteger(failed)) {
			tests = { passed, failed };
		}
	}

	if (!kind || !projectName || !files || !tests || issues.length > 0) {
		return { issues };
	}
	return { claim: { kind, projectName, files, tests }, issues };
}

async function validateClaimedFiles(
	workdir: string,
	files: string[],
): Promise<string[]> {
	const issues: string[] = [];
	const root = path.resolve(workdir);
	for (const file of files) {
		if (path.isAbsolute(file)) {
			issues.push(`claimed file ${file} must be relative to the project root`);
			continue;
		}
		const resolved = path.resolve(root, file);
		const relative = path.relative(root, resolved);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			issues.push(`claimed file ${file} resolves outside the project root`);
			continue;
		}
		try {
			const info = await stat(resolved);
			if (!info.isFile()) {
				issues.push(`claimed file ${file} is not a regular file`);
			} else if (info.size === 0) {
				issues.push(`claimed file ${file} is empty`);
			}
		} catch {
			issues.push(`claimed file ${file} does not exist`);
		}
	}
	return issues;
}

function checkResultFor(
	checks: CheckResult[],
	kind: VerificationCheckKind,
): CheckResult | undefined {
	return checks.find((check) => check.kind === kind);
}

function validateProofAgainstChecks(
	claim: StructuredProofClaim,
	checks: CheckResult[],
): string[] {
	const issues: string[] = [];
	const typecheck = checkResultFor(checks, "typecheck");
	if (!typecheck) {
		issues.push(
			'typecheck check did not run, so typecheck:"ok" cannot be proven',
		);
	} else if (!typecheck.passed) {
		issues.push('typecheck check failed, so typecheck:"ok" is false');
	}

	const lint = checkResultFor(checks, "lint");
	if (!lint) {
		issues.push('lint check did not run, so lint:"ok" cannot be proven');
	} else if (!lint.passed) {
		issues.push('lint check failed, so lint:"ok" is false');
	}

	const test = checkResultFor(checks, "test");
	if (!test) {
		issues.push("test check did not run, so tests.passed cannot be proven");
	} else if (!test.passed) {
		issues.push("test check failed, so tests.failed must not be 0");
	}
	if (claim.tests.failed !== 0) {
		issues.push("structured proof tests.failed must be 0");
	}
	if (test?.testSummary) {
		if (test.testSummary.failed !== 0) {
			issues.push(
				`test output reported ${test.testSummary.failed} failed tests`,
			);
		}
		if (claim.tests.passed !== test.testSummary.passed) {
			issues.push(
				`structured proof tests.passed=${claim.tests.passed} does not match verified test output passed=${test.testSummary.passed}`,
			);
		}
	} else {
		issues.push(
			"Cannot prove tests.passed because the test output did not contain a Vitest Tests summary line",
		);
	}
	return issues;
}

async function runStructuredProofCheck(
	dir: string,
	workdir: string,
	structuredProof: unknown,
	expectedKind: StructuredProofKind,
	checks: CheckResult[],
): Promise<CheckResult> {
	const start = nowMs();
	const parsed = parseStructuredProofClaim(structuredProof, expectedKind);
	const issues = [...parsed.issues];
	if (parsed.claim) {
		issues.push(...(await validateClaimedFiles(workdir, parsed.claim.files)));
		issues.push(...validateProofAgainstChecks(parsed.claim, checks));
	}
	const passed = issues.length === 0;
	const output = passed
		? `${expectedKind} proof accepted.`
		: `Structured proof failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
	const outputPath = await persistOutput(dir, "structured-proof", output);
	const diagnostics: Diagnostic[] = issues.map((message) => ({
		file: "structured-proof",
		message,
		severity: "error" as const,
	}));
	return {
		kind: "structured-proof",
		passed,
		durationMs: nowMs() - start,
		output: truncate(output, OUTPUT_INLINE_LIMIT),
		outputPath,
		...(diagnostics.length > 0 ? { diagnostics } : {}),
	};
}

function summarizeDiagnostic(diag: Diagnostic): string {
	const loc = diag.line ? `:${diag.line}` : "";
	return `${diag.file}${loc} — ${diag.message}`;
}

function buildRetryPrompt(
	checks: CheckResult[],
	proofKind: StructuredProofKind,
): string {
	const failed = checks.filter((c) => !c.passed);
	if (failed.length === 0) {
		return "Verification passed. No retry needed.";
	}
	const lines: string[] = ["Verification failed at the following checks:"];
	for (const check of failed) {
		const diags = check.diagnostics ?? [];
		if (diags.length === 0) {
			const snippet = truncate(check.output, 240);
			lines.push(`  - ${check.kind}: failed`);
			if (snippet) lines.push(`      ${snippet.replace(/\n/g, "\n      ")}`);
			continue;
		}
		const errors = diags.filter((d) => d.severity === "error");
		const counted = errors.length > 0 ? errors : diags;
		lines.push(
			`  - ${check.kind}: ${counted.length} ${counted.length === 1 ? "issue" : "issues"}`,
		);
		const shown = counted.slice(0, 10);
		for (const diag of shown) {
			lines.push(`      ${summarizeDiagnostic(diag)}`);
		}
		const remaining = counted.length - shown.length;
		if (remaining > 0) {
			lines.push(`      ... and ${remaining} more.`);
		}
	}
	lines.push("");
	lines.push(
		"After fixing the issues, rerun `bun run typecheck`, `bun run lint`, and `bun run test`, then re-emit exactly one structured completion line:",
	);
	const nameField = proofKind === "APP_CREATE_DONE" ? "appName" : "pluginName";
	lines.push(
		`${proofKind} {"${nameField}":"<package-name>","files":["src/index.ts"],"tests":{"passed":<exact passed count>,"failed":0},"lint":"ok","typecheck":"ok","description":"<one factual sentence>"}`,
	);
	const text = lines.join("\n");
	return truncate(text, RETRY_PROMPT_LIMIT);
}

export class AppVerificationService extends Service {
	static override serviceType = "app-verification";

	override capabilityDescription =
		"Runs typecheck/lint/test/launch/browser verification against an app workdir and returns a structured pass/fail result with diagnostics for the orchestrator to consume.";

	private readonly openBrowsers = new Set<BrowserLike>();

	static override async start(
		runtime: IAgentRuntime,
	): Promise<AppVerificationService> {
		return new AppVerificationService(runtime);
	}

	override async stop(): Promise<void> {
		await this.cleanup();
	}

	async cleanup(): Promise<void> {
		const browsers = Array.from(this.openBrowsers);
		this.openBrowsers.clear();
		for (const browser of browsers) {
			try {
				await browser.close();
			} catch {
				// best effort
			}
		}
	}

	async verifyApp(opts: VerifyOptions): Promise<VerificationResult> {
		return this.verifyProject(opts);
	}

	async verifyPlugin(opts: VerifyOptions): Promise<VerificationResult> {
		return this.verifyProject({
			...opts,
			projectKind: "plugin",
			requireStructuredProof: opts.requireStructuredProof ?? true,
		});
	}

	async verifyProject(opts: VerifyOptions): Promise<VerificationResult> {
		const start = nowMs();
		const runId = opts.runId ?? newRunId();
		const dir = await ensureVerificationDir(runId);
		const pm = opts.packageManager ?? detectPackageManager(opts.workdir);
		const packageInfo = await readProjectPackage(opts.workdir);
		const projectKind = inferProjectKind(opts, packageInfo);
		const proofKind = expectedProofKind(projectKind);
		const checks =
			opts.checks ?? expandProfile(opts.profile, opts.appName, projectKind);
		const results: CheckResult[] = [];
		const launchCtx: LaunchContext = { viewerUrl: null };
		let screenshot: VerificationResult["screenshot"] | undefined;
		let stop = false;

		const client: AppControlClient | null = checks.some(
			(c) => c.kind === "launch",
		)
			? createAppControlClient()
			: null;

		for (const check of checks) {
			if (stop) break;
			let result: CheckResult;
			switch (check.kind) {
				case "typecheck":
					result = await runTypecheck(dir, pm, opts.workdir);
					break;
				case "lint":
					result = await runLint(dir, pm, opts.workdir);
					break;
				case "test":
					result = await runTests(dir, pm, opts.workdir, check.filter);
					break;
				case "build":
					result = await runBuild(dir, pm, opts.workdir);
					break;
				case "launch": {
					if (!client) {
						throw new Error(
							"Launch check requested but AppControlClient was not initialized",
						);
					}
					result = await runLaunchCheck(dir, client, check.appName, launchCtx);
					break;
				}
				case "browser": {
					const outcome = await runBrowserCheck(
						dir,
						{
							routes: check.routes,
							requireDom: check.requireDom,
							timeoutMs: check.timeoutMs,
						},
						launchCtx,
						this.openBrowsers,
					);
					result = outcome.check;
					if (outcome.screenshotPath) {
						const visionDescription = await describeScreenshotWithVision(
							this.runtime,
							outcome.screenshotPath,
						);
						screenshot = {
							path: outcome.screenshotPath,
							...(visionDescription ? { visionDescription } : {}),
						};
					}
					break;
				}
			}
			results.push(result);
			if (!result.passed && isHardFail(result.kind)) {
				stop = true;
			}
		}

		if (shouldRequireStructuredProof(opts, projectKind)) {
			results.push(
				await runStructuredProofCheck(
					dir,
					opts.workdir,
					opts.structuredProof,
					proofKind,
					results,
				),
			);
		}

		// If the pipeline did not run a browser check but a desktop screenshot
		// is available via the dev API, capture it as supplementary evidence.
		if (!screenshot) {
			const desktopShot = await captureScreenshotViaDevApi();
			if (desktopShot) {
				const fs = await import("node:fs/promises");
				const desktopPath = path.join(dir, "desktop.png");
				await fs.writeFile(desktopPath, desktopShot);
				const visionDescription = await describeScreenshotWithVision(
					this.runtime,
					desktopPath,
				);
				screenshot = {
					path: desktopPath,
					...(visionDescription ? { visionDescription } : {}),
				};
			}
		}

		const verdict: "pass" | "fail" = results.every((r) => r.passed)
			? "pass"
			: "fail";

		const result: VerificationResult = {
			verdict,
			checks: results,
			retryablePromptForChild: buildRetryPrompt(results, proofKind),
			durationMs: nowMs() - start,
			runId,
			...(screenshot ? { screenshot } : {}),
		};
		logger.info(
			`[AppVerificationService] verifyProject runId=${runId} kind=${projectKind} verdict=${verdict} checks=${results.length} durationMs=${result.durationMs}`,
		);
		return result;
	}
}
