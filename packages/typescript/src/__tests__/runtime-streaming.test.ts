import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import {
  getStreamingContextManager,
  type IStreamingContextManager,
  runWithStreamingContext,
  type StreamingContext,
  setStreamingContextManager,
} from "../streaming-context";
import { createNodeStreamingContextManager } from "../streaming-context.node";
import type { Character, IDatabaseAdapter } from "../types";
import {
  type GenerateTextParams,
  ModelType,
  type TextStreamResult,
} from "../types/model";
import { stringToUuid } from "../utils";

/**
 * Minimal mock adapter for testing AgentRuntime streaming.
 * Uses a Proxy to return mock implementations for all methods.
 * Caches mock functions so they can be inspected later.
 */
function createMinimalMockAdapter(): IDatabaseAdapter {
  const mockCache: Record<string, ReturnType<typeof mock>> = {};
  return new Proxy({} as IDatabaseAdapter, {
    get: (_target, prop) => {
      if (prop === "db") return {};
      const propStr = String(prop);
      if (!mockCache[propStr]) {
        mockCache[propStr] = vi.fn().mockResolvedValue(null);
      }
      return mockCache[propStr];
    },
  });
}

describe("useModel Streaming", () => {
  let runtime: AgentRuntime;
  let originalManager: IStreamingContextManager;

  const mockCharacter: Character = {
    id: stringToUuid("test-streaming"),
    name: "StreamBot",
    bio: ["A bot for testing streaming"],
    templates: {},
    messageExamples: [],
    postExamples: [],
    topics: [],
    adjectives: [],
    knowledge: [],
    plugins: [],
    secrets: {},
  };

  // Helper to create a mock TextStreamResult
  function createMockTextStreamResult(chunks: string[]): TextStreamResult {
    let index = 0;
    return {
      textStream: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (index < chunks.length) {
              return { value: chunks[index++], done: false };
            }
            return { value: undefined, done: true };
          },
        }),
      } as AsyncIterable<string>,
      text: Promise.resolve(chunks.join("")),
      usage: Promise.resolve({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      }),
      finishReason: Promise.resolve("stop" as const),
    };
  }

  beforeEach(() => {
    originalManager = getStreamingContextManager();
    setStreamingContextManager(createNodeStreamingContextManager());

    runtime = new AgentRuntime({
      agentId: stringToUuid("test-streaming-agent"),
      character: mockCharacter,
      adapter: createMinimalMockAdapter(),
    });
  });

  afterEach(() => {
    setStreamingContextManager(originalManager);
  });

  describe("onStreamChunk callback in params", () => {
    it("should call onStreamChunk for each chunk when handler returns TextStreamResult", async () => {
      const chunks: string[] = [];
      const mockChunks = ["Hello", " ", "World", "!"];

      // Register a mock handler that returns TextStreamResult when stream: true
      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          if (textParams.stream) {
            return createMockTextStreamResult(mockChunks);
          }
          return mockChunks.join("");
        },
        "test-provider",
      );

      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Test prompt",
        onStreamChunk: (chunk: string) => {
          chunks.push(chunk);
        },
      });

      expect(result).toBe("Hello World!");
      expect(chunks).toEqual(mockChunks);
    });

    it("should return full text even when streaming", async () => {
      const mockChunks = ["Part1", "Part2", "Part3"];

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          if (textParams.stream) {
            return createMockTextStreamResult(mockChunks);
          }
          return mockChunks.join("");
        },
        "test-provider",
      );

      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Test",
        onStreamChunk: () => {},
      });

      expect(result).toBe("Part1Part2Part3");
    });

    it("should not stream when no callback is provided", async () => {
      let streamRequested = false;

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          streamRequested = textParams.stream === true;
          return "Non-streamed result";
        },
        "test-provider",
      );

      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Test",
      });

      expect(result).toBe("Non-streamed result");
      expect(streamRequested).toBe(false);
    });
  });

  describe("stream: false forces non-streaming", () => {
    it("should not stream when stream: false even with onStreamChunk", async () => {
      let streamRequested = false;
      const chunks: string[] = [];

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          streamRequested = textParams.stream === true;
          return "Non-streamed result";
        },
        "test-provider",
      );

      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Test",
        stream: false,
        onStreamChunk: (chunk: string) => {
          chunks.push(chunk);
        },
      });

      expect(result).toBe("Non-streamed result");
      expect(streamRequested).toBe(false);
      expect(chunks).toEqual([]); // No chunks received
    });

    it("should not stream when stream: false even with context callback", async () => {
      let streamRequested = false;
      const contextChunks: string[] = [];

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          streamRequested = textParams.stream === true;
          return "Non-streamed result";
        },
        "test-provider",
      );

      const context: StreamingContext = {
        onStreamChunk: async (chunk) => {
          contextChunks.push(chunk);
        },
      };

      const result = await runWithStreamingContext(context, () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "Test",
          stream: false,
        }),
      );

      expect(result).toBe("Non-streamed result");
      expect(streamRequested).toBe(false);
      expect(contextChunks).toEqual([]);
    });
  });

  describe("context streaming", () => {
    it("should stream to context callback when inside runWithStreamingContext", async () => {
      const contextChunks: string[] = [];
      const mockChunks = ["Context", " ", "streaming"];

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          if (textParams.stream) {
            return createMockTextStreamResult(mockChunks);
          }
          return mockChunks.join("");
        },
        "test-provider",
      );

      const context: StreamingContext = {
        onStreamChunk: async (chunk) => {
          contextChunks.push(chunk);
        },
        messageId: stringToUuid("test-msg"),
      };

      const result = await runWithStreamingContext(context, () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "Test",
        }),
      );

      expect(result).toBe("Context streaming");
      expect(contextChunks).toEqual(mockChunks);
    });
  });

  describe("broadcast to both callbacks", () => {
    it("should send chunks to both params and context callbacks", async () => {
      const paramsChunks: string[] = [];
      const contextChunks: string[] = [];
      const mockChunks = ["Broadcast", " ", "test"];

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          if (textParams.stream) {
            return createMockTextStreamResult(mockChunks);
          }
          return mockChunks.join("");
        },
        "test-provider",
      );

      const context: StreamingContext = {
        onStreamChunk: async (chunk) => {
          contextChunks.push(chunk);
        },
      };

      const result = await runWithStreamingContext(context, () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "Test",
          onStreamChunk: (chunk: string) => {
            paramsChunks.push(chunk);
          },
        }),
      );

      expect(result).toBe("Broadcast test");
      expect(paramsChunks).toEqual(mockChunks);
      expect(contextChunks).toEqual(mockChunks);
    });

    it("should propagate error if callback throws", async () => {
      const paramsChunks: string[] = [];
      const contextChunks: string[] = [];
      const mockChunks = ["A", "B", "C"];

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          if (textParams.stream) {
            return createMockTextStreamResult(mockChunks);
          }
          return mockChunks.join("");
        },
        "test-provider",
      );

      const context: StreamingContext = {
        onStreamChunk: async (chunk) => {
          if (chunk === "B") {
            throw new Error("Context callback error");
          }
          contextChunks.push(chunk);
        },
      };

      await expect(
        runWithStreamingContext(context, () =>
          runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: "Test",
            onStreamChunk: (chunk: string) => {
              paramsChunks.push(chunk);
            },
          }),
        ),
      ).rejects.toThrow("Context callback error");

      // Params callback should receive chunks up to the error
      expect(paramsChunks).toEqual(["A", "B"]);
      // Context callback should receive only A (B threw)
      expect(contextChunks).toEqual(["A"]);
    });
  });

  describe("handler returns string (no streaming support)", () => {
    it("should return string directly when handler does not support streaming", async () => {
      const chunks: string[] = [];

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async () => {
          return "Plain string response";
        },
        "test-provider",
      );

      const result = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Test",
        onStreamChunk: (chunk: string) => {
          chunks.push(chunk);
        },
      });

      // Should still return the string
      expect(result).toBe("Plain string response");
      // No chunks because handler returned string, not TextStreamResult
      expect(chunks).toEqual([]);
    });
  });

  describe("abort signal", () => {
    it("should stop streaming when abort signal is triggered", async () => {
      const chunks: string[] = [];
      const mockChunks = ["A", "B", "C", "D", "E"];
      const abortController = new AbortController();

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          if (textParams.stream) {
            return createMockTextStreamResult(mockChunks);
          }
          return mockChunks.join("");
        },
        "test-provider",
      );

      const context: StreamingContext = {
        onStreamChunk: async (chunk) => {
          chunks.push(chunk);
          // Abort after receiving 2 chunks
          if (chunks.length === 2) {
            abortController.abort();
          }
        },
        abortSignal: abortController.signal,
      };

      const result = await runWithStreamingContext(context, () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "Test",
        }),
      );

      // Should have stopped after 2 chunks due to abort
      expect(chunks.length).toBe(2);
      expect(chunks).toEqual(["A", "B"]);
      // Result should be partial (only chunks received before abort)
      expect(result).toBe("AB");
    });

    it("should not affect streaming when abort signal is not triggered", async () => {
      const chunks: string[] = [];
      const mockChunks = ["X", "Y", "Z"];
      const abortController = new AbortController();

      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          if (textParams.stream) {
            return createMockTextStreamResult(mockChunks);
          }
          return mockChunks.join("");
        },
        "test-provider",
      );

      const context: StreamingContext = {
        onStreamChunk: async (chunk) => {
          chunks.push(chunk);
        },
        abortSignal: abortController.signal,
      };

      const result = await runWithStreamingContext(context, () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "Test",
        }),
      );

      // Should receive all chunks since abort was never triggered
      expect(chunks).toEqual(["X", "Y", "Z"]);
      expect(result).toBe("XYZ");
    });
  });

  describe("database logging", () => {
    it("should log streaming model calls to database", async () => {
      const mockChunks = ["Hello", " ", "World"];
      const mockAdapter = createMinimalMockAdapter();

      const streamingRuntime = new AgentRuntime({
        agentId: stringToUuid("test-logging-agent"),
        character: mockCharacter,
        adapter: mockAdapter,
      });

      streamingRuntime.registerModel(
        ModelType.TEXT_LARGE,
        async (_rt, params) => {
          const textParams = params as GenerateTextParams;
          if (textParams.stream) {
            return createMockTextStreamResult(mockChunks);
          }
          return mockChunks.join("");
        },
        "test-provider",
      );

      await streamingRuntime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Test prompt",
        onStreamChunk: () => {},
      });

      // Verify adapter.log was called
      const logCalls = (mockAdapter.log as ReturnType<typeof mock>).mock.calls;
      expect(logCalls.length).toBeGreaterThan(0);

      // Verify the log contains correct model info
      const logCall = logCalls[0][0];
      expect(logCall.type).toBe("useModel:TEXT_LARGE");
      expect(logCall.body.modelKey).toBe("TEXT_LARGE");
      expect(logCall.body.response).toBe("Hello World");
    });

    it("should log non-streaming model calls to database", async () => {
      const mockAdapter = createMinimalMockAdapter();

      const nonStreamingRuntime = new AgentRuntime({
        agentId: stringToUuid("test-logging-agent-2"),
        character: mockCharacter,
        adapter: mockAdapter,
      });

      nonStreamingRuntime.registerModel(
        ModelType.TEXT_LARGE,
        async () => "Non-streamed response",
        "test-provider",
      );

      await nonStreamingRuntime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Test prompt",
      });

      // Verify adapter.log was called
      const logCalls = (mockAdapter.log as ReturnType<typeof mock>).mock.calls;
      expect(logCalls.length).toBeGreaterThan(0);

      // Verify the log contains correct model info
      const logCall = logCalls[0][0];
      expect(logCall.type).toBe("useModel:TEXT_LARGE");
      expect(logCall.body.modelKey).toBe("TEXT_LARGE");
      expect(logCall.body.response).toBe("Non-streamed response");
    });
  });
});
