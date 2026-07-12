/**
 * Live-model APP list coverage backed by the real agent HTTP host and app
 * manager, so the action's loopback client exercises production routes.
 */

import { startApiServer } from "@elizaos/agent/api/server";
import { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

let apiServer: ApiServer | null = null;
let previousElizaPort: string | undefined;

async function startRealAppApi(runtime: AgentRuntime): Promise<void> {
	if (apiServer) {
		throw new Error("app-list scenario API server is already running");
	}
	previousElizaPort = process.env.ELIZA_PORT;
	apiServer = await startApiServer({
		port: 0,
		runtime,
		skipDeferredStartupWork: true,
	});
	process.env.ELIZA_PORT = String(apiServer.port);
}

async function stopRealAppApi(): Promise<void> {
	const activeServer = apiServer;
	apiServer = null;
	if (previousElizaPort === undefined) {
		delete process.env.ELIZA_PORT;
	} else {
		process.env.ELIZA_PORT = previousElizaPort;
	}
	previousElizaPort = undefined;
	if (activeServer) {
		await activeServer.close();
	}
}

export default scenario({
  lane: "live-only",
	id: "app-list",
	title: "APP action list sub-mode reports installed and running apps",
	domain: "app-control",
	tags: ["app-control", "app", "list"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	seed: [
		{
			type: "custom",
			name: "start the real agent API host for app routes",
			apply: async (ctx) => {
				if (!(ctx.runtime instanceof AgentRuntime)) {
					return "scenario runtime is not an AgentRuntime";
				}
				await startRealAppApi(ctx.runtime);
			},
		},
	],
	cleanup: [
		{
			type: "custom",
			name: "stop the real agent API host",
			apply: stopRealAppApi,
		},
	],
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "App Control List",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-list",
			text: "show me the apps",
			assertTurn: (turn) => {
				const call = turn.actionsCalled.find(
					(action) => action.actionName === "APP",
				);
				if (!call?.result?.success) {
					return `APP list did not succeed: ${call?.error?.message ?? call?.result?.text ?? "action not called"}`;
				}
				const data = call.result.data;
				if (!data || typeof data !== "object" || Array.isArray(data)) {
					return "APP list result omitted structured data";
				}
				if (!Array.isArray(data.installed) || !Array.isArray(data.runs)) {
					return "APP list result omitted installed or running app arrays";
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
			includesAll: [/list/i],
		},
		{
			type: "actionCalled",
			actionName: "APP",
			status: "success",
			minCount: 1,
		},
	],
});
