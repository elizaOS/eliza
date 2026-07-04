/**
 * Unit coverage for per-request timeout selection on the base client (including
 * local-inference budgets). Transport stubbed, no live model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-chat";
import "./client-local-inference";
import type { AgentRequestTransport } from "./transport";

function makeClientWithTransport() {
  const request = vi.fn<AgentRequestTransport["request"]>(
    async (_url, _init) =>
      new Response(JSON.stringify({ agentName: "Eliza", text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return { client, request };
}

function makeDeferredResponse() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("ElizaClient request timeout policy", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("allows chat message requests to wait for slower agent responses", async () => {
    const { client, request } = makeClientWithTransport();

    await client.sendConversationMessage("conversation-id", "hello");

    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/conversations/conversation-id/messages",
      expect.any(Object),
      { timeoutMs: 600_000 },
    );
  });

  it("keeps the chat timeout for message paths with query strings", async () => {
    const { client, request } = makeClientWithTransport();

    await client.fetch(
      "/api/conversations/conversation-id/messages?agentId=agent",
      {
        method: "POST",
      },
    );

    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/conversations/conversation-id/messages?agentId=agent",
      expect.any(Object),
      { timeoutMs: 600_000 },
    );
  });

  it("keeps ordinary REST requests on the normal timeout", async () => {
    const { client, request } = makeClientWithTransport();

    await client.fetch("/api/status");

    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/status",
      expect.any(Object),
      { timeoutMs: 10_000 },
    );
  });

  it("coalesces concurrent local inference hub reads with a longer timeout", async () => {
    const response = makeDeferredResponse();
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => response.promise,
    );
    const client = new ElizaClient("http://agent.example:2138", "token");
    client.setRequestTransport({ request });

    const first = client.getLocalInferenceHub();
    const second = client.getLocalInferenceHub();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/local-inference/hub",
      expect.any(Object),
      { timeoutMs: 30_000 },
    );

    response.resolve(
      new Response(JSON.stringify({ catalog: [], installed: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      { catalog: [], installed: [] },
      { catalog: [], installed: [] },
    ]);
  });
});
