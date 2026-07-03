/**
 * VIEWS create from a packaged install (no monorepo checkout at repoRoot).
 *
 * Before the scaffold-env fallbacks, this flow dead-ended with
 * "min-plugin template not found (tried: <repoRoot>/packages/...)" the moment
 * the agent ran outside an elizaOS checkout (packaged desktop install, wrong
 * cwd). These tests drive the real runViewsCreate handler end to end against
 * an empty repoRoot: the template must resolve from the installed `elizaos`
 * package, the plugin must land in <stateDir>/plugins, and missing
 * orchestrator/CLI prerequisites must answer with setup guidance BEFORE
 * anything is scaffolded.
 */

import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { runViewsCreate } from "./views-create";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
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

function fakeCliOnPath(): void {
	const dir = tempDir("fake-cli-");
	const file = path.join(dir, "claude");
	writeFileSync(file, "#!/bin/sh\nexit 0\n");
	chmodSync(file, 0o755);
	// Keep git reachable for the best-effort pre-edit snapshot.
	process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
}

function stubRuntime({
	withOrchestrator,
	dispatched,
}: {
	withOrchestrator: boolean;
	dispatched: Array<Record<string, unknown>>;
}): IAgentRuntime {
	const actions = withOrchestrator
		? [
				{
					name: "START_CODING_TASK",
					handler: async (
						_runtime: unknown,
						_message: Memory,
						_state: unknown,
						options?: HandlerOptions,
					) => {
						const parameters = (options?.parameters ?? {}) as Record<
							string,
							unknown
						>;
						dispatched.push(parameters);
						const validator = parameters.validator as
							| { params?: { workdir?: string } }
							| undefined;
						return {
							success: true,
							text: "started",
							data: {
								agents: [
									{
										sessionId: "sess-1",
										agentType: "claude",
										workdir: validator?.params?.workdir ?? "/tmp",
										label: String(parameters.label ?? "label"),
										status: "running",
									},
								],
							},
						};
					},
				},
			]
		: [];
	return {
		agentId: AGENT_ID,
		actions,
		getSetting: () => undefined,
		getTasks: async () => [],
		createTask: async () => ({}),
		deleteTask: async () => {},
		useModel: async () => {
			throw new Error("no model in test");
		},
	} as unknown as IAgentRuntime;
}

function message(text: string): Memory {
	return {
		entityId: AGENT_ID,
		roomId: "room-1",
		agentId: AGENT_ID,
		content: { text },
	} as unknown as Memory;
}

describe("runViewsCreate from a packaged install", () => {
	it("scaffolds from the installed elizaos template into <stateDir>/plugins and dispatches", async () => {
		const packagedRoot = tempDir("packaged-install-");
		const stateDir = tempDir("state-");
		process.env.ELIZA_STATE_DIR = stateDir;
		fakeCliOnPath();

		const dispatched: Array<Record<string, unknown>> = [];
		const texts: string[] = [];
		const result = await runViewsCreate({
			runtime: stubRuntime({ withOrchestrator: true, dispatched }),
			message: message("build me a crypto price ticker view"),
			views: [],
			callback: async (c) => {
				texts.push(String(c.text));
				return [];
			},
			repoRoot: packagedRoot,
		});

		expect(result.success).toBe(true);
		const workdir = String(result.values?.workdir);
		expect(workdir.startsWith(path.join(stateDir, "plugins"))).toBe(true);
		// The min-plugin template really landed, with placeholders rewritten.
		const pkg = JSON.parse(
			readFileSync(path.join(workdir, "package.json"), "utf8"),
		);
		expect(pkg.name).not.toContain("__PLUGIN_NAME__");
		expect(existsSync(path.join(workdir, "SCAFFOLD.md"))).toBe(true);
		// The coding agent was dispatched against that workdir.
		expect(dispatched).toHaveLength(1);
		expect(String(dispatched[0].task)).toContain(`sourceDir: ${workdir}`);
		expect(texts.join("\n")).toContain("Started view create task");
	});

	it("answers with setup guidance and scaffolds nothing when the orchestrator is missing", async () => {
		const packagedRoot = tempDir("packaged-install-");
		const stateDir = tempDir("state-");
		process.env.ELIZA_STATE_DIR = stateDir;
		fakeCliOnPath();

		const texts: string[] = [];
		const result = await runViewsCreate({
			runtime: stubRuntime({ withOrchestrator: false, dispatched: [] }),
			message: message("build me a crypto price ticker view"),
			views: [],
			callback: async (c) => {
				texts.push(String(c.text));
				return [];
			},
			repoRoot: packagedRoot,
		});

		expect(result.success).toBe(false);
		const combined = texts.join("\n");
		expect(combined).toContain("@elizaos/plugin-agent-orchestrator");
		expect(combined).not.toContain("template not found");
		// Preflight failed BEFORE scaffolding: nothing landed anywhere.
		expect(existsSync(path.join(stateDir, "plugins"))).toBe(false);
		expect(readdirSync(packagedRoot)).toEqual([]);
	});
});
