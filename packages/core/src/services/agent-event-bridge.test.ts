import { describe, expect, it } from "vitest";
import type { AgentEventPayload } from "../types/agentEvent.ts";
import type {
	ActionEventPayload,
	EvaluatorEventPayload,
	MessagePayload,
} from "../types/events.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { ServiceType } from "../types/service.ts";
import {
	bridgeActionCompletedToStreams,
	bridgeActionStartedToStreams,
	bridgeEvaluatorCompletedToStreams,
	bridgeEvaluatorStartedToStreams,
	bridgeMessageReceivedToStreams,
	bridgeRunEndedToStreams,
	bridgeRunStartedToStreams,
} from "./agent-event-bridge.ts";
import { AgentEventService } from "./agentEvent.ts";

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const ROOM_ID = "22222222-2222-2222-2222-222222222222";
const WORLD_ID = "33333333-3333-3333-3333-333333333333";

async function createCtx(opts: { withService?: boolean } = {}): Promise<{
	runtime: IAgentRuntime;
	events: AgentEventPayload[];
}> {
	const withService = opts.withService ?? true;
	const events: AgentEventPayload[] = [];

	const runtimeBase = {
		agentId: "00000000-0000-0000-0000-0000000000aa",
		getCurrentRunId: () => RUN_ID,
	} as unknown as IAgentRuntime;

	let service: AgentEventService | null = null;
	if (withService) {
		service = (await AgentEventService.start(runtimeBase)) as AgentEventService;
		service.subscribe((event) => events.push(event));
	}

	const runtime = {
		...runtimeBase,
		getService: (type: string) =>
			type === ServiceType.AGENT_EVENT ? service : null,
	} as unknown as IAgentRuntime;

	return { runtime, events };
}

function actionPayload(
	runtime: IAgentRuntime,
	actionName: string,
	status: "executing" | "completed" | "failed",
): ActionEventPayload {
	return {
		runtime,
		roomId: ROOM_ID,
		world: WORLD_ID,
		content: {
			text: `Executing action: ${actionName}`,
			actions: [actionName],
			actionStatus: status,
			source: "client_chat",
		},
	} as unknown as ActionEventPayload;
}

describe("agent-event-bridge", () => {
	it("populates the action + lifecycle streams on ACTION_STARTED", async () => {
		const { runtime, events } = await createCtx();
		bridgeActionStartedToStreams(
			actionPayload(runtime, "WEB_SEARCH", "executing"),
		);

		const action = events.find((e) => e.stream === "action");
		expect(action).toBeDefined();
		expect(action?.runId).toBe(RUN_ID);
		expect(action?.data).toMatchObject({
			type: "start",
			actionName: "WEB_SEARCH",
		});

		const lifecycle = events.find((e) => e.stream === "lifecycle");
		expect(lifecycle?.data).toMatchObject({
			type: "action_start",
			actionName: "WEB_SEARCH",
		});
	});

	it("populates the action stream with success on ACTION_COMPLETED", async () => {
		const { runtime, events } = await createCtx();
		bridgeActionCompletedToStreams(
			actionPayload(runtime, "WEB_SEARCH", "completed"),
		);
		const action = events.find((e) => e.stream === "action");
		expect(action?.data).toMatchObject({
			type: "complete",
			actionName: "WEB_SEARCH",
			success: true,
		});
	});

	it("reports success=false when the action failed", async () => {
		const { runtime, events } = await createCtx();
		bridgeActionCompletedToStreams(actionPayload(runtime, "REPLY", "failed"));
		const action = events.find((e) => e.stream === "action");
		expect(action?.data).toMatchObject({ type: "complete", success: false });
	});

	it("populates the message stream on MESSAGE_RECEIVED (connector inbound)", async () => {
		const { runtime, events } = await createCtx();
		bridgeMessageReceivedToStreams({
			runtime,
			message: {
				id: "44444444-4444-4444-4444-444444444444",
				roomId: ROOM_ID,
				entityId: "55555555-5555-5555-5555-555555555555",
				content: { text: "hello from discord", attachments: [] },
			},
		} as unknown as MessagePayload);

		const message = events.find((e) => e.stream === "message");
		expect(message).toBeDefined();
		expect(message?.runId).toBe(RUN_ID);
		expect(message?.data).toMatchObject({
			type: "received",
			content: "hello from discord",
			roomId: ROOM_ID,
			hasAttachments: false,
		});
	});

	it("no-ops MESSAGE_RECEIVED when the AgentEventService is absent", async () => {
		const { runtime, events } = await createCtx({ withService: false });
		bridgeMessageReceivedToStreams({
			runtime,
			message: {
				id: "44444444-4444-4444-4444-444444444444",
				content: { text: "x" },
			},
		} as unknown as MessagePayload);
		expect(events).toHaveLength(0);
	});

	it("populates the lifecycle stream on RUN_STARTED / RUN_ENDED", async () => {
		const { runtime, events } = await createCtx();
		bridgeRunStartedToStreams({
			runtime,
			runId: RUN_ID,
			messageId: ROOM_ID,
			roomId: ROOM_ID,
			entityId: WORLD_ID,
			startTime: 1,
			status: "started",
		} as unknown as Parameters<typeof bridgeRunStartedToStreams>[0]);
		bridgeRunEndedToStreams({
			runtime,
			runId: RUN_ID,
			messageId: ROOM_ID,
			roomId: ROOM_ID,
			entityId: WORLD_ID,
			startTime: 1,
			endTime: 6,
			duration: 5,
			status: "completed",
		} as unknown as Parameters<typeof bridgeRunEndedToStreams>[0]);

		const lifecycleTypes = events
			.filter((e) => e.stream === "lifecycle")
			.map((e) => e.data.type);
		expect(lifecycleTypes).toContain("run_start");
		expect(lifecycleTypes).toContain("run_end");
		const runEnd = events.find(
			(e) => e.stream === "lifecycle" && e.data.type === "run_end",
		);
		expect(runEnd?.data).toMatchObject({ success: true, duration: 5 });
	});

	it("clears per-run sequence state after RUN_ENDED (no map leak)", async () => {
		const { runtime } = await createCtx();
		const service = runtime.getService(
			ServiceType.AGENT_EVENT,
		) as AgentEventService;
		bridgeRunStartedToStreams({
			runtime,
			runId: RUN_ID,
			messageId: ROOM_ID,
			roomId: ROOM_ID,
			entityId: WORLD_ID,
			startTime: 1,
			status: "started",
		} as unknown as Parameters<typeof bridgeRunStartedToStreams>[0]);
		expect(service.getCurrentSeq(RUN_ID)).toBeGreaterThan(0);
		bridgeRunEndedToStreams({
			runtime,
			runId: RUN_ID,
			messageId: ROOM_ID,
			roomId: ROOM_ID,
			entityId: WORLD_ID,
			startTime: 1,
			endTime: 2,
			status: "completed",
		} as unknown as Parameters<typeof bridgeRunEndedToStreams>[0]);
		// seq reset to 0 → run context dropped.
		expect(service.getCurrentSeq(RUN_ID)).toBe(0);
	});

	it("populates the evaluator stream on EVALUATOR_STARTED / COMPLETED", async () => {
		const { runtime, events } = await createCtx();
		const base = {
			runtime,
			evaluatorId: WORLD_ID,
			evaluatorName: "post_turn",
		} as unknown as EvaluatorEventPayload;
		bridgeEvaluatorStartedToStreams(base);
		bridgeEvaluatorCompletedToStreams({
			...base,
			completed: true,
		} as EvaluatorEventPayload);

		const evals = events.filter((e) => e.stream === "evaluator");
		expect(evals.map((e) => e.data.type)).toEqual(["start", "complete"]);
		expect(evals[1]?.data).toMatchObject({
			evaluatorName: "post_turn",
			validated: true,
		});
	});

	it("is a no-op (never throws) when AgentEventService is absent", async () => {
		const { runtime, events } = await createCtx({ withService: false });
		expect(() =>
			bridgeActionStartedToStreams(
				actionPayload(runtime, "WEB_SEARCH", "executing"),
			),
		).not.toThrow();
		expect(events).toHaveLength(0);
	});

	it("falls back to the runtime current run id when the payload omits one", async () => {
		const { runtime, events } = await createCtx();
		// payload content has no runId → bridge uses runtime.getCurrentRunId()
		bridgeActionStartedToStreams(actionPayload(runtime, "REPLY", "executing"));
		expect(events[0]?.runId).toBe(RUN_ID);
	});
});
