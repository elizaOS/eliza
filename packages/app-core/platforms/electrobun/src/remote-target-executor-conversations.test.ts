/** Proves the native target enforces the shared route contract before loopback. */

import type { RemoteJsonValue } from "@elizaos/shared/contracts/remote-control";
import { describe, expect, it, vi } from "vitest";
import { LoopbackRemoteTargetExecutor } from "./remote-target-executor";
import type { RemoteTargetFetch } from "./remote-target-transport";

const conversationId = "11111111-1111-4111-8111-111111111111";

function executor(fetchImpl: RemoteTargetFetch) {
  return new LoopbackRemoteTargetExecutor({
    apiBase: "http://127.0.0.1:2138",
    apiToken: "runtime-token-with-enough-entropy",
    fetchImpl,
    timeoutMs: 1_000,
  });
}

describe("remote target conversation executor", () => {
  it("forwards an allowlisted chat send with native auth and execution binding", async () => {
    const body = JSON.stringify({
      text: "hello from the paired controller",
      channelType: "DM",
      clientMessageId: "message-1",
      streamProtocol: "delta-v2",
      metadata: { uiView: "chat" },
    });
    const fetchImpl = vi.fn<RemoteTargetFetch>(
      async () =>
        new Response('data: {"type":"done","fullText":"hello"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const result = await executor(fetchImpl).execute({
      action: "agent.request",
      payload: {
        path: `/api/conversations/${conversationId}/messages/stream`,
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          "x-elizaos-client-id": "ui-controller-1",
        },
        body,
      },
      executionId: "execution-1",
    });

    expect(result).toMatchObject({
      status: "completed",
      result: {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(
      `http://127.0.0.1:2138/api/conversations/${conversationId}/messages/stream`,
    );
    expect(init).toMatchObject({
      method: "POST",
      body,
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "x-elizaos-client-id": "ui-controller-1",
        Authorization: "Bearer runtime-token-with-enough-entropy",
        "X-Eliza-Remote-Execution-Id": "execution-1",
      },
      cache: "no-store",
      redirect: "error",
    });
  });

  it("forwards only strict list/history requests", async () => {
    const fetchImpl = vi.fn<RemoteTargetFetch>(async () =>
      Response.json({ messages: [] }),
    );
    const result = await executor(fetchImpl).execute({
      action: "agent.request",
      payload: {
        path: `/api/conversations/${conversationId}/messages?before=1730000000000&limit=50`,
        method: "GET",
        headers: {},
      },
      executionId: "execution-2",
    });
    expect(result.status).toBe("completed");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects arbitrary paths and malformed chat without reaching loopback", async () => {
    const fetchImpl = vi.fn<RemoteTargetFetch>();
    const invalidPayloads: RemoteJsonValue[] = [
      { path: "/api/files", method: "GET", headers: {} },
      {
        path: `/api/conversations/${conversationId}/messages/stream`,
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "missing idempotency key" }),
      },
    ];
    for (const payload of invalidPayloads) {
      await expect(
        executor(fetchImpl).execute({
          action: "agent.request",
          payload,
          executionId: "execution-3",
        }),
      ).resolves.toEqual({
        status: "rejected",
        errorCode: "REMOTE_ACTION_NOT_ALLOWLISTED",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an oversized loopback response without returning a prefix", async () => {
    const fetchImpl = vi.fn<RemoteTargetFetch>(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": String(384 * 1024 + 1) },
        }),
    );
    await expect(
      executor(fetchImpl).execute({
        action: "agent.request",
        payload: {
          path: "/api/conversations",
          method: "GET",
          headers: {},
        },
        executionId: "execution-4",
      }),
    ).resolves.toEqual({
      status: "rejected",
      errorCode: "REMOTE_LOCAL_RESPONSE_UNAVAILABLE",
    });
  });
});
