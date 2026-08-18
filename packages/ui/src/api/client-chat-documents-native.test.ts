/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves document stats and list hops carry timeoutMs into Agent.request.
 */
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

describe("ElizaClient document-list native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the stats deadline to Agent.request", async () => {
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

  it("forwards the list deadline to Agent.request", async () => {
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

  it("times out a stalled list hop through ElizaClient", async () => {
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
    await expect(
      makeClient(request).listDocuments(undefined, 10),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/documents",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
