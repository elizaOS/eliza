import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import {
	getModelStreamChunkDeliveryDepth,
	runWithStreamingContext,
} from "../streaming-context";
import { EventType } from "../types/events";
import { ModelType } from "../types/model";
import { modelStreamChunkPipelineHookContext } from "../types/pipeline-hooks";
import { stringToUuid } from "../utils";

describe("pre_model / post_model pipeline hooks", () => {
	it("pre_model can mutate params before the handler runs", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "ModelHook",
				username: "mh",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_rt, p) => {
				const rec = p as { prompt?: string };
				return `[${rec.prompt ?? ""}]`;
			},
			"test",
			10,
		);
		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		runtime.registerPipelineHook({
			id: "prefix-prompt",
			phase: "pre_model",
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "pre_model") return;
				const rec = ctx.params as { prompt?: string };
				if (typeof rec.prompt === "string") {
					rec.prompt = `PREFIX:${rec.prompt}`;
				}
			},
		});

		const out = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "hello",
		});
		expect(out).toBe("[PREFIX:hello]");

		runtime.unregisterPipelineHook("prefix-prompt");
	});

	it("post_model can replace useModel return value", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "ModelHook2",
				username: "mh2",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});
		runtime.registerModel(ModelType.TEXT_SMALL, async () => "raw", "test", 10);
		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		runtime.registerPipelineHook({
			id: "wrap-result",
			phase: "post_model",
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "post_model") return;
				if (typeof ctx.result.current === "string") {
					ctx.result.current = `<<${ctx.result.current}>>`;
				}
			},
		});

		const out = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "x",
		});
		expect(out).toBe("<<raw>>");

		runtime.unregisterPipelineHook("wrap-result");
	});
});

describe("useModel stream pipeline hooks", () => {
	it("invokes model_stream_chunk and model_stream_end for textStream", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "UseModelStream",
				username: "ums",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => ({
				text: Promise.resolve("hi"),
				textStream: (async function* () {
					yield "h";
					yield "i";
				})(),
				usage: Promise.resolve(undefined),
				finishReason: Promise.resolve("stop"),
			}),
			"test",
			10,
		);
		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		const chunks: string[] = [];
		let endText = "";
		runtime.registerPipelineHook({
			id: "um-chunk",
			phase: "model_stream_chunk",
			handler: async (_rt, ctx) => {
				if (ctx.phase === "model_stream_chunk" && ctx.source === "use_model") {
					chunks.push(ctx.chunk);
				}
			},
		});
		runtime.registerPipelineHook({
			id: "um-end",
			phase: "model_stream_end",
			handler: async (_rt, ctx) => {
				if (ctx.phase === "model_stream_end" && ctx.source === "use_model") {
					endText = ctx.text ?? "";
				}
			},
		});

		let depthDuringCtx = -1;
		await runWithStreamingContext(
			{
				messageId: "stream-msg-1",
				onStreamChunk: async () => {
					depthDuringCtx = getModelStreamChunkDeliveryDepth();
				},
			},
			() =>
				runtime.useModel(ModelType.TEXT_SMALL, {
					prompt: "x",
					stream: true,
				}),
		);

		expect(depthDuringCtx).toBeGreaterThanOrEqual(1);
		expect(chunks).toEqual(["h", "i"]);
		expect(endText).toBe("hi");

		runtime.unregisterPipelineHook("um-chunk");
		runtime.unregisterPipelineHook("um-end");
	});
});

describe("model_stream_chunk pipeline hook", () => {
	it("defaults to no PIPELINE_HOOK_METRIC per invocation (high-frequency safe)", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "StreamHook",
				username: "sh",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});
		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		const metrics: unknown[] = [];
		runtime.registerEvent(EventType.PIPELINE_HOOK_METRIC, async (p) => {
			metrics.push(p);
		});

		runtime.registerPipelineHook({
			id: "chunk-obs",
			phase: "model_stream_chunk",
			handler: async () => {},
		});

		const roomId = stringToUuid("room-chunk");
		await runtime.applyPipelineHooks(
			"model_stream_chunk",
			modelStreamChunkPipelineHookContext({
				source: "message_service",
				chunk: "a",
				roomId,
				runId: runtime.getCurrentRunId(),
			}),
		);
		await runtime.applyPipelineHooks(
			"model_stream_chunk",
			modelStreamChunkPipelineHookContext({
				source: "message_service",
				chunk: "b",
				roomId,
				runId: runtime.getCurrentRunId(),
			}),
		);

		expect(metrics).toHaveLength(0);

		await runtime.applyPipelineHooks(
			"model_stream_chunk",
			modelStreamChunkPipelineHookContext({
				source: "message_service",
				chunk: "c",
				roomId,
				runId: runtime.getCurrentRunId(),
			}),
			true,
		);
		expect(metrics.length).toBeGreaterThanOrEqual(1);

		runtime.unregisterPipelineHook("chunk-obs");
	});
});

describe("after_memory_persisted pipeline hook", () => {
	it("runs after createMemory with persisted id", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "MemHook",
				username: "mem",
				clients: [],
				settings: {},
			},
			adapter: new InMemoryDatabaseAdapter(),
		});
		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		const seen: Array<{ id: string; table: string }> = [];
		runtime.registerPipelineHook({
			id: "persisted",
			phase: "after_memory_persisted",
			handler: async (_rt, ctx) => {
				if (ctx.phase !== "after_memory_persisted") return;
				seen.push({
					id: ctx.memoryId,
					table: ctx.tableName,
				});
				expect(ctx.memory.id).toBe(ctx.memoryId);
			},
		});

		const roomId = stringToUuid("room-mem-hook");
		const id = await runtime.createMemory(
			{
				entityId: stringToUuid("ent-m"),
				agentId: runtime.agentId,
				roomId,
				content: { text: "stored" },
				createdAt: Date.now(),
			},
			"messages",
		);
		expect(seen).toEqual([{ id, table: "messages" }]);

		runtime.unregisterPipelineHook("persisted");
	});
});
