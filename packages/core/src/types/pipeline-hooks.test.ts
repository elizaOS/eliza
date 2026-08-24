/**
 * Unit tests for pipeline-hooks types and helpers: validates context builders
 * and observability timing threshold constants.
 */
import { describe, expect, it } from "vitest";
import {
	afterMemoryPersistedPipelineHookContext,
	composeStateProvidersPipelineHookContext,
	modelStreamChunkPipelineHookContext,
	modelStreamEndPipelineHookContext,
	outgoingPipelineHookContext,
	PIPELINE_HOOK_DEBUG_LOG_MS,
	PIPELINE_HOOK_ERROR_LOG_MS,
	PIPELINE_HOOK_WARN_MS,
	postModelPipelineHookContext,
	preModelPipelineHookContext,
	preShouldRespondPipelineHookContext,
} from "./pipeline-hooks.ts";

describe("pipeline-hooks", () => {
	it("exports standard observability threshold constants", () => {
		expect(PIPELINE_HOOK_DEBUG_LOG_MS).toBe(100);
		expect(PIPELINE_HOOK_WARN_MS).toBe(250);
		expect(PIPELINE_HOOK_ERROR_LOG_MS).toBe(2000);
	});

	it("builds composeStateProviders context with phase tag", () => {
		const ctx = composeStateProvidersPipelineHookContext({
			message: { id: "m1" } as any,
			roomId: "r1" as any,
			providers: { current: ["TIME", "WALLET"] },
			state: {} as any,
			onlyInclude: false,
		});
		expect(ctx.phase).toBe("compose_state_providers");
		expect(ctx.providers.current).toEqual(["TIME", "WALLET"]);
	});

	it("builds preShouldRespond context with phase tag", () => {
		const ctx = preShouldRespondPipelineHookContext({ id: "m1" } as any, {
			roomId: "r1" as any,
			state: {} as any,
			isAutonomous: false,
		});
		expect(ctx.phase).toBe("pre_should_respond");
		expect(ctx.message.id).toBe("m1");
	});

	it("builds outgoingPipelineHookContext correctly", () => {
		const ctx = outgoingPipelineHookContext(
			{ text: "outgoing reply" },
			{
				source: "terminal",
				roomId: "r1" as any,
				streaming: false,
			},
		);
		expect(ctx.phase).toBe("outgoing_before_deliver");
		expect(ctx.content.text).toBe("outgoing reply");
		expect(ctx.source).toBe("terminal");
	});

	it("builds preModel and postModel contexts", () => {
		const pre = preModelPipelineHookContext({
			modelType: "TEXT_LARGE" as any,
			params: { prompt: "test" },
		});
		expect(pre.phase).toBe("pre_model");

		const post = postModelPipelineHookContext({
			modelType: "TEXT_LARGE" as any,
			params: { prompt: "test" },
			output: "generated text",
		});
		expect(post.phase).toBe("post_model");
		expect(post.output).toBe("generated text");
	});

	it("builds afterMemoryPersisted context with updated memory id", () => {
		const ctx = afterMemoryPersistedPipelineHookContext(
			{ id: "old-id", content: { text: "msg" } } as any,
			"messages",
			"new-id" as any,
		);
		expect(ctx.phase).toBe("after_memory_persisted");
		expect(ctx.memoryId).toBe("new-id");
		expect(ctx.memory.id).toBe("new-id");
		expect(ctx.tableName).toBe("messages");
	});

	it("builds modelStreamChunk and modelStreamEnd contexts", () => {
		const chunk = modelStreamChunkPipelineHookContext({
			chunk: "partial text",
			sequence: 1,
		});
		expect(chunk.phase).toBe("model_stream_chunk");
		expect(chunk.chunk).toBe("partial text");

		const end = modelStreamEndPipelineHookContext({
			accumulatedText: "full text",
		});
		expect(end.phase).toBe("model_stream_end");
		expect(end.accumulatedText).toBe("full text");
	});
});
