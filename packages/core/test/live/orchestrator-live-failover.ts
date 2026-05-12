import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import type { SwarmCoordinator } from "@elizaos/plugin-agent-orchestrator";
import { PTYService } from "@elizaos/plugin-agent-orchestrator";
import { elizaOSCloudPlugin } from "@elizaos/plugin-elizacloud";
import { createTestRuntime } from "../helpers/pglite-runtime.ts";

async function waitFor(
	predicate: () => Promise<boolean>,
	message: string,
	timeoutMs = 10 * 60_000,
	intervalMs = 1_000,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(message);
}

const PRIMARY_FRAMEWORK =
	(process.env.ORCHESTRATOR_LIVE_PRIMARY as "claude" | "codex" | undefined) ??
	"claude";
const FALLBACK_FRAMEWORK =
	(process.env.ORCHESTRATOR_LIVE_FALLBACK as "claude" | "codex" | undefined) ??
	(PRIMARY_FRAMEWORK === "claude" ? "codex" : "claude");
const USE_REAL_PRIMARY_FAILURE =
	process.env.ORCHESTRATOR_LIVE_REAL_PRIMARY_FAILURE === "1";
const KEEP_ARTIFACTS = process.env.ELIZA_KEEP_LIVE_ARTIFACTS === "1";

type AppConfig = {
	cloud?: {
		apiKey?: string;
	};
};

function loadCloudApiKey(): string {
	const fromEnv = process.env.ELIZAOS_CLOUD_API_KEY?.trim();
	if (fromEnv) {
		return fromEnv;
	}

	const configPath = path.join(os.homedir(), ".eliza", "eliza.json");
	const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as AppConfig;
	const fromConfig = parsed.cloud?.apiKey?.trim();
	if (!fromConfig) {
		throw new Error(
			"ELIZAOS_CLOUD_API_KEY is not configured in the environment or ~/.eliza/eliza.json",
		);
	}
	return fromConfig;
}

let runtime: AgentRuntime | undefined;
let cleanupRuntime: (() => Promise<void>) | undefined;
let service: PTYService | undefined;
const sessionsToStop = new Set<string>();
let workdir: string | undefined;

async function cleanup(): Promise<void> {
	if (service) {
		for (const sessionId of sessionsToStop) {
			try {
				await service.stopSession(sessionId, true);
			} catch {}
		}
	}

	try {
		await service?.stop();
	} catch {}

	try {
		await cleanupRuntime?.();
	} catch {}

	if (workdir) {
		if (KEEP_ARTIFACTS) {
			console.log(
				"[orchestrator-live-failover] preserving artifacts",
				JSON.stringify({ workdir }),
			);
		} else {
			fs.rmSync(workdir, { recursive: true, force: true });
		}
	}
}

async function main(): Promise<void> {
	process.env.ELIZAOS_CLOUD_API_KEY = loadCloudApiKey();
	({ runtime, cleanup: cleanupRuntime } = await createTestRuntime({
		plugins: [elizaOSCloudPlugin],
	}));
	service = await PTYService.start(runtime);
	(runtime.services as Map<string, unknown[]>).set("PTY_SERVICE", [
		service as unknown,
	]);

	const coordinator = service.coordinator as SwarmCoordinator | null;
	assert.ok(coordinator, "Expected PTYService to wire a SwarmCoordinator");
	coordinator.setSupervisionLevel("autonomous");

	const preflight = await service.checkAvailableAgents([
		PRIMARY_FRAMEWORK,
		FALLBACK_FRAMEWORK,
	]);
	assert.equal(
		preflight.length,
		2,
		"Expected live failover preflight to return both primary and fallback frameworks",
	);
	assert.ok(
		preflight.every((entry) => entry.installed),
		"Expected both live failover frameworks to be installed",
	);

	workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-live-failover-"));
	const outputFile = path.join(workdir, "failover-proof.txt");
	const sentinel = `LIVE_FAILOVER_${Date.now()}`;
	const thread = await coordinator.createTaskThread({
		title: "Live provider failover proof",
		originalRequest: `Create ${path.basename(outputFile)} containing exactly ${sentinel}.`,
		kind: "coding",
		metadata: {
			source: "orchestrator-live-failover",
			primaryFramework: PRIMARY_FRAMEWORK,
			fallbackFramework: FALLBACK_FRAMEWORK,
		},
	});

	service.onSessionEvent((sessionId, event, data) => {
		if (
			event === "blocked" ||
			event === "task_complete" ||
			event === "error" ||
			event === "login_required"
		) {
			console.log(
				"[orchestrator-live-failover:event]",
				JSON.stringify({
					sessionId,
					event,
					data,
				}),
			);
		}
	});

	const primarySession = await service.spawnSession({
		name: `live-failover-${PRIMARY_FRAMEWORK}`,
		agentType: PRIMARY_FRAMEWORK,
		workdir,
		...(USE_REAL_PRIMARY_FAILURE
			? {
					initialTask: `Create ${path.basename(outputFile)} in the current directory containing exactly "${sentinel}". Then explain how you verified it.`,
				}
			: {}),
		skipAdapterAutoResponse: true,
		metadata: {
			threadId: thread.id,
			requestedType: PRIMARY_FRAMEWORK,
			label: "live-failover-primary",
		},
	});
	sessionsToStop.add(primarySession.id);

	await coordinator.registerTask(primarySession.id, {
		threadId: thread.id,
		agentType: PRIMARY_FRAMEWORK,
		label: "live-failover-primary",
		originalTask: `Create ${path.basename(outputFile)} in the current directory containing exactly "${sentinel}". Then explain how you verified it.`,
		workdir,
		metadata:
			primarySession.metadata &&
			typeof primarySession.metadata === "object" &&
			!Array.isArray(primarySession.metadata)
				? (primarySession.metadata as Record<string, unknown>)
				: undefined,
	});

	await new Promise((resolve) => setTimeout(resolve, 5_000));

	if (USE_REAL_PRIMARY_FAILURE) {
		console.log(
			"[orchestrator-live-failover] waiting for real primary provider depletion",
			JSON.stringify({ primaryFramework: PRIMARY_FRAMEWORK }),
		);
	} else {
		await coordinator.handleSessionEvent(primarySession.id, "error", {
			message: "insufficient credits",
		});
	}

	let replacementSessionId = "";
	await waitFor(async () => {
		const detail = await coordinator.getTaskThread(thread.id);
		const replacementSession = detail?.sessions.find(
			(session) =>
				session.sessionId !== primarySession.id &&
				session.framework === FALLBACK_FRAMEWORK,
		);
		if (!replacementSession) {
			return false;
		}
		replacementSessionId = replacementSession.sessionId;
		return true;
	}, `Expected coordinator to spawn ${FALLBACK_FRAMEWORK} after ${PRIMARY_FRAMEWORK} quota exhaustion`);

	sessionsToStop.add(replacementSessionId);

	const primaryLiveSession = service.getSession(primarySession.id);
	if (
		primaryLiveSession &&
		primaryLiveSession.status !== "error" &&
		primaryLiveSession.status !== "stopped"
	) {
		await service.stopSession(primarySession.id, true);
	}

	await waitFor(async () => {
		const replacementSession = service?.getSession(replacementSessionId);
		if (
			replacementSession &&
			(replacementSession.status === "error" ||
				replacementSession.status === "stopped")
		) {
			const output = await service?.getSessionOutput(replacementSessionId, 400);
			throw new Error(
				`${FALLBACK_FRAMEWORK} replacement session ended early with status ${replacementSession.status}. Recent output: ${output.slice(-400)}`,
			);
		}
		if (!fs.existsSync(outputFile)) {
			return false;
		}
		if (fs.readFileSync(outputFile, "utf8") !== sentinel) {
			return false;
		}
		const detail = await coordinator.getTaskThread(thread.id);
		return Boolean(
			detail?.events.some(
				(event) => event.eventType === "framework_unavailable",
			) &&
				detail.events.some(
					(event) => event.eventType === "framework_failover_started",
				) &&
				detail.transcripts.some(
					(entry) =>
						entry.sessionId === replacementSessionId &&
						entry.content.includes(sentinel),
				),
		);
	}, `Expected ${FALLBACK_FRAMEWORK} replacement session to complete the failover task`);

	const detail = await coordinator.getTaskThread(thread.id);
	assert.ok(detail, "Expected task thread detail to exist after failover");
	assert.equal(
		fs.readFileSync(outputFile, "utf8"),
		sentinel,
		"Expected the fallback framework to create the requested artifact",
	);
	assert.ok(
		detail.sessions.some(
			(session) =>
				session.sessionId === primarySession.id && session.status === "error",
		),
		"Expected the original session to remain recorded as errored",
	);
	assert.ok(
		detail.sessions.some(
			(session) =>
				session.sessionId === replacementSessionId &&
				session.framework === FALLBACK_FRAMEWORK,
		),
		"Expected the replacement session to remain attached to the same thread",
	);

	console.log(
		"[orchestrator-live-failover] PASS",
		JSON.stringify({
			threadId: thread.id,
			primarySessionId: primarySession.id,
			replacementSessionId,
			primaryFramework: PRIMARY_FRAMEWORK,
			fallbackFramework: FALLBACK_FRAMEWORK,
			workdir,
			outputFile,
		}),
	);
}

try {
	await main();
	await cleanup();
	process.exit(0);
} catch (error) {
	console.error("[orchestrator-live-failover] FAIL");
	console.error(error);
	await cleanup();
	process.exit(1);
}
