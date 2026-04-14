import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { preShouldRespondPipelineHookContext } from "../types/pipeline-hooks";
import { stringToUuid } from "../utils";

describe("pre_should_respond pipeline hooks", () => {
	it("receives state and isAutonomous; can mutate message", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "Pre SR Hook Test",
				username: "pre-sr-hook",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		let sawState = false;
		let sawAutonomous = false;
		runtime.registerPipelineHook({
			id: "t",
			phase: "pre_should_respond",
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "pre_should_respond") return;
				sawState = ctx.state !== undefined && typeof ctx.state === "object";
				sawAutonomous = ctx.isAutonomous === true;
				ctx.message.content.text = `${ctx.message.content.text || ""}-touched`;
			},
		});

		const message = {
			id: stringToUuid("pre-sr-1"),
			entityId: stringToUuid("user-pre-sr"),
			agentId: runtime.agentId,
			roomId: stringToUuid("room-pre-sr"),
			content: {
				text: "hi",
				metadata: { isAutonomous: true },
			},
			createdAt: Date.now(),
		};

		const state = { values: {}, data: {}, text: "" };

		await runtime.applyPipelineHooks(
			"pre_should_respond",
			preShouldRespondPipelineHookContext(message, {
				roomId: message.roomId,
				responseId: stringToUuid("resp-pre-sr"),
				runId: stringToUuid("run-pre-sr"),
				state,
				isAutonomous: true,
			}),
		);

		expect(sawState).toBe(true);
		expect(sawAutonomous).toBe(true);
		expect(message.content.text).toBe("hi-touched");

		runtime.unregisterPipelineHook("t");
	});

	it("skips when metadata.skipPreShouldRespondHooks is true", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "Pre SR Hook Test 2",
				username: "pre-sr-hook-2",
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
			phase: "pre_should_respond",
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "pre_should_respond") return;
				ctx.message.content.text = "gone";
			},
		});

		const message = {
			id: stringToUuid("pre-sr-2"),
			entityId: stringToUuid("user-2"),
			agentId: runtime.agentId,
			roomId: stringToUuid("room-2"),
			content: {
				text: "hi",
				metadata: { skipPreShouldRespondHooks: true },
			},
			createdAt: Date.now(),
		};

		await runtime.applyPipelineHooks(
			"pre_should_respond",
			preShouldRespondPipelineHookContext(message, {
				roomId: message.roomId,
				responseId: stringToUuid("r1"),
				runId: stringToUuid("r2"),
				state: { values: {}, data: {}, text: "" },
				isAutonomous: false,
			}),
		);

		expect(message.content.text).toBe("hi");
		runtime.unregisterPipelineHook("x");
	});
});
