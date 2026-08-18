/** Verifies document stats / list hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  DOCUMENT_LIST_FETCH_TIMEOUT_MS,
  DOCUMENT_STATS_FETCH_TIMEOUT_MS,
} from "./client-chat";
import "./client-chat";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const stats = { documentCount: 0, fragmentCount: 0, agentId: "a1" };
const list = { documents: [], total: 0, limit: 20, offset: 0 };

describe("ElizaClient document-list native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(DOCUMENT_STATS_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(DOCUMENT_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes stats timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(stats),
    );
    await makeClient(request).getDocumentStats();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/documents/stats",
      expect.any(Object),
      { timeoutMs: DOCUMENT_STATS_FETCH_TIMEOUT_MS },
    );
  });

  it("passes list timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(list),
    );
    await makeClient(request).listDocuments();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/documents",
      expect.any(Object),
      { timeoutMs: DOCUMENT_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("keeps ?q= and passes list timeoutMs on that hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(list),
    );
    await makeClient(request).listDocuments({ query: "x" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/documents?q=x",
      expect.any(Object),
      { timeoutMs: DOCUMENT_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled stats hop as TimeoutError", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (_url, init, ctx) => {
        const ms = ctx?.timeoutMs ?? 10;
        await new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(
              Object.assign(new Error(`Request timed out after ${ms}ms`), {
                name: "TimeoutError",
              }),
            );
          }, ms);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(
                Object.assign(new Error("The operation was aborted"), {
                  name: "AbortError",
                }),
              );
            },
            { once: true },
          );
        });
      },
    );
    await expect(makeClient(request).getDocumentStats(10)).rejects.toMatchObject(
      {
        name: "ApiError",
        kind: "timeout",
      },
    );
  });

  it("surfaces a provider error from a completed list GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(makeClient(request).listDocuments()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
