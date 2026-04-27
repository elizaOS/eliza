/**
 * End-to-end load + unload of the app-counter app through the unified APP
 * action, against a mocked AppControlClient (so the dashboard server
 * doesn't need to be running).
 *
 * The contract under test: an action handler must NEVER throw an
 * uncaught exception. Throwing kills the planner turn and effectively
 * crashes the agent's response cycle. So we drive the action through:
 *
 *   1. mode=list                  → counter app present in the catalog
 *   2. mode=launch  (counter)     → returns an AppRunSummary, no throw
 *   3. mode=list                  → run now appears as "running"
 *   4. mode=relaunch (counter)    → stops + relaunches, no throw
 *   5. mode=launch  (unknown)     → handler returns success:false, no throw
 *   6. mode=list                  → runtime still responsive after error
 *
 * After every step we assert the runtime is still responsive (i.e. the
 * previous handler returned cleanly) by inspecting the ActionResult shape.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HandlerCallback } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { AppControlClient } from "../../client/api.js";
import type {
	AppLaunchResult,
	AppRunSummary,
	AppStopResult,
	InstalledAppInfo,
} from "../../types.js";
import { createAppAction } from "../app.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COUNTER_WORKDIR = path.resolve(
	HERE,
	"..",
	"..",
	"..",
	"..",
	"..",
	"..",
	"..",
	"apps",
	"app-counter",
);

const COUNTER: InstalledAppInfo = {
	name: "app-counter",
	displayName: "Counter",
	pluginName: "app-counter",
	version: "0.0.0",
	installedAt: new Date().toISOString(),
};

function freshRun(name: string, runId: string): AppRunSummary {
	const now = new Date().toISOString();
	return {
		runId,
		appName: name,
		displayName: COUNTER.displayName,
		pluginName: COUNTER.pluginName,
		launchType: "iframe",
		launchUrl: "http://127.0.0.1:5173/",
		status: "running",
		summary: null,
		startedAt: now,
		updatedAt: now,
		lastHeartbeatAt: now,
	};
}

function stopResult(runId: string | null, success: boolean): AppStopResult {
	return {
		success,
		appName: COUNTER.name,
		runId,
		stoppedAt: new Date().toISOString(),
		pluginUninstalled: false,
		needsRestart: false,
		stopScope: success ? "viewer-session" : "no-op",
		message: success ? "Stopped" : "No matching run",
	};
}

function makeMockClient(): {
	client: AppControlClient;
	runs: AppRunSummary[];
	ledger: string[];
} {
	const runs: AppRunSummary[] = [];
	const ledger: string[] = [];
	let nextRunId = 1;

	const client: AppControlClient = {
		async listInstalledApps() {
			ledger.push("listInstalledApps");
			return [COUNTER];
		},
		async listAppRuns() {
			ledger.push(`listAppRuns(${runs.length})`);
			return [...runs];
		},
		async launchApp(name) {
			ledger.push(`launchApp(${name})`);
			if (name !== COUNTER.name) throw new Error(`unknown app: ${name}`);
			const runId = `run-${nextRunId++}`;
			const run = freshRun(name, runId);
			runs.push(run);
			const result: AppLaunchResult = {
				pluginInstalled: true,
				needsRestart: false,
				displayName: COUNTER.displayName,
				launchType: run.launchType,
				launchUrl: run.launchUrl,
				run,
			};
			return result;
		},
		async stopAppRun(runId) {
			ledger.push(`stopAppRun(${runId})`);
			const idx = runs.findIndex((r) => r.runId === runId);
			if (idx >= 0) runs.splice(idx, 1);
			return stopResult(runId, idx >= 0);
		},
		async stopAppByName(name) {
			ledger.push(`stopAppByName(${name})`);
			const removed = runs.filter((r) => r.appName === name);
			for (const r of removed) {
				const idx = runs.findIndex((x) => x.runId === r.runId);
				if (idx >= 0) runs.splice(idx, 1);
			}
			return stopResult(null, removed.length > 0);
		},
	};

	return { client, runs, ledger };
}

function makeRuntime() {
	return {
		agentId: "agent-test",
		actions: [],
		getTasks: async () => [],
		createTask: async () => "task-id",
		deleteTask: async () => true,
		getMemories: async () => [],
		logger: {
			info: (..._args: any[]) => {},
			warn: (..._args: any[]) => {},
			error: (..._args: any[]) => {},
			debug: (..._args: any[]) => {},
		},
	};
}

function makeMessage(text: string) {
	return {
		entityId: "agent-test", // matches runtime.agentId so owner gate passes
		roomId: "room-test",
		content: { text },
	};
}

function callbackBag() {
	const messages: { text: string }[] = [];
	const cb: HandlerCallback = async (msg) => {
		messages.push({ text: typeof msg.text === "string" ? msg.text : "" });
		return [];
	};
	return {
		cb,
		messages,
	};
}

describe("APP action — counter load + unload e2e", () => {
	it("walks list → launch → list → relaunch → unknown → list without throwing", async () => {
		const { client, runs, ledger } = makeMockClient();
		const action = createAppAction({ client, repoRoot: COUNTER_WORKDIR });
		const runtime = makeRuntime() as any;

		// 1. mode=list
		let bag = callbackBag();
		let r = await action.handler(
			runtime,
			makeMessage("show running apps") as any,
			undefined,
			{ mode: "list" },
			bag.cb,
		);
		expect(r?.success).toBe(true);
		expect(ledger.some((e) => e.startsWith("listInstalledApps"))).toBe(true);

		// 2. mode=launch app-counter
		bag = callbackBag();
		r = await action.handler(
			runtime,
			makeMessage("launch the counter app") as any,
			undefined,
			{ mode: "launch", name: "app-counter" },
			bag.cb,
		);
		expect(r?.success).toBe(true);
		expect(runs.length).toBe(1);
		expect(runs[0]?.appName).toBe("app-counter");

		// 3. mode=list — run now visible
		bag = callbackBag();
		r = await action.handler(
			runtime,
			makeMessage("show running apps") as any,
			undefined,
			{ mode: "list" },
			bag.cb,
		);
		expect(r?.success).toBe(true);

		// 4. mode=relaunch — stops + relaunches
		bag = callbackBag();
		r = await action.handler(
			runtime,
			makeMessage("relaunch the counter app") as any,
			undefined,
			{ mode: "relaunch", name: "app-counter" },
			bag.cb,
		);
		expect(r?.success).toBe(true);
		expect(runs.length).toBe(1);
		expect(ledger.some((e) => e.startsWith("stopApp"))).toBe(true);

		// 5. mode=launch with unknown app — must NOT throw, must return
		//    success:false so the planner can recover gracefully.
		bag = callbackBag();
		let threw = false;
		try {
			r = await action.handler(
				runtime,
				makeMessage("launch the does-not-exist app") as any,
				undefined,
				{ mode: "launch", name: "does-not-exist" },
				bag.cb,
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(r?.success).toBe(false);

		// 6. final mode=list — runtime is still alive; the previous error path
		//    didn't poison the action / client.
		bag = callbackBag();
		r = await action.handler(
			runtime,
			makeMessage("show running apps") as any,
			undefined,
			{ mode: "list" },
			bag.cb,
		);
		expect(r?.success).toBe(true);
	});

	it("validate gates on owner role (rejects non-owner senders)", async () => {
		const { client } = makeMockClient();
		const action = createAppAction({
			client,
			repoRoot: COUNTER_WORKDIR,
			hasOwnerAccess: async () => false,
		});
		const runtime = makeRuntime() as any;
		const result = await action.validate?.(
			runtime,
			makeMessage("launch the counter app") as any,
		);
		expect(result).toBe(false);
	});

	it("validate accepts owner senders", async () => {
		const { client } = makeMockClient();
		const action = createAppAction({
			client,
			repoRoot: COUNTER_WORKDIR,
			hasOwnerAccess: async () => true,
		});
		const runtime = makeRuntime() as any;
		const result = await action.validate?.(
			runtime,
			makeMessage("launch the counter app") as any,
		);
		expect(result).toBe(true);
	});
});
