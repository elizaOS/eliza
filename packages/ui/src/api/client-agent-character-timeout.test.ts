/** Verifies character random-name / history hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  CHARACTER_HISTORY_FETCH_TIMEOUT_MS,
  CHARACTER_RANDOM_NAME_FETCH_TIMEOUT_MS,
} from "./client-agent";
import "./client-agent";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient character-history native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(CHARACTER_RANDOM_NAME_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(CHARACTER_HISTORY_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes random-name timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ name: "Ada" }),
    );
    await makeClient(request).getRandomName();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/character/random-name",
      expect.any(Object),
      { timeoutMs: CHARACTER_RANDOM_NAME_FETCH_TIMEOUT_MS },
    );
  });

  it("passes history timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ history: [] }),
    );
    await makeClient(request).listCharacterHistory();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/character/history",
      expect.any(Object),
      { timeoutMs: CHARACTER_HISTORY_FETCH_TIMEOUT_MS },
    );
  });

  it("keeps limit/offset and passes history timeoutMs on that hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ history: [] }),
    );
    await makeClient(request).listCharacterHistory({ limit: 20, offset: 5 });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/character/history?limit=20&offset=5",
      expect.any(Object),
      { timeoutMs: CHARACTER_HISTORY_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled random-name hop as TimeoutError", async () => {
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
    await expect(makeClient(request).getRandomName(10)).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
  });

  it("surfaces a provider error from a completed history GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      makeClient(request).listCharacterHistory(),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
