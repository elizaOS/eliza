/**
 * Runtime-event trajectory lifecycle tests use deterministic service doubles to
 * exercise correlation ownership, terminal coalescing, and bounded retry.
 */

import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createUniqueUuid } from "../../entities";
import type { IAgentRuntime, Memory } from "../../types";
import { trajectoriesPlugin } from "./index";
import { TrajectoriesService } from "./TrajectoriesService";

type Handler = (payload: Record<string, unknown>) => Promise<void>;

function handler(
	event: "MESSAGE_RECEIVED" | "MESSAGE_SENT" | "RUN_ENDED",
): Handler {
	const registered = (trajectoriesPlugin.events as Record<string, Handler[]>)[
		event
	]?.[0];
	if (!registered) throw new Error(`Missing ${event} trajectory handler`);
	return registered;
}

function makeHarness() {
	const agentId = crypto.randomUUID();
	let sequence = 0;
	const logger = Object.create(
		TrajectoriesService.prototype,
	) as TrajectoriesService & {
		startTrajectory: ReturnType<typeof vi.fn>;
		startStep: ReturnType<typeof vi.fn>;
		flushWriteQueue: ReturnType<typeof vi.fn>;
		endTrajectory: ReturnType<typeof vi.fn>;
		releaseTrajectoryOwnership: ReturnType<typeof vi.fn>;
	};
	Object.assign(logger, {
		startTrajectory: vi.fn(async () => `${agentId}-trajectory-${++sequence}`),
		startStep: vi.fn((trajectoryId: string) => `${trajectoryId}-step`),
		flushWriteQueue: vi.fn(async () => {}),
		endTrajectory: vi.fn(async () => {}),
		releaseTrajectoryOwnership: vi.fn(),
	});
	const runtime = {
		agentId,
		getService: (type: string) => (type === "trajectories" ? logger : null),
		getServicesByType: (type: string) =>
			type === "trajectories" ? [logger] : [],
		getRoom: async () => null,
		reportError: vi.fn(),
		logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
	} as unknown as IAgentRuntime;
	return { runtime, logger };
}

function message(runtime: IAgentRuntime, id = crypto.randomUUID()): Memory {
	return {
		id,
		agentId: runtime.agentId,
		entityId: runtime.agentId,
		roomId: crypto.randomUUID(),
		createdAt: Date.now(),
		content: { text: "trajectory lifecycle", source: "test" },
	};
}

describe("trajectoriesPlugin lifecycle ownership", () => {
	it("scopes identical message ids to their runtime", async () => {
		const first = makeHarness();
		const second = makeHarness();
		const sharedId = crypto.randomUUID();
		const firstMessage = message(first.runtime, sharedId);
		const secondMessage = message(second.runtime, sharedId);

		await handler("MESSAGE_RECEIVED")({
			runtime: first.runtime,
			message: firstMessage,
		});
		await handler("MESSAGE_RECEIVED")({
			runtime: second.runtime,
			message: secondMessage,
		});
		await Promise.all([
			handler("RUN_ENDED")({
				runtime: first.runtime,
				messageId: sharedId,
				status: "completed",
			}),
			handler("RUN_ENDED")({
				runtime: second.runtime,
				messageId: sharedId,
				status: "error",
			}),
		]);

		expect(first.logger.endTrajectory).toHaveBeenCalledWith(
			expect.stringContaining(first.runtime.agentId),
			"completed",
		);
		expect(second.logger.endTrajectory).toHaveBeenCalledWith(
			expect.stringContaining(second.runtime.agentId),
			"terminated",
		);
	});

	it("atomically claims one concurrent terminal owner", async () => {
		const { runtime, logger } = makeHarness();
		const input = message(runtime);
		await handler("MESSAGE_RECEIVED")({ runtime, message: input });
		let release: (() => void) | undefined;
		logger.endTrajectory.mockImplementationOnce(
			() => new Promise<void>((resolve) => (release = resolve)),
		);

		const first = handler("RUN_ENDED")({
			runtime,
			messageId: input.id,
			status: "completed",
		});
		const second = handler("RUN_ENDED")({
			runtime,
			messageId: input.id,
			status: "error",
		});
		expect(logger.endTrajectory).toHaveBeenCalledTimes(1);
		release?.();
		await Promise.all([first, second]);
		expect(logger.endTrajectory).toHaveBeenCalledTimes(1);
	});

	it("keeps a live run open at delivery and terminalizes it exactly once at RUN_ENDED", async () => {
		const { runtime, logger } = makeHarness();
		const input = message(runtime);
		await handler("MESSAGE_RECEIVED")({ runtime, message: input });
		const reply = {
			...message(runtime),
			content: {
				text: "delivered",
				inReplyTo: createUniqueUuid(runtime, input.id as string),
			},
		};

		await handler("MESSAGE_SENT")({
			runtime,
			message: reply,
			trajectoryTerminalOwner: "run",
		});
		expect(logger.endTrajectory).not.toHaveBeenCalled();

		await handler("RUN_ENDED")({
			runtime,
			messageId: input.id,
			status: "completed",
		});
		await handler("RUN_ENDED")({
			runtime,
			messageId: input.id,
			status: "completed",
		});
		expect(logger.endTrajectory).toHaveBeenCalledTimes(1);
		expect(logger.endTrajectory).toHaveBeenCalledWith(
			expect.stringContaining(runtime.agentId),
			"completed",
		);
	});

	it("retains MESSAGE_SENT as the terminal fallback without a run owner", async () => {
		const { runtime, logger } = makeHarness();
		const input = message(runtime);
		await handler("MESSAGE_RECEIVED")({ runtime, message: input });
		const reply = {
			...message(runtime),
			content: {
				text: "delivered",
				inReplyTo: createUniqueUuid(runtime, input.id as string),
			},
		};

		await handler("MESSAGE_SENT")({ runtime, message: reply });

		expect(logger.endTrajectory).toHaveBeenCalledOnce();
		expect(logger.endTrajectory).toHaveBeenCalledWith(
			expect.stringContaining(runtime.agentId),
			"completed",
		);
	});

	it("keeps concurrent rooms independent until each run reaches its own terminal", async () => {
		const { runtime, logger } = makeHarness();
		const first = message(runtime);
		const second = message(runtime);
		await handler("MESSAGE_RECEIVED")({ runtime, message: first });
		await handler("MESSAGE_RECEIVED")({ runtime, message: second });

		for (const input of [first, second]) {
			await handler("MESSAGE_SENT")({
				runtime,
				message: {
					...message(runtime),
					roomId: input.roomId,
					content: {
						text: "delivered",
						inReplyTo: createUniqueUuid(runtime, input.id as string),
					},
				},
				trajectoryTerminalOwner: "run",
			});
		}
		expect(logger.endTrajectory).not.toHaveBeenCalled();

		await handler("RUN_ENDED")({
			runtime,
			messageId: first.id,
			status: "completed",
		});
		expect(logger.endTrajectory).toHaveBeenCalledTimes(1);
		const firstTrajectoryId = logger.endTrajectory.mock.calls[0]?.[0];

		await handler("RUN_ENDED")({
			runtime,
			messageId: second.id,
			status: "completed",
		});
		expect(logger.endTrajectory).toHaveBeenCalledTimes(2);
		expect(logger.endTrajectory.mock.calls[1]?.[0]).not.toBe(firstTrajectoryId);
	});

	it("retries one terminal failure without releasing durable ownership", async () => {
		const { runtime, logger } = makeHarness();
		const input = message(runtime);
		await handler("MESSAGE_RECEIVED")({ runtime, message: input });
		logger.endTrajectory
			.mockRejectedValueOnce(new Error("transient storage failure"))
			.mockResolvedValueOnce(undefined);

		await handler("RUN_ENDED")({
			runtime,
			messageId: input.id,
			status: "completed",
		});

		expect(logger.endTrajectory).toHaveBeenCalledTimes(2);
		expect(logger.releaseTrajectoryOwnership).not.toHaveBeenCalled();
		expect(runtime.reportError).toHaveBeenCalledWith(
			"TrajectoriesPlugin.endRetry",
			expect.any(Error),
			expect.objectContaining({ diagnosticOnly: true, attempt: 1 }),
		);
	});

	it("does not persist or correlate a message without an id", async () => {
		const { runtime, logger } = makeHarness();
		const input = message(runtime);
		delete (input as { id?: string }).id;

		await handler("MESSAGE_RECEIVED")({ runtime, message: input });

		expect(logger.startTrajectory).not.toHaveBeenCalled();
		expect(input.metadata).toBeUndefined();
		expect(runtime.reportError).toHaveBeenCalledWith(
			"TrajectoriesPlugin.start",
			expect.objectContaining({ code: "TRAJECTORY_MESSAGE_ID_REQUIRED" }),
			expect.objectContaining({ diagnosticOnly: true }),
		);
	});
});
