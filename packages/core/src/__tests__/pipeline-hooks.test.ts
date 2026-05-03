import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { EventType, type PipelineHookMetricPayload } from "../types/events";
import {
	incomingPipelineHookContext,
	PIPELINE_HOOK_WARN_MS,
	preShouldRespondPipelineHookContext,
} from "../types/pipeline-hooks";
import { stringToUuid } from "../utils";

describe("registerPipelineHook scheduling", () => {
	it("runs mutators serially before concurrent read-only hooks (incoming phase)", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "Pipeline",
				username: "pipeline",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});
		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		const order: string[] = [];
		let barrier = 0;

		runtime.registerPipelineHook({
			id: "concurrent-reader",
			phase: "incoming_before_compose",
			schedule: "concurrent",
			mutatesPrimary: false,
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "incoming_before_compose") return;
				await new Promise((r) => setTimeout(r, 15));
				order.push(`reader:${ctx.message.content.text}`);
			},
		});

		runtime.registerPipelineHook({
			id: "mutator",
			phase: "incoming_before_compose",
			schedule: "concurrent",
			mutatesPrimary: true,
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "incoming_before_compose") return;
				barrier += 1;
				order.push("mutator-start");
				ctx.message.content.text = "B";
				order.push("mutator-end");
			},
		});

		const message = {
			id: stringToUuid("pipe-1"),
			entityId: stringToUuid("ent-p"),
			agentId: runtime.agentId,
			roomId: stringToUuid("room-p"),
			content: { text: "A" },
			createdAt: Date.now(),
		};

		await runtime.applyPipelineHooks(
			"incoming_before_compose",
			incomingPipelineHookContext(message, {
				roomId: message.roomId,
				responseId: stringToUuid("resp-p"),
				runId: stringToUuid("run-p"),
			}),
		);

		expect(barrier).toBe(1);
		expect(order[0]).toBe("mutator-start");
		expect(order[1]).toBe("mutator-end");
		expect(order[2]).toBe("reader:B");
		expect(message.content.text).toBe("B");

		runtime.unregisterPipelineHook("mutator");
		runtime.unregisterPipelineHook("concurrent-reader");
	});

	it("replaces by id across registry (same id moves phase)", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "Pipeline2",
				username: "pipeline2",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});
		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		let incomingRan = false;
		runtime.registerPipelineHook({
			id: "shared",
			phase: "incoming_before_compose",
			handler: async () => {
				incomingRan = true;
			},
		});

		let preRan = false;
		runtime.registerPipelineHook({
			id: "shared",
			phase: "pre_should_respond",
			handler: async (_rt, ctx) => {
				if (ctx.phase === "pre_should_respond") {
					preRan = true;
				}
			},
		});

		const message = {
			id: stringToUuid("pipe-2"),
			entityId: stringToUuid("e2"),
			agentId: runtime.agentId,
			roomId: stringToUuid("r2"),
			content: { text: "x" },
			createdAt: Date.now(),
		};
		const ctxBase = {
			roomId: message.roomId,
			responseId: stringToUuid("resp2"),
			runId: stringToUuid("run2"),
		};

		await runtime.applyPipelineHooks(
			"incoming_before_compose",
			incomingPipelineHookContext(message, ctxBase),
		);
		expect(incomingRan).toBe(false);

		await runtime.applyPipelineHooks(
			"pre_should_respond",
			preShouldRespondPipelineHookContext(message, {
				...ctxBase,
				state: { values: {}, data: {}, text: "" },
				isAutonomous: false,
			}),
		);
		expect(preRan).toBe(true);

		runtime.unregisterPipelineHook("shared");
	});

	it("orders hooks by position then id (provider-style)", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "Pos",
				username: "pos",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});
		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		const order: string[] = [];
		runtime.registerPipelineHook({
			id: "z-first-position",
			phase: "incoming_before_compose",
			position: 0,
			mutatesPrimary: true,
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "incoming_before_compose") return;
				order.push("z");
			},
		});
		runtime.registerPipelineHook({
			id: "a-second-position",
			phase: "incoming_before_compose",
			position: 10,
			mutatesPrimary: true,
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "incoming_before_compose") return;
				order.push("a");
			},
		});

		const message = {
			id: stringToUuid("pos-1"),
			entityId: stringToUuid("e-pos"),
			agentId: runtime.agentId,
			roomId: stringToUuid("r-pos"),
			content: { text: "x" },
			createdAt: Date.now(),
		};
		await runtime.applyPipelineHooks(
			"incoming_before_compose",
			incomingPipelineHookContext(message, {
				roomId: message.roomId,
				responseId: stringToUuid("rp"),
				runId: stringToUuid("rn"),
			}),
		);

		expect(order).toEqual(["z", "a"]);
		runtime.unregisterPipelineHook("z-first-position");
		runtime.unregisterPipelineHook("a-second-position");
	});

	it("emits PIPELINE_HOOK_METRIC per hook; slow when duration exceeds warn threshold", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "Metric",
				username: "metric",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});
		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		const metrics: PipelineHookMetricPayload[] = [];
		runtime.registerEvent(EventType.PIPELINE_HOOK_METRIC, async (p) => {
			metrics.push(p);
		});

		runtime.registerPipelineHook({
			id: "fast-hook",
			phase: "incoming_before_compose",
			handler: async () => {},
		});
		runtime.registerPipelineHook({
			id: "slow-hook",
			phase: "incoming_before_compose",
			handler: async () => {
				await new Promise((r) => setTimeout(r, PIPELINE_HOOK_WARN_MS + 80));
			},
		});

		const message = {
			id: stringToUuid("met-1"),
			entityId: stringToUuid("e-met"),
			agentId: runtime.agentId,
			roomId: stringToUuid("r-met"),
			content: { text: "x" },
			createdAt: Date.now(),
		};
		await runtime.applyPipelineHooks(
			"incoming_before_compose",
			incomingPipelineHookContext(message, {
				roomId: message.roomId,
				responseId: stringToUuid("resp-m"),
				runId: stringToUuid("run-m"),
			}),
		);

		expect(metrics).toHaveLength(2);
		const fast = metrics.find((m) => m.hookId === "fast-hook");
		const slow = metrics.find((m) => m.hookId === "slow-hook");
		expect(fast?.slow).toBe(false);
		expect(slow?.slow).toBe(true);
		expect(slow?.durationMs).toBeGreaterThanOrEqual(PIPELINE_HOOK_WARN_MS);

		runtime.unregisterPipelineHook("fast-hook");
		runtime.unregisterPipelineHook("slow-hook");
	});
});
