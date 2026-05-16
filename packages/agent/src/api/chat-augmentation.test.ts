import { describe, expect, it, vi } from "vitest";

import { maybeAugmentChatMessageWithDocuments } from "./chat-augmentation.ts";

function makeMessage() {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    agentId: "00000000-0000-0000-0000-0000000000aa",
    entityId: "00000000-0000-0000-0000-0000000000bb",
    roomId: "00000000-0000-0000-0000-0000000000cc",
    content: { text: "what are you up to?" },
    createdAt: Date.now(),
  } as any;
}

function makeRuntime(documentsService: unknown, useModel = vi.fn()) {
  return {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getService: vi.fn((name: string) =>
      name === "documents" ? documentsService : null,
    ),
    getServiceLoadPromise: vi.fn(),
    useModel,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as any;
}

describe("maybeAugmentChatMessageWithDocuments", () => {
  it("skips optional document context when lookup exceeds its budget", async () => {
    const message = makeMessage();
    const documents = {
      searchDocuments: vi.fn(
        () =>
          new Promise<never>(() => {
            // Simulate a wedged retrieval backend.
          }),
      ),
    };
    const runtime = makeRuntime(documents);

    const result = await maybeAugmentChatMessageWithDocuments(
      runtime,
      message,
      {
        lookupTimeoutMs: 10,
        recoveryTimeoutMs: 10,
      },
    );

    expect(result).toBe(message);
    expect(documents.searchDocuments).toHaveBeenCalledTimes(1);
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        src: "api:chat-augmentation",
        timeoutMs: 10,
      }),
      "Document lookup timed out; skipping optional document context",
    );
  });

  it("bounds and aborts LLM query recovery before the real chat turn", async () => {
    const message = makeMessage();
    const documents = {
      searchDocuments: vi.fn().mockResolvedValue([]),
    };
    let recoverySignal: AbortSignal | undefined;
    const useModel = vi.fn((_modelType, params) => {
      recoverySignal = params.signal;
      return new Promise<never>(() => {
        // Simulate a local model request that does not finish on its own.
      });
    });
    const runtime = makeRuntime(documents, useModel);

    const result = await maybeAugmentChatMessageWithDocuments(
      runtime,
      message,
      {
        lookupTimeoutMs: 10,
        recoveryTimeoutMs: 10,
      },
    );

    expect(result).toBe(message);
    expect(documents.searchDocuments).toHaveBeenCalledTimes(2);
    expect(useModel).toHaveBeenCalledWith(
      "TEXT_LARGE",
      expect.objectContaining({
        maxTokens: 96,
        responseFormat: { type: "json_object" },
        signal: expect.any(AbortSignal),
        temperature: 0,
      }),
    );
    expect(recoverySignal?.aborted).toBe(true);
  });
});
