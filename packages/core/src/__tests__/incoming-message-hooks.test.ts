import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { incomingPipelineHookContext } from "../types/pipeline-hooks";
import { stringToUuid } from "../utils";

describe("incoming pipeline hooks (incoming_before_compose)", () => {
	it("runs handlers in registration order and mutates message text", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "Hook Test",
				username: "hook-test",
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
			id: "a",
			phase: "incoming_before_compose",
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "incoming_before_compose") return;
				order.push("a");
				ctx.message.content.text = `${ctx.message.content.text || ""}[a]`;
			},
		});
		runtime.registerPipelineHook({
			id: "b",
			phase: "incoming_before_compose",
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "incoming_before_compose") return;
				order.push("b");
				ctx.message.content.text = `${ctx.message.content.text || ""}[b]`;
			},
		});

		const message = {
			id: stringToUuid("test-msg-1"),
			entityId: stringToUuid("user-1"),
			agentId: runtime.agentId,
			roomId: stringToUuid("room-1"),
			content: { text: "hello" },
			createdAt: Date.now(),
		};

		await runtime.applyPipelineHooks(
			"incoming_before_compose",
			incomingPipelineHookContext(message, {
				roomId: message.roomId,
				responseId: stringToUuid("resp-1"),
				runId: stringToUuid("run-1"),
			}),
		);

		expect(order).toEqual(["a", "b"]);
		expect(message.content.text).toBe("hello[a][b]");

		runtime.unregisterPipelineHook("a");
		runtime.unregisterPipelineHook("b");
	});

	it("skips when metadata.skipIncomingMessageHooks is true", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "Hook Test 2",
				username: "hook-test-2",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		runtime.registerPipelineHook({
			id: "x",
			phase: "incoming_before_compose",
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "incoming_before_compose") return;
				ctx.message.content.text = "mutated";
			},
		});

		const message = {
			id: stringToUuid("test-msg-2"),
			entityId: stringToUuid("user-2"),
			agentId: runtime.agentId,
			roomId: stringToUuid("room-2"),
			content: {
				text: "hello",
				metadata: { skipIncomingMessageHooks: true },
			},
			createdAt: Date.now(),
		};

		await runtime.applyPipelineHooks(
			"incoming_before_compose",
			incomingPipelineHookContext(message, {
				roomId: message.roomId,
				responseId: stringToUuid("resp-2"),
				runId: stringToUuid("run-2"),
			}),
		);

		expect(message.content.text).toBe("hello");
		runtime.unregisterPipelineHook("x");
	});
});
