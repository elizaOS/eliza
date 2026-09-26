/** Verifies real coding-agent file writes and tracked session reuse through TASKS. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { createTestRuntime, selectLiveProvider } from "@elizaos/testing";

const {
	default: agentOrchestratorPlugin,
	AcpService,
	cleanForChat,
	sendToAgentAction,
	spawnAgentAction,
} = await import("@elizaos/plugin-agent-orchestrator");

type Framework = "claude" | "codex";
type AcpServiceInstance = InstanceType<typeof AcpService>;

const KEEP_ARTIFACTS = process.env.ELIZA_KEEP_LIVE_ARTIFACTS === "1";

type RouterHandle = { isActive?: () => boolean };

type SmokeContext = {
	runtime: AgentRuntime;
	router: RouterHandle;
	service: AcpServiceInstance;
	workdir: string;
	events: Array<{ event: string; data: unknown }>;
};

/** Checks that task execution has not activated the disabled background router. */
function assertRouterStayedDisabled(router: RouterHandle): void {
	assert.equal(
		router.isActive?.(),
		false,
		"router must remain inactive during the live task",
	);
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

function createWorkdir(agentType: Framework): string {
	return fs.mkdtempSync(
		path.join(
			ensureLiveBaseDir(),
			`agent-orchestrator-${agentType}-sequential-`,
		),
	);
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

async function runSequentialSmoke(
	agentType: Framework,
	{ runtime, router, service, workdir, events }: SmokeContext,
): Promise<void> {
	const [preflight] = await service.checkAvailableAgents([agentType]);
	assert.equal(preflight?.installed, true);
	let sessionId: string | undefined;

	for (const step of ["first", "second"]) {
		const filename = `${step.toUpperCase()}_${agentType.toUpperCase()}.txt`;
		const expectedText = `${agentType}-${step}`;
		const sentinel = `LIVE_REUSE_${agentType.toUpperCase()}_${step.toUpperCase()}_DONE`;
		const task =
			`Create a file named ${filename} containing exactly "${expectedText}". ` +
			`Then print exactly "${sentinel}". Stay available for more work afterward and do not ask follow-up questions.`;
		const eventStart = events.length;
		if (!sessionId) {
			const result = await spawnAgentAction.handler(
				runtime,
				createMessage({
					agentType,
					workdir,
					approvalPreset: "autonomous",
					task,
					acceptanceCriteria: [
						`The file ${filename} contains exactly "${expectedText}".`,
						`The completion reports "${sentinel}".`,
					],
				}) as never,
				undefined,
				{},
				undefined,
			);
			assert.equal(result?.success, true);
			sessionId = sessionIdFromSpawnResult(result);
			assert.ok(sessionId);
			await waitForTrackedSession(service, sessionId, agentType);
		} else {
			const result = await sendToAgentAction.handler(
				runtime,
				createMessage({ sessionId }) as never,
				undefined,
				{ parameters: { action: "send", input: task } },
				undefined,
			);
			assert.equal(result?.success, true);
		}
		const trackedSessionId = sessionId;
		const filePath = path.join(workdir, filename);
		await waitFor(
			async () => {
				const session = await service.getSession(trackedSessionId);
				assert.ok(session, "session disappeared before completing the task");
				const loginRequired = events.findLast(
					(entry) => entry.event === "login_required",
				);
				if (loginRequired) {
					const details = loginRequired.data as { instructions?: string };
					throw new Error(
						details.instructions || "framework authentication is required",
					);
				}
				if (["stopped", "errored", "cancelled"].includes(session.status)) {
					throw new Error(
						`session ended before completion with status ${session.status}`,
					);
				}
				if (
					!fs.existsSync(filePath) ||
					fs.readFileSync(filePath, "utf8").trim() !== expectedText
				)
					return false;
				const output = cleanForChat(
					await service.getSessionOutput(trackedSessionId),
				);
				return (
					session.status === "ready" &&
					(output.includes(sentinel) || sawTaskCompletion(events, eventStart))
				);
			},
			6 * 60 * 1000,
			3000,
		);
		assertRouterStayedDisabled(router);
	}
}

async function main(): Promise<void> {
	const frameworkIndex = process.argv.indexOf("--framework");
	const framework =
		frameworkIndex !== -1
			? (process.argv[frameworkIndex + 1] as Framework)
			: null;
	if (framework !== "claude" && framework !== "codex") {
		throw new Error(
			"Usage: task-agent-live-smoke.ts --framework <claude|codex>",
		);
	}

	const provider = selectLiveProvider();
	assert.ok(
		provider,
		"A live model provider is required for parent goal verification",
	);
	const providerModule = await import(provider.pluginPackage);
	const providerPlugin = providerModule.default ?? providerModule.elizaPlugin;
	assert.ok(providerPlugin, "The live provider must export a runtime plugin");

	const workdir = createWorkdir(framework);
	try {
		const { runtime, cleanup } = await createTestRuntime({
			characterName: "TaskAgentLiveSmoke",
			// "1" survives runtime setting normalization; the router stays disabled.
			settings: {
				...provider.env,
				SERVER_PORT: "31337",
				ACPX_SUB_AGENT_ROUTER_DISABLED: "1",
			},
			plugins: [providerPlugin, agentOrchestratorPlugin],
		});
		try {
			const router = (await runtime.getServiceLoadPromise(
				"ACPX_SUB_AGENT_ROUTER",
			)) as RouterHandle;
			assert.equal(typeof router?.isActive, "function");
			assertRouterStayedDisabled(router);
			const service = (await runtime.getServiceLoadPromise(
				AcpService.serviceType,
			)) as AcpServiceInstance;
			const events: SmokeContext["events"] = [];
			const unsubscribe = service.onSessionEvent((_sessionId, event, data) => {
				events.push({ event, data });
			});
			try {
				const context = { runtime, router, service, workdir, events };
				await runSequentialSmoke(framework, context);
			} finally {
				unsubscribe();
			}
		} finally {
			await cleanup();
		}
	} finally {
		if (!KEEP_ARTIFACTS) fs.rmSync(workdir, { recursive: true, force: true });
	}

	console.log("[task-agent-live-smoke] PASS", JSON.stringify({ framework }));
}

try {
	await main();
	process.exit(0);
} catch (error) {
	console.error("[task-agent-live-smoke] FAIL");
	console.error(error);
	process.exit(1);
}
