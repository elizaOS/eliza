/**
 * Branch coverage for the trajectories plugin entry module: the event-driven
 * pending-trajectory state machine (final-status mapping, degraded starts,
 * delivery fallbacks, durability retry exhaustion, disposal draining) and the
 * metadata enrichment rules consumers rely on. Drives the real plugin handlers
 * with deterministic service doubles; no database or live runtime is involved.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../../types";
import trajectories, { trajectoriesPlugin } from "./index";
import { TrajectoriesService } from "./TrajectoriesService";

type Handler = (payload: Record<string, unknown>) => Promise<void>;

type ServiceDouble = TrajectoriesService & {
	startTrajectory: ReturnType<typeof vi.fn>;
	startStep: ReturnType<typeof vi.fn>;
	flushWriteQueue: ReturnType<typeof vi.fn>;
	endTrajectory: ReturnType<typeof vi.fn>;
	releaseTrajectoryOwnership: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
};

function handler(event: string): Handler {
	const list = (trajectoriesPlugin.events as Record<string, Handler[]>)[event];
	if (!list?.[0]) {
		throw new Error(`Missing ${event} trajectory handler`);
	}
	return list[0];
}

// `resolveFromRuntime` gates on `instanceof TrajectoriesService`; prototype
// inheritance satisfies it without running the real constructor (DB init).
function makeService(): ServiceDouble {
	const svc = Object.create(TrajectoriesService.prototype) as ServiceDouble;
	let sequence = 0;
	svc.startTrajectory = vi.fn(async () => `traj-${++sequence}`);
	svc.startStep = vi.fn((trajectoryId: string) => `${trajectoryId}-step`);
	svc.flushWriteQueue = vi.fn(async () => {});
	svc.endTrajectory = vi.fn(async () => {});
	svc.releaseTrajectoryOwnership = vi.fn();
	svc.stop = vi.fn(async () => {});
	return svc;
}

function makeRuntime(
	svc: TrajectoriesService | null,
	room: unknown = null,
): IAgentRuntime {
	return {
		agentId: "20000000-0000-0000-0000-000000000002",
		getService: vi.fn(() => svc),
		getServicesByType: vi.fn(() => (svc ? [svc] : [])),
		getRoom: vi.fn(async () => room),
		logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
}

function makeMessage(id: string, metadata?: Record<string, unknown>) {
	return {
		id,
		roomId: "room-1",
		entityId: "entity-1",
		content: { text: "hello" } as Record<string, unknown>,
		metadata,
	};
}

function startOptions(
	svc: ServiceDouble,
	callIndex = 0,
): {
	source: string;
	metadata: Record<string, unknown>;
	scenarioId?: string;
	batchId?: string;
	traceId?: string;
} {
	const call = svc.startTrajectory.mock.calls[callIndex];
	if (!call) throw new Error(`startTrajectory call ${callIndex} missing`);
	return call[1] as ReturnType<typeof startOptions>;
}

const originalTraceEnv = process.env.ELIZA_TRACE_ID;

describe("trajectories plugin entry branches", () => {
	afterAll(() => {
		if (originalTraceEnv === undefined) {
			delete process.env.ELIZA_TRACE_ID;
		} else {
			process.env.ELIZA_TRACE_ID = originalTraceEnv;
		}
	});

	beforeEach(() => {
		// Hermetic trace minting: the plugin inherits ELIZA_TRACE_ID when present.
		delete process.env.ELIZA_TRACE_ID;
	});

	it("pins the plugin identity and default export", () => {
		expect(trajectories).toBe(trajectoriesPlugin);
		expect(trajectoriesPlugin.name).toBe("trajectories");
		expect(trajectoriesPlugin.dependencies).toEqual(["@elizaos/plugin-sql"]);
		expect(trajectoriesPlugin.services).toContain(TrajectoriesService);
	});

	it("maps every RUN_ENDED payload status onto the trajectory final status", async () => {
		const svc = makeService();
		const runtime = makeRuntime(svc);
		const cases = [
			["completed", "completed"],
			["timeout", "timeout"],
			["failed", "terminated"],
		] as const;

		for (const [runStatus] of cases) {
			await handler("MESSAGE_RECEIVED")({
				runtime,
				message: makeMessage(`msg-status-${runStatus}`),
			});
		}
		for (const [runStatus] of cases) {
			await handler("RUN_ENDED")({
				runtime,
				messageId: `msg-status-${runStatus}`,
				status: runStatus,
			});
		}

		expect(svc.endTrajectory.mock.calls).toEqual([
			["traj-1", "completed"],
			["traj-2", "timeout"],
			["traj-3", "terminated"],
		]);
	});

	it("degrades to local-step correlation when startTrajectory yields no id", async () => {
		const svc = makeService();
		svc.startTrajectory.mockResolvedValue("");
		const runtime = makeRuntime(svc);
		const message = makeMessage("msg-empty-start");

		await expect(
			handler("MESSAGE_RECEIVED")({ runtime, message }),
		).resolves.toBeUndefined();

		const meta = message.metadata as Record<string, unknown>;
		expect(meta.trajectoryId).toBeUndefined();
		expect(typeof meta.trajectoryStepId).toBe("string");
		expect(meta.trajectoryStepId).not.toBe("");
		expect(svc.startStep).not.toHaveBeenCalled();
		expect(svc.flushWriteQueue).not.toHaveBeenCalled();

		await handler("RUN_ENDED")({
			runtime,
			messageId: "msg-empty-start",
			status: "completed",
		});
		expect(svc.endTrajectory).not.toHaveBeenCalled();
	});

	it("ends the trajectory via a reply-carried trajectoryStepId without inReplyTo", async () => {
		const svc = makeService();
		const runtime = makeRuntime(svc);
		const message = makeMessage("msg-direct-step");
		await handler("MESSAGE_RECEIVED")({ runtime, message });

		const meta = message.metadata as Record<string, unknown>;
		expect(meta.trajectoryId).toBe("traj-1");

		const reply = {
			id: "reply-direct-step",
			roomId: "room-1",
			entityId: "entity-1",
			content: {} as Record<string, unknown>,
			metadata: { trajectoryStepId: meta.trajectoryStepId },
		};
		await handler("MESSAGE_SENT")({ runtime, message: reply });

		expect(svc.endTrajectory).toHaveBeenCalledWith("traj-1", "completed");
	});

	it("ignores deliveries whose step id matches nothing pending", async () => {
		const svc = makeService();
		const runtime = makeRuntime(svc);

		await handler("MESSAGE_SENT")({
			runtime,
			message: {
				id: "ghost-delivery",
				roomId: "room-1",
				entityId: "entity-1",
				content: {} as Record<string, unknown>,
				metadata: { trajectoryStepId: "never-registered" },
			},
		});

		expect(svc.endTrajectory).not.toHaveBeenCalled();
	});

	it("inherits an existing traceId, preserves caller metadata, and mints when absent", async () => {
		const svc = makeService();
		const runtime = makeRuntime(svc);
		const inherited = makeMessage("msg-inherit", {
			type: "custom",
			traceId: "fixed-trace",
		});
		await handler("MESSAGE_RECEIVED")({ runtime, message: inherited });

		const inheritedMeta = inherited.metadata as Record<string, unknown>;
		expect(inheritedMeta.type).toBe("custom");
		expect(inheritedMeta.traceId).toBe("fixed-trace");

		const minted = makeMessage("msg-mint");
		await handler("MESSAGE_RECEIVED")({ runtime, message: minted });
		const mintedMeta = minted.metadata as Record<string, unknown>;
		expect(mintedMeta.type).toBe("message");
		expect(typeof mintedMeta.traceId).toBe("string");
		expect(mintedMeta.traceId).not.toBe("fixed-trace");
		expect((mintedMeta.traceId as string).length).toBeGreaterThan(0);

		expect(startOptions(svc).metadata.traceId).toBe("fixed-trace");
	});

	it("copies whitelisted scalar metadata fields and maps session and channel keys", async () => {
		const svc = makeService();
		const runtime = makeRuntime(svc);
		const message = makeMessage("msg-fields", {
			channelType: "discord",
			sessionKey: "sess-9",
			taskId: { not: "scalar" },
			surfaceVersion: 3,
			scenarioId: "sc-1",
			batchId: 42,
		});
		message.content.channelType = "dm";

		await handler("MESSAGE_RECEIVED")({ runtime, message });

		const options = startOptions(svc);
		expect(options.source).toBe("chat");
		expect(options.metadata.channelType).toBe("discord");
		expect(options.metadata.conversationId).toBe("sess-9");
		expect(options.metadata.taskId).toBeUndefined();
		expect(options.metadata.surfaceVersion).toBe(3);
		expect(options.metadata.scenarioId).toBe("sc-1");
		expect(options.metadata.batchId).toBe(42);
		expect(options.scenarioId).toBe("sc-1");
		expect(options.batchId).toBeUndefined();
	});

	it("resolves the capture source as param, then metadata, then the chat default", async () => {
		const svc = makeService();
		const runtime = makeRuntime(svc);

		await handler("MESSAGE_RECEIVED")({
			runtime,
			message: makeMessage("msg-src-default"),
		});
		await handler("MESSAGE_RECEIVED")({
			runtime,
			message: makeMessage("msg-src-meta", { source: "voice" }),
		});
		await handler("MESSAGE_RECEIVED")({
			runtime,
			message: makeMessage("msg-src-param", { source: "voice" }),
			source: "api",
		});

		const sources = svc.startTrajectory.mock.calls.map(
			(_call, index) => startOptions(svc, index).source,
		);
		expect(sources).toEqual(["chat", "voice", "api"]);
	});

	it("enriches page-scoped web conversations with derived task fields", async () => {
		const svc = makeService();
		const runtime = makeRuntime(svc, {
			metadata: {
				webConversation: {
					scope: "page-abc123",
					pageId: "pg-1",
					sourceConversationId: "src-7",
					conversationId: "",
					automationType: "flow",
					unrelatedKey: "keep-out",
				},
			},
		});
		const message = makeMessage("msg-webconv");

		await handler("MESSAGE_RECEIVED")({ runtime, message });

		const meta = startOptions(svc).metadata;
		expect(meta.webConversation).toEqual({
			scope: "page-abc123",
			pageId: "pg-1",
			sourceConversationId: "src-7",
			automationType: "flow",
		});
		expect(meta.taskId).toBe("page-abc123");
		expect(meta.surface).toBe("page-scoped");
		expect(meta.pageId).toBe("pg-1");
		expect(meta.sourceConversationId).toBe("src-7");
	});

	it("copies non-page web conversations verbatim and keeps caller-supplied task fields", async () => {
		const svc = makeService();
		const runtime = makeRuntime(svc, {
			metadata: { webConversation: { scope: "workspace-9" } },
		});
		const message = makeMessage("msg-webconv-workspace", {
			taskId: "caller-task",
		});

		await handler("MESSAGE_RECEIVED")({ runtime, message });

		const meta = startOptions(svc).metadata;
		expect(meta.webConversation).toEqual({ scope: "workspace-9" });
		expect(meta.taskId).toBe("caller-task");
		expect(meta.surface).toBeUndefined();
	});

	it("exhausts start teardown retries and releases ownership when cleanup keeps failing", async () => {
		const svc = makeService();
		svc.flushWriteQueue.mockRejectedValue(new Error("flush failed"));
		svc.endTrajectory.mockRejectedValue(new Error("storage down"));
		const runtime = makeRuntime(svc);
		const message = makeMessage("msg-teardown");

		await expect(
			handler("MESSAGE_RECEIVED")({ runtime, message }),
		).resolves.toBeUndefined();

		expect(svc.startTrajectory).toHaveBeenCalledOnce();
		expect(svc.endTrajectory.mock.calls).toEqual([
			["traj-1", "error"],
			["traj-1", "error"],
		]);
		expect(svc.releaseTrajectoryOwnership).toHaveBeenCalledTimes(1);
		expect(svc.releaseTrajectoryOwnership).toHaveBeenCalledWith("traj-1");
		const cleanupCalls = (
			runtime.reportError as ReturnType<typeof vi.fn>
		).mock.calls.filter(
			(call) => call[0] === "TrajectoriesPlugin.startCleanup",
		);
		expect(cleanupCalls).toHaveLength(2);
		expect(cleanupCalls[0]?.[2]).toMatchObject({
			attempt: 1,
			diagnosticOnly: true,
		});
		expect(cleanupCalls[1]?.[2]).toMatchObject({
			attempt: 2,
			diagnosticOnly: true,
		});
		expect(runtime.reportError).toHaveBeenCalledWith(
			"TrajectoriesPlugin.start",
			expect.any(Error),
			{ roomId: "room-1", diagnosticOnly: true },
		);
		const meta = message.metadata as Record<string, unknown>;
		expect(meta.trajectoryId).toBeUndefined();
		expect(meta.trajectoryStepId).toBeUndefined();
	});

	it("reports an aggregated terminalization failure when retries exhaust on run end", async () => {
		const svc = makeService();
		svc.endTrajectory.mockRejectedValue(new Error("db unreachable"));
		const runtime = makeRuntime(svc);
		const message = makeMessage("msg-run-end-fail");
		await handler("MESSAGE_RECEIVED")({ runtime, message });

		await expect(
			handler("RUN_ENDED")({
				runtime,
				messageId: "msg-run-end-fail",
				status: "completed",
			}),
		).resolves.toBeUndefined();

		expect(svc.endTrajectory).toHaveBeenCalledTimes(2);
		expect(svc.releaseTrajectoryOwnership).toHaveBeenCalledWith("traj-1");
		const reported = (
			runtime.reportError as ReturnType<typeof vi.fn>
		).mock.calls.find((call) => call[0] === "TrajectoriesPlugin.endRun");
		expect(reported).toBeDefined();
		const failure = reported?.[1] as Error & { code?: string; cause?: unknown };
		expect(failure.code).toBe("TRAJECTORY_TERMINALIZATION_FAILED");
		expect(failure.cause).toBeInstanceOf(AggregateError);
		expect((failure.cause as AggregateError).errors).toHaveLength(2);
	});

	it("treats run events for unknown messages as silent no-ops", async () => {
		const svc = makeService();
		const runtime = makeRuntime(svc);

		await handler("RUN_STARTED")({ runtime, messageId: "ghost" });
		await handler("RUN_ENDED")({
			runtime,
			messageId: "ghost",
			status: "completed",
		});
		await handler("RUN_TIMEOUT")({ runtime, messageId: "ghost" });

		expect(svc.startTrajectory).not.toHaveBeenCalled();
		expect(svc.endTrajectory).not.toHaveBeenCalled();
	});

	it("drains every pending trajectory as terminated during dispose and survives failures", async () => {
		const svc = makeService();
		svc.endTrajectory
			.mockRejectedValueOnce(new Error("first drain fails"))
			.mockRejectedValueOnce(new Error("retry drain fails"))
			.mockResolvedValue(undefined);
		const runtime = makeRuntime(svc);
		await handler("MESSAGE_RECEIVED")({
			runtime,
			message: makeMessage("msg-drain-a"),
		});
		await handler("MESSAGE_RECEIVED")({
			runtime,
			message: makeMessage("msg-drain-b"),
		});

		const dispose = (
			trajectoriesPlugin as unknown as {
				dispose: (runtime: IAgentRuntime) => Promise<void>;
			}
		).dispose.bind(trajectoriesPlugin);
		await expect(dispose(runtime)).resolves.toBeUndefined();

		expect(svc.endTrajectory.mock.calls).toEqual([
			["traj-1", "terminated"],
			["traj-1", "terminated"],
			["traj-2", "terminated"],
		]);
		expect(svc.releaseTrajectoryOwnership).toHaveBeenCalledTimes(1);
		expect(svc.releaseTrajectoryOwnership).toHaveBeenCalledWith("traj-1");
		expect(runtime.reportError).toHaveBeenCalledWith(
			"TrajectoriesPlugin.dispose",
			expect.objectContaining({ code: "TRAJECTORY_TERMINALIZATION_FAILED" }),
			{ trajectoryStepId: "traj-1-step", diagnosticOnly: true },
		);
		expect(svc.stop).toHaveBeenCalledTimes(1);

		// Disposal cleared the pending indexes: later run events stay no-ops.
		await handler("RUN_ENDED")({
			runtime,
			messageId: "msg-drain-b",
			status: "completed",
		});
		expect(svc.endTrajectory).toHaveBeenCalledTimes(3);
	});
});
