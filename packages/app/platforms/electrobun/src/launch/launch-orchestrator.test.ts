/** Classifies launch readiness from the runtime phases each agent host reports. */
import { describe, expect, it } from "vitest";
import type { BootProgressSnapshot, EmbeddedAgentStatus } from "../rpc-schema";
import { LaunchOrchestrator } from "./launch-orchestrator";

const RUNNING_AGENT: EmbeddedAgentStatus = {
	state: "running",
	agentName: "Eliza",
	port: 31339,
	startedAt: 1,
	error: null,
};

function orchestratorFor(bootPhase: string, bootState = "running") {
	const boot: BootProgressSnapshot = {
		state: bootState as BootProgressSnapshot["state"],
		phase: bootPhase,
		lastError: null,
		pluginsLoaded: 33,
		pluginsFailed: 0,
		database: "ok",
		agentName: "Eliza",
		port: 31339,
		startedAt: 1,
		updatedAt: new Date(0).toISOString(),
	};
	return new LaunchOrchestrator({
		agent: {
			getStatus: () => RUNNING_AGENT,
			start: async () => RUNNING_AGENT,
			restart: async () => RUNNING_AGENT,
		},
		readBootProgress: async () => boot,
		readAuthStatus: async () => ({
			required: false,
			pairingEnabled: false,
			expiresAt: null,
		}),
		readFirstRunStatus: async () => ({ complete: true }),
		readDiagnostics: () => ({
			state: "running",
			phase: bootPhase,
			updatedAt: new Date(0).toISOString(),
			lastError: null,
			agentName: "Eliza",
			port: 31339,
			startedAt: 1,
			logPath: "/tmp/eliza-startup.log",
			statusPath: "/tmp/eliza-startup.json",
		}),
		readDiagnosticLogTail: () => "",
		createBugReportBundle: () => {
			throw new Error("not used");
		},
		now: () => new Date(0),
	});
}

describe("LaunchOrchestrator readiness", () => {
	it.each([
		"running",
		"runtime-ready",
		"features-starting",
		"ready",
		"degraded",
	])("reports ready for the serving runtime phase %s", async (phase) => {
		const snapshot = await orchestratorFor(phase).getProgress();
		expect(snapshot.phase).toBe("ready");
		expect(snapshot.boot.runtimePhase).toBe(phase);
	});

	it.each(["api-binding", "api-bound", "runtime-starting"])(
		"keeps waiting while the runtime phase is %s",
		async (phase) => {
			const snapshot = await orchestratorFor(phase).getProgress();
			expect(snapshot.phase).toBe("agent-api-ready");
		},
	);
});
