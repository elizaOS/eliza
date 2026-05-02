import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { parallelWithShouldRespondPipelineHookContext } from "../types/pipeline-hooks";
import { stringToUuid } from "../utils";

describe("parallel_with_should_respond pipeline hooks", () => {
	it("runs registered handlers (concurrent apply)", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "Parallel SR",
				username: "parallel-sr",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		const seen: string[] = [];
		runtime.registerPipelineHook({
			id: "p1",
			phase: "parallel_with_should_respond",
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "parallel_with_should_respond") return;
				await new Promise((r) => setTimeout(r, 5));
				seen.push("p1");
				ctx.setTranslatedUserText("en");
			},
		});
		runtime.registerPipelineHook({
			id: "p2",
			phase: "parallel_with_should_respond",
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "parallel_with_should_respond") return;
				seen.push("p2");
			},
		});

		const message = {
			id: stringToUuid("par-1"),
			entityId: stringToUuid("u-par"),
			agentId: runtime.agentId,
			roomId: stringToUuid("room-par"),
			content: { text: "fr" },
			createdAt: Date.now(),
		};

		let translated = "";
		await runtime.applyPipelineHooks(
			"parallel_with_should_respond",
			parallelWithShouldRespondPipelineHookContext({
				roomId: message.roomId,
				responseId: stringToUuid("r-par"),
				runId: stringToUuid("run-par"),
				message,
				state: { values: {}, data: {}, text: "" },
				room: undefined,
				mentionContext: undefined,
				isAutonomous: false,
				setTranslatedUserText: (t: string) => {
					translated = t;
				},
			}),
		);

		expect(seen).toContain("p1");
		expect(seen).toContain("p2");
		expect(seen.length).toBe(2);
		expect(translated).toBe("en");

		runtime.unregisterPipelineHook("p1");
		runtime.unregisterPipelineHook("p2");
	});

	it("skips when metadata.skipParallelWithShouldRespondHooks is true", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "Parallel SR 2",
				username: "parallel-sr-2",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		let ran = false;
		runtime.registerPipelineHook({
			id: "x",
			phase: "parallel_with_should_respond",
			handler: async () => {
				ran = true;
			},
		});

		const message = {
			id: stringToUuid("par-2"),
			entityId: stringToUuid("u2"),
			agentId: runtime.agentId,
			roomId: stringToUuid("rm2"),
			content: {
				text: "hi",
				metadata: { skipParallelWithShouldRespondHooks: true },
			},
			createdAt: Date.now(),
		};

		await runtime.applyPipelineHooks(
			"parallel_with_should_respond",
			parallelWithShouldRespondPipelineHookContext({
				roomId: message.roomId,
				responseId: stringToUuid("r1"),
				runId: stringToUuid("r2"),
				message,
				state: { values: {}, data: {}, text: "" },
				room: undefined,
				isAutonomous: false,
				setTranslatedUserText: () => {},
			}),
		);

		expect(ran).toBe(false);
		runtime.unregisterPipelineHook("x");
	});
});
