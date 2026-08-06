import { afterEach, describe, expect, it, vi } from "vitest";

async function importAgentModuleWithBatchMocks() {
  vi.resetModules();
  vi.doMock("../storage/index", () => ({
    appendCompaction: vi.fn(),
    appendMessages: vi.fn(() => []),
    appendSystemMessage: vi.fn(() => 0),
    buildChatEntries: vi.fn(() => []),
    getNextMessageSequence: vi.fn(() => 0),
    getSessionTotalTokens: vi.fn(() => 0),
    loadTranscript: vi.fn(() => []),
    loadTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
    recordUsageEvent: vi.fn(),
    SessionStore: class {
      getWorkspace() {
        return null;
      }
      openSession() {
        return null;
      }
      createSession() {
        return null;
      }
      setModel() {}
      getRequiredSession() {
        return null;
      }
      setMode() {}
      touchSession() {}
    },
  }));

  const createBatch = vi.fn(async () => ({
    batch_id: "batch-1",
    state: {
      num_requests: 0,
      num_pending: 0,
      num_success: 0,
      num_error: 0,
      num_cancelled: 0,
    },
  }));
  const addBatchRequests = vi.fn(async () => {});
  const pollBatchRequestResult = vi.fn(async () => ({ batch_request_id: "req-1" }));
  const getBatchChatCompletion = vi.fn(() => ({
    choices: [],
    usage: {},
  }));

  vi.doMock("../grok/batch", async () => {
    const actual = await vi.importActual<typeof import("../grok/batch")>("../grok/batch");
    return {
      ...actual,
      createBatch,
      addBatchRequests,
      pollBatchRequestResult,
      getBatchChatCompletion,
    };
  });

  const mod = await import("./agent");
  return {
    ...mod,
    mocks: {
      createBatch,
      addBatchRequests,
      pollBatchRequestResult,
      getBatchChatCompletion,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../storage/index");
  vi.doUnmock("../grok/batch");
});

describe("Agent batch mode", () => {
  it("throws when a child batch response has no choices", async () => {
    const { Agent, mocks } = await importAgentModuleWithBatchMocks();
    const agent = new Agent("test-key", "https://api.x.ai/v1", undefined, undefined, {
      persistSession: false,
    });

    const runTaskRequestBatch = (
      agent as unknown as {
        runTaskRequestBatch: (args: {
          request: { agent: string; description: string; prompt: string };
          childMessages: Array<{ role: "user"; content: string }>;
          childSystem: string;
          childRuntime: unknown;
          childTools: Record<string, never>;
          maxSteps: number;
          initialDetail: string;
        }) => Promise<unknown>;
      }
    ).runTaskRequestBatch.bind(agent);

    await expect(
      runTaskRequestBatch({
        request: {
          agent: "general",
          description: "Child task",
          prompt: "Do the thing",
        },
        childMessages: [{ role: "user", content: "Do the thing" }],
        childSystem: "system",
        childRuntime: {
          modelId: "grok-4.3",
          modelInfo: {
            supportsClientTools: false,
            supportsMaxOutputTokens: true,
          },
          providerOptions: undefined,
        },
        childTools: {},
        maxSteps: 1,
        initialDetail: "Starting child task",
      }),
    ).rejects.toThrow("Batch response did not contain any choices.");

    expect(mocks.createBatch).toHaveBeenCalled();
    expect(mocks.addBatchRequests).toHaveBeenCalled();
    expect(mocks.pollBatchRequestResult).toHaveBeenCalled();
    expect(mocks.getBatchChatCompletion).toHaveBeenCalled();
  });
});
