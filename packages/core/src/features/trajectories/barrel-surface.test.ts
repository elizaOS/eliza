/**
 * Pins for the trajectories plugin module after the #16470 orphan removal:
 * the deleted `game-rewards` symbols are gone from the export surface, the
 * live surface remains, and — previously untested — the plugin's event
 * plumbing does what its consumers rely on: MESSAGE_RECEIVED starts a
 * trajectory + step and stamps the message metadata, MESSAGE_SENT /
 * RUN_ENDED / RUN_TIMEOUT end it with the right final status, and a runtime
 * without the service degrades to a traced no-op instead of throwing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUniqueUuid } from "../../entities";
import type { IAgentRuntime } from "../../types";
import * as trajectories from "./index";
import { trajectoriesPlugin } from "./index";
import { TrajectoriesService } from "./TrajectoriesService";

type Handler = (payload: Record<string, unknown>) => Promise<void>;

function handler(event: string): Handler {
	const list = (trajectoriesPlugin.events as Record<string, Handler[]>)[event];
	expect(list).toBeDefined();
	return list[0] as Handler;
}

function makeFakeService() {
	// `resolveFromRuntime` gates on `instanceof TrajectoriesService`; prototype
	// inheritance satisfies it without running the real constructor (DB init).
	const svc = Object.create(
		TrajectoriesService.prototype,
	) as TrajectoriesService & {
		startTrajectory: ReturnType<typeof vi.fn>;
		startStep: ReturnType<typeof vi.fn>;
		endTrajectory: ReturnType<typeof vi.fn>;
		flushWriteQueue: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
	};
	svc.startTrajectory = vi.fn(async () => "traj-1");
	svc.startStep = vi.fn(() => "step-1");
	svc.endTrajectory = vi.fn(async () => {});
	svc.flushWriteQueue = vi.fn(async () => {});
	svc.stop = vi.fn(async () => {});
	return svc;
}

function makeRuntime(svc: TrajectoriesService | null): IAgentRuntime {
	return {
		agentId: "10000000-0000-0000-0000-000000000001",
		getService: vi.fn(() => svc),
		getServicesByType: vi.fn(() => (svc ? [svc] : [])),
		logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
	} as unknown as IAgentRuntime;
}

function makeMessage(id: string) {
	return {
		id,
		roomId: "room-1",
		entityId: "entity-1",
		content: { text: "hello", channelType: "dm" },
		metadata: undefined as Record<string, unknown> | undefined,
	};
}

describe("trajectories module surface (#16470)", () => {
	it("no longer exports the removed game-rewards symbols", () => {
		const surface = trajectories as Record<string, unknown>;
		for (const gone of [
			"computeTrajectoryReward",
			"computeStepReward",
			"buildGameStateFromDB",
			"recomputeTrajectoryRewards",
		]) {
			expect(surface[gone]).toBeUndefined();
		}
	});

	it("keeps the live export surface its named consumers import", () => {
		expect(trajectories.TrajectoriesService).toBeTypeOf("function");
		expect(trajectories.trajectoriesPlugin).toBeTypeOf("object");
		expect(trajectoriesPlugin.services).toContain(TrajectoriesService);
	});
});

describe("trajectories plugin event plumbing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("MESSAGE_RECEIVED starts a trajectory + step, stamps metadata, and flushes", async () => {
		const svc = makeFakeService();
		const runtime = makeRuntime(svc);
		const message = makeMessage("msg-start");

		await handler("MESSAGE_RECEIVED")({ runtime, message, source: "chat" });

		expect(svc.startTrajectory).toHaveBeenCalledWith(
			runtime.agentId,
			expect.objectContaining({
				source: "chat",
				metadata: expect.objectContaining({
					roomId: "room-1",
					entityId: "entity-1",
					messageId: "msg-start",
					channelType: "dm",
				}),
			}),
		);
		expect(svc.startStep).toHaveBeenCalledWith("traj-1", expect.anything());
		expect(svc.flushWriteQueue).toHaveBeenCalledWith("traj-1");
		const meta = message.metadata as Record<string, unknown>;
		expect(meta.trajectoryId).toBe("traj-1");
		expect(meta.trajectoryStepId).toBe("step-1");
		expect(typeof meta.traceId).toBe("string");
		expect((meta.traceId as string).length).toBeGreaterThan(0);
	});

	it("MESSAGE_SENT resolves the pending step via inReplyTo and ends the trajectory as completed", async () => {
		const svc = makeFakeService();
		const runtime = makeRuntime(svc);
		const message = makeMessage("msg-reply-chain");
		await handler("MESSAGE_RECEIVED")({ runtime, message, source: "chat" });

		const reply = {
			id: "msg-reply",
			roomId: "room-1",
			entityId: "entity-1",
			content: { inReplyTo: createUniqueUuid(runtime, "msg-reply-chain") },
			metadata: {},
		};
		await handler("MESSAGE_SENT")({ runtime, message: reply });

		expect(svc.endTrajectory).toHaveBeenCalledWith("traj-1", "completed");
	});

	it("RUN_ENDED maps run status to the trajectory final status", async () => {
		const svc = makeFakeService();
		const runtime = makeRuntime(svc);
		const message = makeMessage("msg-run");
		await handler("MESSAGE_RECEIVED")({ runtime, message, source: "chat" });

		await handler("RUN_ENDED")({
			runtime,
			messageId: "msg-run",
			status: "error",
		});
		expect(svc.endTrajectory).toHaveBeenCalledWith("traj-1", "terminated");
	});

	it("RUN_TIMEOUT ends the pending trajectory as timeout", async () => {
		const svc = makeFakeService();
		const runtime = makeRuntime(svc);
		const message = makeMessage("msg-timeout");
		await handler("MESSAGE_RECEIVED")({ runtime, message, source: "chat" });

		await handler("RUN_TIMEOUT")({
			runtime,
			messageId: "msg-timeout",
			status: "timeout",
		});
		expect(svc.endTrajectory).toHaveBeenCalledWith("traj-1", "timeout");
		// The pending maps were cleaned: a second run event is a no-op.
		await handler("RUN_ENDED")({
			runtime,
			messageId: "msg-timeout",
			status: "completed",
		});
		expect(svc.endTrajectory).toHaveBeenCalledTimes(1);
	});

	it("a runtime without the service still mints a traceId and never throws", async () => {
		const runtime = makeRuntime(null);
		const message = makeMessage("msg-no-svc");

		await expect(
			handler("MESSAGE_RECEIVED")({ runtime, message, source: "chat" }),
		).resolves.toBeUndefined();

		const meta = message.metadata as Record<string, unknown>;
		expect(typeof meta.traceId).toBe("string");
		expect(meta.trajectoryId).toBeUndefined();
	});

	it("dispose stops the service resolved from the runtime", async () => {
		const svc = makeFakeService();
		const runtime = makeRuntime(svc);
		await (
			trajectoriesPlugin as unknown as {
				dispose: (r: IAgentRuntime) => Promise<void>;
			}
		).dispose(runtime);
		expect(svc.stop).toHaveBeenCalledTimes(1);
	});
});
