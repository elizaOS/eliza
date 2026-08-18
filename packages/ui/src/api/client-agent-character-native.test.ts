/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves character random-name and history hops carry timeoutMs into Agent.request.
 */
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

describe("ElizaClient character-history native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the random-name deadline to Agent.request", async () => {
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

  it("forwards the history deadline to Agent.request", async () => {
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

  it("times out a stalled history hop through ElizaClient", async () => {
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
      makeClient(request).listCharacterHistory(undefined, 10),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/character/history",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
