/**
 * Live-model APP stop coverage backed by a real TCP API host and AppManager
 * run. The seed launches a synthetic installed app through the production
 * route; the model must select APP stop and leave the run inventory empty.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startApiServer } from "@elizaos/agent/api/server";
import { AgentRuntime } from "@elizaos/core";
import {
	createAppControlClient,
	type AppRunSummary,
} from "@elizaos/plugin-app-control";
import { scenario } from "@elizaos/scenario-runner/schema";

const TEST_APP = "ratchet-proof";
const TEST_PLUGIN = "@test/ratchet-proof";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

let apiServer: ApiServer | null = null;
let fixtureRoot: string | null = null;
const previousEnv = new Map<string, string | undefined>();
const touchedEnv = [
	"ELIZA_API_AUTH_TOKEN",
	"ELIZA_API_BIND_HOST",
	"ELIZA_API_PORT",
	"ELIZA_API_TOKEN",
	"ELIZA_CONFIG_PATH",
	"ELIZA_PERSIST_CONFIG_PATH",
	"ELIZA_PORT",
	"ELIZA_STATE_DIR",
] as const;

function restoreEnvironment(): void {
	for (const key of touchedEnv) {
		const previous = previousEnv.get(key);
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
	previousEnv.clear();
}

async function startRunningApp(runtime: AgentRuntime): Promise<void> {
	if (apiServer || fixtureRoot) {
		throw new Error("app-stop scenario fixture is already running");
	}
	for (const key of touchedEnv) previousEnv.set(key, process.env[key]);

	fixtureRoot = await mkdtemp(path.join(tmpdir(), "eliza-app-stop-scenario-"));
	const stateDir = path.join(fixtureRoot, "state");
	const cacheDir = path.join(stateDir, "cache");
	const configPath = path.join(stateDir, "eliza.json");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(
		configPath,
		JSON.stringify({
			logging: { level: "error" },
			plugins: {
				installs: {
					[TEST_PLUGIN]: {
						source: "npm",
						spec: `${TEST_PLUGIN}@1.0.0`,
						version: "1.0.0",
						installedAt: "2026-07-23T00:00:00.000Z",
					},
				},
			},
		}),
		"utf8",
	);
	await writeFile(
		path.join(cacheDir, "registry.json"),
		JSON.stringify({
			fetchedAt: Date.now(),
			plugins: [
				[
					TEST_APP,
					{
						name: TEST_APP,
						gitRepo: "test/ratchet-proof",
						gitUrl: "https://example.test/ratchet-proof.git",
						directory: null,
						description: "Live APP stop trajectory fixture.",
						homepage: "https://example.test/ratchet-proof",
						topics: ["app", "test"],
						stars: 0,
						language: "TypeScript",
						npm: {
							package: TEST_PLUGIN,
							v0Version: null,
							v1Version: null,
							v2Version: "1.0.0",
						},
						git: {
							v0Branch: null,
							v1Branch: null,
							v2Branch: "main",
						},
						supports: { v0: false, v1: false, v2: true },
						kind: "app",
						appMeta: {
							displayName: "Ratchet Proof",
							category: "tool",
							launchType: "connect",
							launchUrl: "https://example.test/ratchet-proof",
							icon: null,
							heroImage: null,
							capabilities: [],
							minPlayers: null,
							maxPlayers: null,
						},
					},
				],
			],
		}),
		"utf8",
	);

	process.env.ELIZA_STATE_DIR = stateDir;
	process.env.ELIZA_CONFIG_PATH = configPath;
	process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
	process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
	process.env.ELIZA_API_TOKEN = "app-stop-live-scenario-token";
	delete process.env.ELIZA_API_AUTH_TOKEN;
	apiServer = await startApiServer({
		port: 0,
		runtime,
		skipDeferredStartupWork: true,
	});
	process.env.ELIZA_PORT = String(apiServer.port);
	process.env.ELIZA_API_PORT = String(apiServer.port);

	const launch = await createAppControlClient().launchApp(TEST_APP);
	if (!launch.run || launch.run.status !== "running") {
		throw new Error(
			`Expected a running ${TEST_APP} fixture, received ${launch.run?.status ?? "no run"}`,
		);
	}
}

async function assertRunStopped(): Promise<void> {
	const runs: AppRunSummary[] = await createAppControlClient().listAppRuns();
	if (runs.some((run) => run.appName === TEST_APP)) {
		throw new Error(`${TEST_APP} remained in the real AppManager run inventory`);
	}
}

async function assertStoppedAndDisposeFixture(): Promise<void> {
	const activeServer = apiServer;
	const activeRoot = fixtureRoot;
	try {
		await assertRunStopped();
	} finally {
		apiServer = null;
		fixtureRoot = null;
		if (activeServer) await activeServer.close();
		if (activeRoot) await rm(activeRoot, { recursive: true, force: true });
		restoreEnvironment();
	}
}

export default scenario({
	lane: "live-only",
	id: "app-stop",
	title: "APP action stops a running app without relaunching",
	domain: "app-control",
	tags: ["app-control", "app", "stop", "live-route"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	seed: [
		{
			type: "custom",
			name: "launch a real AppManager run through the TCP API",
			apply: async (ctx) => {
				if (!(ctx.runtime instanceof AgentRuntime)) {
					return "scenario runtime is not an AgentRuntime";
				}
				await startRunningApp(ctx.runtime);
			},
		},
	],
	cleanup: [
		{
			type: "custom",
			name: "assert the run stopped, then dispose the API host and state",
			apply: assertStoppedAndDisposeFixture,
		},
	],
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "App Control Stop",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-stops-running-app",
			text: "Stop the Ratchet Proof app. Do not relaunch it.",
			assertTurn: (turn) => {
				const call = turn.actionsCalled.find(
					(action) => action.actionName === "APP",
				);
				if (!call?.result?.success) {
					return `APP stop did not succeed: ${call?.error?.message ?? call?.result?.text ?? "action not called"}`;
				}
				if (call.result.values?.mode !== "stop") {
					return `APP selected mode ${String(call.result.values?.mode)} instead of stop`;
				}
				const stop = call.result.data?.stop;
				if (
					!stop ||
					typeof stop !== "object" ||
					Array.isArray(stop) ||
					!("stopScope" in stop) ||
					stop.stopScope !== "viewer-session"
				) {
					return "APP stop omitted the typed viewer-session result";
				}
			},
		},
	],
	finalChecks: [
		{
			type: "selectedAction",
			actionName: "APP",
		},
		{
			type: "selectedActionArguments",
			actionName: "APP",
			includesAll: [/stop/i, /ratchet-proof|Ratchet Proof/i],
		},
		{
			type: "actionCalled",
			actionName: "APP",
			status: "success",
			minCount: 1,
		},
	],
});
