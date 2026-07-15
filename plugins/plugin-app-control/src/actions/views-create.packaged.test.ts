/**
 * Exercises VIEWS create against packaged templates and state-directory plugin storage.
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
import type { ViewSummary } from "./views-client";
import { runViewsCreate } from "./views-create";
import { locatePluginSourceDir } from "./views-plugin-source";

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
	it("rejects registry plugin names that could escape the source roots", async () => {
		await expect(
			locatePluginSourceDir(tempDir("packaged-install-"), {
				id: "escape",
				label: "Escape",
				pluginName: "@malicious/../../outside",
				viewType: "gui",
			} as ViewSummary),
		).rejects.toMatchObject({
			name: "ElizaError",
			code: "VIEW_PLUGIN_NAME_INVALID",
		});
	});

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
		const index = readFileSync(path.join(workdir, "src/index.ts"), "utf8");
		expect(index).toContain('bundlePath: "dist/views/bundle.js"');
		expect(index).toContain('componentExport: "PluginView"');
		expect(index).toContain('viewKind: "release"');
		const component = readFileSync(
			path.join(workdir, "src/views/PluginView.tsx"),
			"utf8",
		);
		expect(component).toContain("VIEW_SCAFFOLD_MARKER");
		expect(component).toContain("build me a crypto price ticker view");
		expect(
			readFileSync(path.join(workdir, "tests/view-render.test.tsx"), "utf8"),
		).toContain("renderToStaticMarkup(<PluginView />)");
		expect(
			readFileSync(path.join(workdir, "vite.config.views.ts"), "utf8"),
		).toContain('fileName: () => "bundle.js"');
		expect(pkg.scripts.build).toContain(
			"vite build --config vite.config.views.ts",
		);
		await expect(
			locatePluginSourceDir(packagedRoot, {
				id: "crypto-price-ticker",
				label: "Crypto Price Ticker",
				pluginName: pkg.name,
				viewType: "gui",
			} as ViewSummary),
		).resolves.toBe(workdir);
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
