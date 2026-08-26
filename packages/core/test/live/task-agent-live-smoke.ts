/** Runs live core runtime smoke coverage against real provider or orchestration surfaces. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import type { AgentRuntime, RuntimeSettings } from "@elizaos/core";
import { createTestRuntime } from "../../src/testing/pglite-runtime.ts";

const {
	default: agentOrchestratorPlugin,
	AcpService,
	cleanForChat,
	sendToAgentAction,
	spawnAgentAction,
} = await import("@elizaos/plugin-agent-orchestrator");

type Framework = "claude" | "codex";
type Mode = "sequential" | "web";
type AcpServiceInstance = InstanceType<typeof AcpService>;

const KEEP_ARTIFACTS = process.env.ELIZA_KEEP_LIVE_ARTIFACTS === "1";

async function createRuntime(settings: RuntimeSettings = {}): Promise<{
	runtime: AgentRuntime;
	cleanup: () => Promise<void>;
}> {
	const { runtime, cleanup } = await createTestRuntime({
		characterName: "TaskAgentLiveSmoke",
		settings,
		plugins: [agentOrchestratorPlugin],
	});
	const router = (await runtime.getServiceLoadPromise(
		"ACPX_SUB_AGENT_ROUTER",
	)) as { isActive?: () => boolean };
	assert.equal(
		typeof router?.isActive,
		"function",
		"production SubAgentRouter must be registered in the live harness",
	);
	assert.equal(
		router.isActive?.(),
		false,
		"ACPX_SUB_AGENT_ROUTER_DISABLED must take effect before plugin startup",
	);
	return { runtime, cleanup };
}

function createMessage(content: Record<string, unknown> = {}) {
	return {
		id: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
		userId: "live-user",
		entityId: "live-user",
		roomId: "live-room",
		createdAt: Date.now(),
		content,
	};
}

function sessionIdFromSpawnResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const data = (result as Record<string, unknown>).data;
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.sessionId === "string") return record.sessionId;
	if (!Array.isArray(record.agents)) return undefined;
	const first = record.agents[0];
	if (!first || typeof first !== "object") return undefined;
	const sessionId = (first as Record<string, unknown>).sessionId;
	return typeof sessionId === "string" ? sessionId : undefined;
}

async function wait(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTextIfAvailable(url: string): Promise<string | null> {
	try {
		const response = await fetch(url);
		if (!response.ok) {
			return null;
		}
		return await response.text();
	} catch {
		// The local HTTP server is expected to refuse connections until the agent starts it.
		return null;
	}
}

async function waitFor(
	check: () => Promise<boolean>,
	timeoutMs: number,
	intervalMs: number,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await check()) return;
		await wait(intervalMs);
	}
	throw new Error(`Timed out after ${timeoutMs}ms`);
}

function ensureLiveBaseDir(): string {
	const baseDir = path.join("/tmp", "eliza-task-agent-live-smoke");
	fs.mkdirSync(baseDir, { recursive: true });
	return baseDir;
}

function createWorkdir(agentType: Framework, label: string): string {
	return fs.mkdtempSync(
		path.join(ensureLiveBaseDir(), `agent-orchestrator-${agentType}-${label}-`),
	);
}

async function getFreePort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Failed to allocate an ephemeral port");
	}
	const port = address.port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

async function startReferenceServer(html: string): Promise<{
	server: Server;
	url: string;
}> {
	const port = await getFreePort();
	const server = createServer((_, res) => {
		res.statusCode = 200;
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end(html);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});
	return {
		server,
		url: `http://127.0.0.1:${port}/reference.html`,
	};
}

function sawTaskCompletion(
	events: Array<{ event: string; data: unknown }>,
	startIndex: number,
): boolean {
	return events
		.slice(startIndex)
		.some(
			(entry) => entry.event === "task_complete" || entry.event === "completed",
		);
}

async function waitForTrackedSession(
	service: {
		getSession: (
			id: string,
		) => Promise<{ agentType?: string } | null | undefined>;
	},
	sessionId: string,
	expectedAgentType: Framework,
): Promise<void> {
	await waitFor(
		async () => {
			const session = await service.getSession(sessionId);
			return session?.agentType === expectedAgentType;
		},
		45_000,
		1_000,
	);
}

async function runSequentialSmoke(agentType: Framework): Promise<void> {
	const workdir = createWorkdir(agentType, "reuse");
	const { runtime, cleanup } = await createRuntime({
		SERVER_PORT: "31337",
		// This smoke validates ACP child turns and durable reuse. Parent-broker
		// relay behavior has separate coverage; disabling the router here keeps a
		// synthetic no-parent fixture from manufacturing an endless child loop.
		ACPX_SUB_AGENT_ROUTER_DISABLED: "true",
	});
	// Use the single production service initialized by the plugin. Starting a
	// second ACP instance lets TASKS spawn on one service while SubAgentRouter
	// remains subscribed to the original, so cap-triggered stops target the
	// wrong process and leave the prompt unresolved.
	const service = (await runtime.getServiceLoadPromise(
		AcpService.serviceType,
	)) as AcpServiceInstance;

	const events: Array<{ event: string; data: unknown }> = [];
	const unsubscribe = service.onSessionEvent((_sessionId, event, data) => {
		events.push({ event, data });
	});

	const firstFileName = `FIRST_${agentType.toUpperCase()}.txt`;
	const secondFileName = `SECOND_${agentType.toUpperCase()}.txt`;
	const firstFilePath = path.join(workdir, firstFileName);
	const secondFilePath = path.join(workdir, secondFileName);
	const firstSentinel = `LIVE_REUSE_${agentType.toUpperCase()}_FIRST_DONE`;
	const secondSentinel = `LIVE_REUSE_${agentType.toUpperCase()}_SECOND_DONE`;

	try {
		const [preflight] = await service.checkAvailableAgents([agentType]);
		assert.equal(preflight?.installed, true);

		const spawnResult = await spawnAgentAction.handler(
			runtime,
			createMessage({
				agentType,
				workdir,
				approvalPreset: "autonomous",
				task:
					`Create a file named ${firstFileName} in the current directory containing exactly "${agentType}-first". ` +
					`Then print exactly "${firstSentinel}". Do not ask follow-up questions.`,
			}) as never,
			undefined,
			{},
			undefined,
		);
		assert.equal(spawnResult?.success, true);
		assert.ok(sessionIdFromSpawnResult(spawnResult));

		const sessionId = sessionIdFromSpawnResult(spawnResult) as string;
		await waitForTrackedSession(service, sessionId, agentType);
		const firstTaskEventStart = events.length;

		await waitFor(
			async () => {
				const sessionInfo = await service.getSession(sessionId);
				if (!sessionInfo) {
					throw new Error(
						"session disappeared before completing the first task",
					);
				}
				const recentLoginRequired = events.findLast(
					(entry) => entry.event === "login_required",
				);
				if (recentLoginRequired) {
					const details = recentLoginRequired.data as { instructions?: string };
					throw new Error(
						details.instructions || "framework authentication is required",
					);
				}
				if (!fs.existsSync(firstFilePath)) return false;
				const fileText = fs.readFileSync(firstFilePath, "utf8").trim();
				if (fileText !== `${agentType}-first`) return false;
				const output = cleanForChat(await service.getSessionOutput(sessionId));
				if (
					(output.includes(firstSentinel) ||
						sawTaskCompletion(events, firstTaskEventStart)) &&
					sessionInfo.status === "ready"
				)
					return true;
				if (
					sessionInfo.status === "stopped" ||
					sessionInfo.status === "error"
				) {
					throw new Error(
						`session ended before verified completion with status ${sessionInfo.status}. Output: ${output.slice(-600)}`,
					);
				}
				return false;
			},
			6 * 60 * 1000,
			3000,
		);

		const secondTaskEventStart = events.length;
		const sendResult = await sendToAgentAction.handler(
			runtime,
			createMessage({ sessionId }) as never,
			undefined,
			{
				parameters: {
					action: "send",
					input:
						`Now create a second file named ${secondFileName} containing exactly "${agentType}-second". ` +
						`Then print exactly "${secondSentinel}". Stay available for more work afterward and do not ask follow-up questions.`,
				},
			},
			undefined,
		);
		assert.equal(sendResult?.success, true);

		await waitFor(
			async () => {
				if (!fs.existsSync(secondFilePath)) return false;
				const fileText = fs.readFileSync(secondFilePath, "utf8").trim();
				if (fileText !== `${agentType}-second`) return false;
				const output = cleanForChat(await service.getSessionOutput(sessionId));
				const sessionInfo = await service.getSession(sessionId);
				return (
					(output.includes(secondSentinel) ||
						sawTaskCompletion(events, secondTaskEventStart)) &&
					sessionInfo?.status === "ready"
				);
			},
			6 * 60 * 1000,
			3000,
		);
	} finally {
		unsubscribe();
		await cleanup();
		if (!KEEP_ARTIFACTS) {
			fs.rmSync(workdir, { recursive: true, force: true });
		}
	}
}

async function runWebSmoke(agentType: Framework): Promise<void> {
	const workdir = createWorkdir(agentType, "web");
	const { runtime, cleanup } = await createRuntime({
		SERVER_PORT: "31337",
		ACPX_SUB_AGENT_ROUTER_DISABLED: "true",
	});
	const service = (await runtime.getServiceLoadPromise(
		AcpService.serviceType,
	)) as AcpServiceInstance;

	const events: Array<{ event: string; data: unknown }> = [];
	const unsubscribe = service.onSessionEvent((_sessionId, event, data) => {
		events.push({ event, data });
	});

	const agentPort = await getFreePort();
	const serveSentinel = `LIVE_WEB_${agentType.toUpperCase()}_READY`;
	const reference = await startReferenceServer(`<!doctype html>
<html>
  <body>
    <h1>Benchmark Ready</h1>
    <p>Task agents stay reusable.</p>
    <p>Codex and Claude Code should both handle research and serving tasks.</p>
  </body>
</html>`);

	try {
		const [preflight] = await service.checkAvailableAgents([agentType]);
		assert.equal(preflight?.installed, true);

		const spawnResult = await spawnAgentAction.handler(
			runtime,
			createMessage({
				agentType,
				workdir,
				approvalPreset: "autonomous",
				task:
					`Open the reference page at ${reference.url} and read it using your web or browser tools. ` +
					`Create an index.html in the current directory that includes the exact phrases "Benchmark Ready" and "Task agents stay reusable." ` +
					`Then start a local HTTP server in the background from the current directory with ` +
					`"python3 -m http.server ${agentPort} >/tmp/${serveSentinel}.log 2>&1 & echo $! > server.pid", ` +
					`print exactly "${serveSentinel}", and keep the server available until I stop you. ` +
					`Do not ask follow-up questions.`,
			}) as never,
			undefined,
			{},
			undefined,
		);
		assert.equal(spawnResult?.success, true);
		assert.ok(sessionIdFromSpawnResult(spawnResult));

		const sessionId = sessionIdFromSpawnResult(spawnResult) as string;
		await waitForTrackedSession(service, sessionId, agentType);
		const webTaskEventStart = events.length;

		await waitFor(
			async () => {
				const sessionInfo = await service.getSession(sessionId);
				if (!sessionInfo) {
					throw new Error("session disappeared before completing the web task");
				}
				const recentLoginRequired = events.findLast(
					(entry) => entry.event === "login_required",
				);
				if (recentLoginRequired) {
					const details = recentLoginRequired.data as { instructions?: string };
					throw new Error(
						details.instructions || "framework authentication is required",
					);
				}
				if (
					sessionInfo.status === "stopped" ||
					sessionInfo.status === "error"
				) {
					const output = await service.getSessionOutput(sessionId, 200);
					throw new Error(
						`web task ended early with status ${sessionInfo.status}. Output: ${output.slice(-600)}`,
					);
				}
				const html = await fetchTextIfAvailable(
					`http://127.0.0.1:${agentPort}/index.html`,
				);
				if (!html) return false;
				return (
					html.includes("Benchmark Ready") &&
					html.includes("Task agents stay reusable.") &&
					(cleanForChat(await service.getSessionOutput(sessionId)).includes(
						serveSentinel,
					) ||
						sawTaskCompletion(events, webTaskEventStart))
				);
			},
			6 * 60 * 1000,
			3000,
		);
	} finally {
		unsubscribe();
		await new Promise<void>((resolve) =>
			reference.server.close(() => resolve()),
		);
		await cleanup();
		if (!KEEP_ARTIFACTS) {
			fs.rmSync(workdir, { recursive: true, force: true });
		}
	}
}

async function main(): Promise<void> {
	const frameworkIndex = process.argv.indexOf("--framework");
	const modeIndex = process.argv.indexOf("--mode");
	const framework =
		frameworkIndex !== -1
			? (process.argv[frameworkIndex + 1] as Framework)
			: null;
	const mode = modeIndex !== -1 ? (process.argv[modeIndex + 1] as Mode) : null;

	if (
		(framework !== "claude" && framework !== "codex") ||
		(mode !== "sequential" && mode !== "web")
	) {
		throw new Error(
			"Usage: task-agent-live-smoke.ts --framework <claude|codex> --mode <sequential|web>",
		);
	}

	if (mode === "sequential") {
		await runSequentialSmoke(framework);
	} else {
		await runWebSmoke(framework);
	}

	console.log(
		"[task-agent-live-smoke] PASS",
		JSON.stringify({ framework, mode }),
	);
}

try {
	await main();
	process.exit(0);
} catch (error) {
	console.error("[task-agent-live-smoke] FAIL");
	console.error(error);
	process.exit(1);
}
