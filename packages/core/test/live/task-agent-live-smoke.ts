import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import {
	cleanForChat,
	listAgentsAction,
	PTYService,
	sendToAgentAction,
	spawnAgentAction,
} from "@elizaos/plugin-agent-orchestrator";
import { createTestRuntime } from "../helpers/pglite-runtime.ts";

type Framework = "claude" | "codex";
type Mode = "sequential" | "web";

const KEEP_ARTIFACTS = process.env.ELIZA_KEEP_LIVE_ARTIFACTS === "1";

async function createRuntime(settings: Record<string, unknown> = {}): Promise<{
	runtime: AgentRuntime;
	cleanup: () => Promise<void>;
}> {
	const { runtime, cleanup } = await createTestRuntime({
		characterName: "TaskAgentLiveSmoke",
	});
	const originalGetSetting = runtime.getSetting.bind(runtime);
	runtime.getSetting = ((key: string) =>
		settings[key] ??
		originalGetSetting(key) ??
		process.env[key]) as typeof runtime.getSetting;
	return { runtime, cleanup };
}

function createMessage(content: Record<string, unknown> = {}) {
	return {
		id: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
		userId: "live-user",
		roomId: "live-room",
		createdAt: Date.now(),
		content,
	};
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
	const baseDir = path.join(process.cwd(), ".tmp-live");
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
	runtime: AgentRuntime,
	sessionId: string,
	expectedAgentType: Framework,
): Promise<void> {
	let listResult:
		| Awaited<ReturnType<typeof listAgentsAction.handler>>
		| undefined;
	await waitFor(
		async () => {
			listResult = await listAgentsAction.handler(
				runtime,
				createMessage({}) as never,
			);
			if (!listResult?.success) {
				return false;
			}
			const sessions = Array.isArray(listResult.data?.sessions)
				? listResult.data.sessions
				: [];
			const tasks = Array.isArray(listResult.data?.tasks)
				? listResult.data.tasks
				: [];
			return (
				sessions.some((entry) => entry.id === sessionId) &&
				tasks.some(
					(entry) =>
						entry.sessionId === sessionId &&
						entry.agentType === expectedAgentType,
				)
			);
		},
		45_000,
		1_000,
	);

	assert.ok(listResult?.text.includes(sessionId));
	assert.ok(listResult?.text.includes(expectedAgentType));
}

async function runSequentialSmoke(agentType: Framework): Promise<void> {
	const workdir = createWorkdir(agentType, "reuse");
	const { runtime, cleanup } = await createRuntime({ SERVER_PORT: "31337" });
	const service = await PTYService.start(runtime);
	runtime.services.set("PTY_SERVICE", [service]);

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
				task:
					`Create a file named ${firstFileName} in the current directory containing exactly "${agentType}-first". ` +
					`Then print exactly "${firstSentinel}". Do not ask follow-up questions.`,
			}) as never,
			undefined,
			{},
			undefined,
		);
		assert.equal(spawnResult?.success, true);
		assert.ok(spawnResult?.data?.sessionId);

		const sessionId = String(spawnResult?.data?.sessionId);
		await waitForTrackedSession(runtime, sessionId, agentType);
		const firstTaskEventStart = events.length;

		await waitFor(
			async () => {
				const sessionInfo = service.getSession(sessionId);
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
				if (
					sessionInfo.status === "stopped" ||
					sessionInfo.status === "error"
				) {
					const output = await service.getSessionOutput(sessionId, 200);
					throw new Error(
						`session ended early with status ${sessionInfo.status}. Output: ${output.slice(-600)}`,
					);
				}
				if (!fs.existsSync(firstFilePath)) return false;
				const fileText = fs.readFileSync(firstFilePath, "utf8").trim();
				if (fileText !== `${agentType}-first`) return false;
				const output = cleanForChat(await service.getSessionOutput(sessionId));
				return (
					output.includes(firstSentinel) ||
					sawTaskCompletion(events, firstTaskEventStart)
				);
			},
			6 * 60 * 1000,
			3000,
		);

		const secondTaskEventStart = events.length;
		const sendResult = await sendToAgentAction.handler(
			runtime,
			createMessage({
				sessionId,
				task:
					`Now create a second file named ${secondFileName} containing exactly "${agentType}-second". ` +
					`Then print exactly "${secondSentinel}". Stay available for more work afterward and do not ask follow-up questions.`,
			}) as never,
			undefined,
			{},
			undefined,
		);
		assert.equal(sendResult?.success, true);

		await waitFor(
			async () => {
				if (!fs.existsSync(secondFilePath)) return false;
				const fileText = fs.readFileSync(secondFilePath, "utf8").trim();
				if (fileText !== `${agentType}-second`) return false;
				const output = cleanForChat(await service.getSessionOutput(sessionId));
				return (
					output.includes(secondSentinel) ||
					sawTaskCompletion(events, secondTaskEventStart)
				);
			},
			6 * 60 * 1000,
			3000,
		);

		const finalList = await listAgentsAction.handler(
			runtime,
			createMessage({}) as never,
		);
		assert.equal(finalList?.success, true);
		assert.ok(finalList?.text.includes(sessionId));
	} finally {
		unsubscribe();
		await service.stop();
		await cleanup();
		if (!KEEP_ARTIFACTS) {
			fs.rmSync(workdir, { recursive: true, force: true });
		}
	}
}

async function runWebSmoke(agentType: Framework): Promise<void> {
	const workdir = createWorkdir(agentType, "web");
	const { runtime, cleanup } = await createRuntime({ SERVER_PORT: "31337" });
	const service = await PTYService.start(runtime);
	runtime.services.set("PTY_SERVICE", [service]);

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
		assert.ok(spawnResult?.data?.sessionId);

		const sessionId = String(spawnResult?.data?.sessionId);
		await waitForTrackedSession(runtime, sessionId, agentType);
		const webTaskEventStart = events.length;

		await waitFor(
			async () => {
				const sessionInfo = service.getSession(sessionId);
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

		const finalList = await listAgentsAction.handler(
			runtime,
			createMessage({}) as never,
		);
		assert.equal(finalList?.success, true);
		assert.ok(finalList?.text.includes(sessionId));
	} finally {
		unsubscribe();
		await new Promise<void>((resolve) =>
			reference.server.close(() => resolve()),
		);
		await service.stop();
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
