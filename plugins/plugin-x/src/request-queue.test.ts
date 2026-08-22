/**
 * Real `ClientBase.requestQueue` coverage: a swallowed wrapper catch used to
 * reject `add()` on the first failure and skip retry/backoff. The queue now
 * retries explicitly repeatable reads, then rejects only after the budget is
 * exhausted. Ambiguous mutations remain single-attempt.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { ClientBase, RequestQueue } from "./base";
import type { TwitterClientState } from "./types";

function makeClient(): ClientBase {
  const client = new ClientBase(
    {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: { name: "Agent" },
      getSetting: () => undefined,
    } as unknown as IAgentRuntime,
    { accountId: "default" } as TwitterClientState,
  );
  client.requestQueue = new RequestQueue({
    backoff: async () => undefined,
    jitter: async () => undefined,
  });
  return client;
}

describe("RequestQueue retries provider failures", () => {
  it("retries a failed request and resolves when a later attempt succeeds", async () => {
    const client = makeClient();
    let calls = 0;
    await expect(
      client.requestQueue.add(
        async () => {
          calls += 1;
          if (calls < 2) {
            throw new Error("HTTP 429 rate limited");
          }
          return "ok";
        },
        { retry: "safe" },
      ),
    ).resolves.toBe("ok");
    expect(calls).toBe(2);
  }, 20_000);

  it("rejects after the retry budget instead of hanging or skipping", async () => {
    const client = makeClient();
    let calls = 0;
    await expect(
      client.requestQueue.add(
        async () => {
          calls += 1;
          throw new Error("HTTP 429 rate limited");
        },
        { retry: "safe" },
      ),
    ).rejects.toThrow("HTTP 429 rate limited");
    expect(calls).toBe(3);
  }, 20_000);

  it("still resolves a first-try success without extra attempts", async () => {
    const client = makeClient();
    let calls = 0;
    await expect(
      client.requestQueue.add(async () => {
        calls += 1;
        return 42;
      }),
    ).resolves.toBe(42);
    expect(calls).toBe(1);
  });

  it("does not retry an operation without explicit repeat-safe authority", async () => {
    const client = makeClient();
    let calls = 0;

    await expect(
      client.requestQueue.add(async () => {
        calls += 1;
        throw new Error("delivery receipt lost after provider acceptance");
      }),
    ).rejects.toThrow("delivery receipt lost after provider acceptance");

    expect(calls).toBe(1);
  });
});
