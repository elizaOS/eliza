import { afterEach, describe, expect, it, vi } from "vitest";
import { getBatchChatCompletion, pollBatchRequestResult } from "./batch";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("getBatchChatCompletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("extracts the chat completion payload from a batch result", () => {
    const response = getBatchChatCompletion({
      batch_request_id: "req-1",
      batch_result: {
        response: {
          chat_get_completion: {
            id: "chatcmpl-1",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "done",
                },
              },
            ],
            usage: {
              total_tokens: 12,
            },
          },
        },
      },
    });

    expect(response.choices[0]?.message.content).toBe("done");
    expect(response.usage?.total_tokens).toBe(12);
  });

  it("throws when the batch result is an error", () => {
    expect(() =>
      getBatchChatCompletion({
        batch_request_id: "req-2",
        error_message: "boom",
      }),
    ).toThrow('Batch request "req-2" failed: boom');
  });

  it("waits through transient ClickHouse visibility errors before returning a result", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              batch_request_id: "req-3",
              batch_result: {
                error: "Batch request not yet visible in ClickHouse",
              },
            },
          ],
          pagination_token: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          batch_id: "batch-1",
          state: {
            num_requests: 1,
            num_pending: 1,
            num_success: 0,
            num_error: 0,
            num_cancelled: 0,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              batch_request_id: "req-3",
              batch_result: {
                response: {
                  chat_get_completion: {
                    choices: [{ message: { content: "done" } }],
                  },
                },
              },
            },
          ],
          pagination_token: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollBatchRequestResult({
      apiKey: "test-key",
      batchId: "batch-1",
      batchRequestId: "req-3",
      initialPollMs: 0,
      maxPollMs: 0,
      timeoutMs: 1000,
    });

    expect(result.batch_result?.response?.chat_get_completion?.choices[0]?.message.content).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps polling after batch completion until the result row becomes visible", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [],
          pagination_token: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          batch_id: "batch-2",
          state: {
            num_requests: 1,
            num_pending: 0,
            num_success: 1,
            num_error: 0,
            num_cancelled: 0,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              batch_request_id: "req-4",
              batch_result: {
                response: {
                  chat_get_completion: {
                    choices: [{ message: { content: "visible now" } }],
                  },
                },
              },
            },
          ],
          pagination_token: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollBatchRequestResult({
      apiKey: "test-key",
      batchId: "batch-2",
      batchRequestId: "req-4",
      initialPollMs: 0,
      maxPollMs: 0,
      timeoutMs: 1000,
    });

    expect(result.batch_result?.response?.chat_get_completion?.choices[0]?.message.content).toBe("visible now");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
