/**
 * @module plugin-app-control/actions/scaffold-env
 *
 * Shared environment resolution + dispatch preflight for the APP/VIEWS
 * create flows.
 *
 * Scaffolding historically resolved the min-plugin / min-project templates and
 * the plugins/ landing dir only relative to the repo root (ELIZA_REPO_ROOT /
 * cwd), so a packaged install — no monorepo checkout on disk — always
 * dead-ended with "template not found". It also scaffolded FIRST and only then
 * discovered the coding-agent orchestrator or CLI backend was missing, leaving
 * a half-created plugin dir and an unactionable error.
 *
 * This module adds the packaged-install fallbacks and the up-front checks:
 *  - templates also resolve from the installed `elizaos` package, which
 *    publishes `templates/` in its files array (declared as a dependency of
 *    this plugin so packaged builds always ship it);
 *  - new plugins can land in `<stateDir>/plugins` when the repo root has no
 *    plugins/ dir (registered via load-from-directory like any external dir);
 *  - `preflightCodingDispatch` verifies the orchestrator action and a coding
 *    CLI are available BEFORE scaffolding, returning setup guidance instead of
 *    a dead-end error text.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { resolveStateDir } from "@elizaos/core";

/** Templates published by the `elizaos` package under `templates/`. */
export type ScaffoldTemplateId = "min-plugin" | "min-project";

/** Repo-root-relative dirs that contain the scaffold templates. */
const TEMPLATE_REPO_PARENTS = [
	"packages/elizaos/templates",
	"eliza/packages/elizaos/templates",
] as const;

/** Repo-root-relative dirs where new plugins land in a checkout. */
const PLUGINS_DIR_CANDIDATES = ["eliza/plugins", "plugins"] as const;

/** Coding CLIs the ACP layer can drive; probed on PATH by the preflight. */
const CODING_CLI_BINARIES = ["claude", "codex", "opencode"] as const;

export interface TemplateResolution {
	/** Resolved template dir, or undefined when nothing was found. */
	dir?: string;
	/** Every location checked, for actionable error text. */
	tried: string[];
}

async function isDirectory(dir: string): Promise<boolean> {
	const stat = await fs.stat(dir).catch(() => null);
	return stat?.isDirectory() ?? false;
}

/**
 * Locate the `templates/` dir of the installed `elizaos` package. Returns
 * undefined when the package is not resolvable (e.g. a checkout that never
 * installed it).
 */
function installedTemplatesDir(): string | undefined {
	try {
		const require = createRequire(import.meta.url);
		const pkgJson = require.resolve("elizaos/package.json");
		return path.join(path.dirname(pkgJson), "templates");
	} catch {
		return undefined;
	}
}

/**
 * Resolve a scaffold template dir: repo checkout first (ELIZA_REPO_ROOT /
 * cwd), then the installed `elizaos` package for packaged installs.
 */
export async function resolveScaffoldTemplateDir(
	repoRoot: string,
	template: ScaffoldTemplateId,
): Promise<TemplateResolution> {
	const tried: string[] = [];
	for (const parent of TEMPLATE_REPO_PARENTS) {
		const dir = path.join(repoRoot, parent, template);
		tried.push(dir);
		if (await isDirectory(dir)) return { dir, tried };
	}
	const packaged = installedTemplatesDir();
	if (packaged) {
		const dir = path.join(packaged, template);
		tried.push(dir);
		if (await isDirectory(dir)) return { dir, tried };
	} else {
		tried.push("templates/ of the installed `elizaos` package (not installed)");
	}
	return { tried };
}

/** Setup guidance for a missing scaffold template. */
export function templateMissingGuidance(
	template: ScaffoldTemplateId,
	tried: readonly string[],
): string {
	return [
		`the ${template} template is not available (tried: ${tried.join(", ")}).`,
		"Run the agent from an elizaOS checkout (or point ELIZA_REPO_ROOT at one),",
		"or install the `elizaos` package so the bundled templates ship with this install.",
	].join(" ");
}

/**
 * Where a newly scaffolded plugin lands: the checkout's plugins/ dir when one
 * exists under the repo root, else a writable `<stateDir>/plugins` so packaged
 * installs can still scaffold (the result is registered via
 * load-from-directory like any external plugin dir).
 */
export async function resolvePluginScaffoldBaseDir(
	repoRoot: string,
): Promise<string> {
	for (const rel of PLUGINS_DIR_CANDIDATES) {
		const dir = path.join(repoRoot, rel);
		if (await isDirectory(dir)) return dir;
	}
	const fallback = path.join(resolveStateDir(), "plugins");
	await fs.mkdir(fallback, { recursive: true });
	return fallback;
}

async function isExecutable(file: string): Promise<boolean> {
	try {
		await fs.access(file, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Find the first known coding CLI present on PATH, if any. */
export async function findCodingCliOnPath(): Promise<string | undefined> {
	const dirs = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter((dir) => dir.length > 0);
	const suffixes =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
					.split(";")
					.map((ext) => ext.toLowerCase())
			: [""];
	for (const binary of CODING_CLI_BINARIES) {
		for (const dir of dirs) {
			for (const suffix of suffixes) {
				if (await isExecutable(path.join(dir, binary + suffix))) {
					return binary;
				}
			}
		}
	}
	return undefined;
}

export interface CodingDispatchPreflight {
	ok: boolean;
	/** One actionable setup-guidance sentence per missing prerequisite. */
	guidance: string[];
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const fromRuntime = runtime.getSetting?.(key);
	const value =
		typeof fromRuntime === "string" && fromRuntime.trim().length > 0
			? fromRuntime
			: process.env[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

/**
 * Verify the pieces a create/edit dispatch silently depends on BEFORE any
 * scaffolding happens: the agent-orchestrator create-task action and a coding
 * CLI backend. Returns setup guidance for whatever is missing so the action
 * can answer with next steps instead of scaffolding into a dead end.
 */
export async function preflightCodingDispatch(
	runtime: IAgentRuntime,
): Promise<CodingDispatchPreflight> {
	const guidance: string[] = [];

	const hasCreateTask = runtime.actions.some(
		(a) => a.name === "START_CODING_TASK" || a.name === "CREATE_TASK",
	);
	if (!hasCreateTask) {
		guidance.push(
			"The coding-agent orchestrator is not loaded (no START_CODING_TASK action). " +
				"Add @elizaos/plugin-agent-orchestrator to this agent's plugins to enable scaffolding.",
		);
	}

	// An explicit backend pin or custom ACP CLI declares a configured
	// deployment (possibly a managed/remote executor whose CLI is not on THIS
	// process's PATH) — trust it and skip the probe. The probe only guards the
	// unconfigured default, where a local CLI is genuinely required.
	const configured =
		readSetting(runtime, "ELIZA_ACP_DEFAULT_AGENT") ??
		readSetting(runtime, "ELIZA_ACP_CLI");
	if (!configured && !(await findCodingCliOnPath())) {
		guidance.push(
			`No coding-agent CLI was found on PATH (looked for ${CODING_CLI_BINARIES.join(", ")}). ` +
				"Install one and sign in (e.g. `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in), " +
				"or set ELIZA_ACP_DEFAULT_AGENT to a backend that is installed.",
		);
	}

	return { ok: guidance.length === 0, guidance };
}
