/**
 * Scaffold environment tests for template discovery and coding-dispatch preflight.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	findCodingCliOnPath,
	hasVendoredOpencodeShim,
	preflightCodingDispatch,
	resolvePluginScaffoldBaseDir,
	resolveScaffoldTemplateDir,
	templateMissingGuidance,
} from "./scaffold-env";

/** Monorepo checkout root (this file lives in plugins/plugin-app-control/src/actions). */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** A PATH dir containing a single executable fake coding CLI. */
function fakeCliDir(binary: string): string {
	const dir = tempDir("fake-cli-");
	const file = path.join(dir, binary);
	writeFileSync(file, "#!/bin/sh\nexit 0\n");
	chmodSync(file, 0o755);
	return dir;
}

/**
 * A root that holds the orchestrator's vendored opencode shim
 * (`plugins/plugin-agent-orchestrator/bin/opencode[.cmd]`), as the shim
 * detector expects to find it.
 */
function fakeShimRoot(): string {
	const root = tempDir("shim-root-");
	const binDir = path.join(root, "plugins", "plugin-agent-orchestrator", "bin");
	mkdirSync(binDir, { recursive: true });
	const executable = process.platform === "win32" ? "opencode.cmd" : "opencode";
	writeFileSync(path.join(binDir, executable), "#!/bin/sh\nexit 0\n");
	return root;
}

/** Preflight option that disables the vendored-shim seam (packaged install). */
const NO_SHIM = { shimRoots: [] as string[] } as const;

const savedPath = process.env.PATH;
const savedStateDir = process.env.ELIZA_STATE_DIR;

afterEach(() => {
	process.env.PATH = savedPath;
	if (savedStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
	else process.env.ELIZA_STATE_DIR = savedStateDir;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function stubRuntime(
	actionNames: string[],
	settings: Record<string, string> = {},
): IAgentRuntime {
	return {
		actions: actionNames.map((name) => ({ name })),
		getSetting: (key: string) => settings[key],
	} as unknown as IAgentRuntime;
}

describe("resolveScaffoldTemplateDir", () => {
	it("resolves min-plugin from a repo checkout", async () => {
		const { dir } = await resolveScaffoldTemplateDir(REPO_ROOT, "min-plugin");
		expect(dir).toBe(
			path.join(REPO_ROOT, "packages/elizaos/templates/min-plugin"),
		);
	});

	it("falls back to the installed elizaos package outside a checkout", async () => {
		const packagedRoot = tempDir("packaged-install-");
		const { dir, tried } = await resolveScaffoldTemplateDir(
			packagedRoot,
			"min-plugin",
		);
		expect(dir).toBeDefined();
		expect(dir?.startsWith(packagedRoot)).toBe(false);
		expect(dir?.endsWith(path.join("templates", "min-plugin"))).toBe(true);
		expect(existsSync(path.join(dir as string, "package.json"))).toBe(true);
		// Both repo candidates were tried first.
		expect(tried.length).toBeGreaterThanOrEqual(3);
	});

	it("resolves min-project the same way", async () => {
		const packagedRoot = tempDir("packaged-install-");
		const { dir } = await resolveScaffoldTemplateDir(
			packagedRoot,
			"min-project",
		);
		expect(dir?.endsWith(path.join("templates", "min-project"))).toBe(true);
	});
});

describe("templateMissingGuidance", () => {
	it("names the template, tried paths, and both fixes", () => {
		const text = templateMissingGuidance("min-plugin", ["/a", "/b"]);
		expect(text).toContain("min-plugin");
		expect(text).toContain("/a, /b");
		expect(text).toContain("ELIZA_REPO_ROOT");
		expect(text).toContain("elizaos");
	});
});

describe("resolvePluginScaffoldBaseDir", () => {
	it("uses the checkout plugins/ dir when present", async () => {
		expect(await resolvePluginScaffoldBaseDir(REPO_ROOT)).toBe(
			path.join(REPO_ROOT, "plugins"),
		);
	});

	it("falls back to <stateDir>/plugins for packaged installs", async () => {
		const packagedRoot = tempDir("packaged-install-");
		const stateDir = tempDir("state-");
		process.env.ELIZA_STATE_DIR = stateDir;
		const base = await resolvePluginScaffoldBaseDir(packagedRoot);
		expect(base).toBe(path.join(stateDir, "plugins"));
		expect(existsSync(base)).toBe(true);
	});
});

describe("findCodingCliOnPath", () => {
	it("finds a coding CLI on PATH", async () => {
		process.env.PATH = fakeCliDir("claude");
		expect(await findCodingCliOnPath()).toBe("claude");
	});

	it("returns undefined when no coding CLI is installed", async () => {
		process.env.PATH = tempDir("empty-path-");
		expect(await findCodingCliOnPath()).toBeUndefined();
	});
});

describe("preflightCodingDispatch", () => {
	it("passes with the orchestrator action and a CLI on PATH", async () => {
		process.env.PATH = fakeCliDir("codex");
		const result = await preflightCodingDispatch(
			stubRuntime(["START_CODING_TASK"]),
		);
		expect(result.ok).toBe(true);
		expect(result.guidance).toEqual([]);
	});

	it("passes when the orchestrator exposes TASKS with delegation tags", async () => {
		process.env.PATH = fakeCliDir("codex");
		const runtime = stubRuntime(["TASKS"]);
		runtime.actions[0].tags = [
			"domain:coding",
			"resource:agent-task",
			"capability:delegate",
		];

		const result = await preflightCodingDispatch(runtime);

		expect(result.ok).toBe(true);
		expect(result.guidance).toEqual([]);
	});

	it("guides to the orchestrator plugin when START_CODING_TASK is missing", async () => {
		process.env.PATH = fakeCliDir("claude");
		const result = await preflightCodingDispatch(stubRuntime(["REPLY"]));
		expect(result.ok).toBe(false);
		expect(result.guidance.join(" ")).toContain(
			"@elizaos/plugin-agent-orchestrator",
		);
	});

	it("guides to backend install + login when no backend is on PATH", async () => {
		process.env.PATH = tempDir("empty-path-");
		const result = await preflightCodingDispatch(
			stubRuntime(["START_CODING_TASK"]),
			NO_SHIM,
		);
		expect(result.ok).toBe(false);
		// The "not found" message names the real backend set, including the
		// orchestrator's DEFAULT `eliza-code-acp`.
		expect(result.guidance.join(" ")).toContain(
			"eliza-code-acp, pi-agent, claude, codex, opencode",
		);
		expect(result.guidance.join(" ")).toContain("log in");
	});

	it("reports both problems at once", async () => {
		process.env.PATH = tempDir("empty-path-");
		const result = await preflightCodingDispatch(stubRuntime([]), NO_SHIM);
		expect(result.ok).toBe(false);
		expect(result.guidance).toHaveLength(2);
	});

	it("treats the orchestrator DEFAULT backend (eliza-code-acp) as available with no config and no third-party CLI", async () => {
		// The stock deployment case #11927 regressed: default backend on PATH,
		// ELIZA_ACP_DEFAULT_AGENT unset, and none of claude/codex/opencode
		// present. This must NOT block.
		process.env.PATH = fakeCliDir("eliza-code-acp");
		const result = await preflightCodingDispatch(
			stubRuntime(["START_CODING_TASK"]),
			NO_SHIM,
		);
		expect(result.ok).toBe(true);
		expect(result.guidance).toEqual([]);
	});

	it("treats the native pi-agent backend on PATH as available", async () => {
		process.env.PATH = fakeCliDir("pi-agent");
		const result = await preflightCodingDispatch(
			stubRuntime(["START_CODING_TASK"]),
			NO_SHIM,
		);
		expect(result.ok).toBe(true);
	});

	it("treats the vendored opencode shim as an available backend on an empty PATH", async () => {
		process.env.PATH = tempDir("empty-path-");
		const shimRoot = fakeShimRoot();
		const result = await preflightCodingDispatch(
			stubRuntime(["START_CODING_TASK"]),
			{ shimRoots: [shimRoot] },
		);
		expect(result.ok).toBe(true);
	});

	it("skips the local probe when a backend is explicitly configured", async () => {
		process.env.PATH = tempDir("empty-path-");
		for (const settings of [
			{ ELIZA_ACP_DEFAULT_AGENT: "elizaos" },
			{ ELIZA_DEFAULT_AGENT_TYPE: "codex" },
			{ ELIZA_ACP_CLI: "/opt/custom/acpx" },
			{ ELIZA_ELIZAOS_ACP_COMMAND: "/opt/eliza-code-acp" },
			{ ELIZA_PI_AGENT_ACP_COMMAND: "/opt/pi-agent" },
		]) {
			const result = await preflightCodingDispatch(
				stubRuntime(["START_CODING_TASK"], settings),
				NO_SHIM,
			);
			expect(result.ok).toBe(true);
		}
	});
});

describe("hasVendoredOpencodeShim", () => {
	it("finds the shim under a candidate root", () => {
		expect(hasVendoredOpencodeShim([fakeShimRoot()])).toBe(true);
	});

	it("returns false when no candidate root holds the shim", () => {
		expect(hasVendoredOpencodeShim([tempDir("no-shim-")])).toBe(false);
	});

	it("returns false for an empty root list", () => {
		expect(hasVendoredOpencodeShim([])).toBe(false);
	});
});
