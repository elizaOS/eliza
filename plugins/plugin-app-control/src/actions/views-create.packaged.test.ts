/**
 * Exercises VIEWS create, generated builds and rendered registered components.
 * Build/test commands reuse workspace dependencies, not a clean installation.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
		const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
		const modules = path.join(workdir, "node_modules");
		for (const dependency of Object.keys({
			...pkg.dependencies,
			...pkg.devDependencies,
		})) {
			const target = path.join(modules, dependency);
			mkdirSync(path.dirname(target), { recursive: true });
			symlinkSync(
				path.join(repoRoot, "node_modules", dependency),
				target,
				"junction",
			);
		}
		const execution = {
			cwd: workdir,
			env: {
				...process.env,
				PATH: `${path.join(repoRoot, "plugins/plugin-app-control/node_modules/.bin")}${path.delimiter}${process.env.PATH}`,
			},
			encoding: "utf8" as const,
			timeout: 60_000,
		};
		for (const script of ["build", "test"])
			execFileSync("bun", ["run", script], execution);
		const rendered = JSON.parse(
			execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
			import plugin from "./dist/index.js";
			import { createElement } from "react";
			import { renderToStaticMarkup } from "react-dom/server";
			const view = plugin.views[0];
			const bundle = await import("./" + view.bundlePath);
			const html = renderToStaticMarkup(createElement(bundle[view.componentExport]));
			process.stdout.write(JSON.stringify({ name: plugin.name, view, html }));
		`,
				],
				execution,
			),
		);
		expect(rendered).toMatchObject({
			name: pkg.name,
			view: {
				id: result.values?.name,
				viewKind: "release",
				modalities: ["gui"],
			},
		});
		expect(rendered.html).toContain(
			`data-eliza-view-id="${result.values?.name}"`,
		);
		expect(rendered.html).toContain("build me a crypto price ticker view");
		expect(rendered.html).toContain(
			`eliza-view-scaffold:${result.values?.name}`,
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
		// Human-voiced dispatch message (single-delivery contract).
		expect(texts.join("\n")).toContain("view now");
	}, 60_000);

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
