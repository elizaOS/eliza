import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { RuntimeCacheTokenStore } from "./token-store";

describe("OAuth token store", () => {
  it("keys runtime cache entries by accountId", async () => {
    const cache = new Map<string, unknown>();
    const runtime = {
      agentId: "agent-1",
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: unknown) => {
        cache.set(key, value);
      },
    } as unknown as IAgentRuntime;

    const store = new RuntimeCacheTokenStore(runtime, "secondary");
    await store.save({
      access_token: "access-token",
      expires_at: 123,
    });

    expect(cache.has("twitter/oauth2/tokens/agent-1/secondary")).toBe(true);
  });
});
