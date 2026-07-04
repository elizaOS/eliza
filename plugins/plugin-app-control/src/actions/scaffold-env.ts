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

import { existsSync, promises as fs, constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { findCodingDelegationActionName, resolveStateDir } from "@elizaos/core";

/** Templates published by the `elizaos` package under `templates/`. */
export type ScaffoldTemplateId = "min-plugin" | "min-project";

/** Repo-root-relative dirs that contain the scaffold templates. */
const TEMPLATE_REPO_PARENTS = [
	"packages/elizaos/templates",
	"eliza/packages/elizaos/templates",
] as const;

/** Repo-root-relative dirs where new plugins land in a checkout. */
const PLUGINS_DIR_CANDIDATES = ["eliza/plugins", "plugins"] as const;

/**
 * Coding-backend binaries the ACP layer can drive, probed on PATH by the
 * preflight. Mirrors the per-adapter binaries in `hasFrameworkBinary`
 * (@elizaos/plugin-agent-orchestrator): the orchestrator's DEFAULT backend is
 * `elizaos`, whose binary is `eliza-code-acp`; `pi-agent` is the native Pi
 * backend; then the third-party CLIs claude / codex / opencode. Probing only
 * the last three (the old behavior) falsely blocked stock deployments running
 * on the default `elizaos` backend.
 */
const CODING_CLI_BINARIES = [
	"eliza-code-acp",
	"pi-agent",
	"claude",
	"codex",
	"opencode",
] as const;

/**
 * Env keys that declare a configured coding backend. The first three pin or
 * alias the default agent type (`ELIZA_ACP_DEFAULT_AGENT` and its alias
 * `ELIZA_DEFAULT_AGENT_TYPE`, plus the custom-CLI pin `ELIZA_ACP_CLI`); the
 * last two point at a native ACP command for the elizaos / pi-agent adapters.
 * When any is set the deployment has chosen a backend — possibly a
 * managed/remote executor whose binary is not on THIS host's PATH — so the
 * preflight trusts it and skips the local probe. Mirrors
 * `configuredDefaultAgentType` + the env branches of `hasFrameworkBinary` in
 * @elizaos/plugin-agent-orchestrator.
 */
const CONFIGURED_BACKEND_ENV_KEYS = [
	"ELIZA_ACP_DEFAULT_AGENT",
	"ELIZA_DEFAULT_AGENT_TYPE",
	"ELIZA_ACP_CLI",
	"ELIZA_ELIZAOS_ACP_COMMAND",
	"ELIZA_PI_AGENT_ACP_COMMAND",
] as const;

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

/**
 * Roots searched for the orchestrator's vendored opencode shim: every ancestor
 * of the cwd and of this module. Mirrors `candidateRoots` behind
 * `resolveVendoredOpencodeShim` in @elizaos/plugin-agent-orchestrator.
 */
function vendoredOpencodeShimRoots(): string[] {
	const roots = new Set<string>();
	const walkUp = (start: string): void => {
		let current = path.resolve(start);
		while (!roots.has(current)) {
			roots.add(current);
			const next = path.dirname(current);
			if (next === current) break;
			current = next;
		}
	};
	walkUp(process.cwd());
	walkUp(path.dirname(fileURLToPath(import.meta.url)));
	return [...roots];
}

/**
 * Whether the orchestrator's vendored opencode shim is present on disk — a
 * usable coding backend in a checkout even when no CLI is on PATH. Mirrors
 * `resolveVendoredOpencodeShim` (@elizaos/plugin-agent-orchestrator), which
 * looks for `plugins/plugin-agent-orchestrator/bin/opencode` under any ancestor
 * of the cwd or module dir. The `roots` seam lets tests exercise the
 * packaged-install case where no shim exists.
 */
export function hasVendoredOpencodeShim(
	roots: string[] = vendoredOpencodeShimRoots(),
): boolean {
	const executable = process.platform === "win32" ? "opencode.cmd" : "opencode";
	return roots.some((root) =>
		existsSync(
			path.join(
				root,
				"plugins",
				"plugin-agent-orchestrator",
				"bin",
				executable,
			),
		),
	);
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

export interface CodingDispatchPreflightOptions {
	/**
	 * Override the roots searched for the vendored opencode shim. Tests pass an
	 * empty (or shim-free) list to exercise the packaged-install path where no
	 * backend is present; production leaves it unset to walk the real tree.
	 */
	shimRoots?: string[];
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
	options: CodingDispatchPreflightOptions = {},
): Promise<CodingDispatchPreflight> {
	const guidance: string[] = [];

	const hasCreateTask = Boolean(
		findCodingDelegationActionName(runtime.actions ?? []),
	);
	if (!hasCreateTask) {
		guidance.push(
			"The coding-agent orchestrator is not loaded (no coding delegation action). " +
				"Add @elizaos/plugin-agent-orchestrator to this agent's plugins to enable scaffolding.",
		);
	}

	// A coding backend is available when ANY of:
	//  (a) a backend is explicitly configured — a pinned/aliased default agent,
	//      a custom ACP CLI, or a native ACP command (possibly a managed/remote
	//      executor whose binary is not on THIS process's PATH); trust it;
	//  (b) one of the orchestrator's backend binaries — including the DEFAULT
	//      `eliza-code-acp` — is on PATH; or
	//  (c) the orchestrator's vendored opencode shim is present (checkout).
	// Only when none of these hold is a local backend genuinely missing.
	const configured = CONFIGURED_BACKEND_ENV_KEYS.some((key) =>
		readSetting(runtime, key),
	);
	const backendAvailable =
		configured ||
		Boolean(await findCodingCliOnPath()) ||
		hasVendoredOpencodeShim(options.shimRoots);
	if (!backendAvailable) {
		guidance.push(
			`No coding-agent backend was found on PATH (looked for ${CODING_CLI_BINARIES.join(", ")}). ` +
				"Install one and sign in (e.g. `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in), " +
				"or set ELIZA_ACP_DEFAULT_AGENT to a backend that is installed.",
		);
	}

	return { ok: guidance.length === 0, guidance };
}
