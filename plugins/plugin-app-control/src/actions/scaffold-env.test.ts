import {
	chmodSync,
	existsSync,
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

	it("guides to the orchestrator plugin when START_CODING_TASK is missing", async () => {
		process.env.PATH = fakeCliDir("claude");
		const result = await preflightCodingDispatch(stubRuntime(["REPLY"]));
		expect(result.ok).toBe(false);
		expect(result.guidance.join(" ")).toContain(
			"@elizaos/plugin-agent-orchestrator",
		);
	});

	it("guides to CLI install + login when no coding CLI is on PATH", async () => {
		process.env.PATH = tempDir("empty-path-");
		const result = await preflightCodingDispatch(
			stubRuntime(["START_CODING_TASK"]),
		);
		expect(result.ok).toBe(false);
		expect(result.guidance.join(" ")).toContain("claude, codex, opencode");
		expect(result.guidance.join(" ")).toContain("log in");
	});

	it("reports both problems at once", async () => {
		process.env.PATH = tempDir("empty-path-");
		const result = await preflightCodingDispatch(stubRuntime([]));
		expect(result.ok).toBe(false);
		expect(result.guidance).toHaveLength(2);
	});

	it("skips the CLI probe when a backend is explicitly configured", async () => {
		process.env.PATH = tempDir("empty-path-");
		for (const settings of [
			{ ELIZA_ACP_DEFAULT_AGENT: "elizaos" },
			{ ELIZA_ACP_DEFAULT_AGENT: "claude" },
			{ ELIZA_ACP_CLI: "/opt/custom/acpx" },
		]) {
			const result = await preflightCodingDispatch(
				stubRuntime(["START_CODING_TASK"], settings),
			);
			expect(result.ok).toBe(true);
		}
	});
});
