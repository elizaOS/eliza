/**
 * A connector-account store failure must not abort account resolution. The
 * store lookup is the second of three strategies in `readRuntimeAccountRecord`;
 * when it throws, the runtime-level `getConnectorAccount` lookup below still has
 * to run, exactly as it already does when the store simply returns `null`.
 * Otherwise a store outage is reported as "this account has no credentials" and
 * the X client is built from empty credentials.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveTwitterAccountConfig } from "./accounts";

function runtimeWithAccountLookups(overrides: Record<string, unknown>) {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: () => undefined,
    getService: () => null,
    ...overrides,
  } as unknown as IAgentRuntime;
}

describe("resolveTwitterAccountConfig account lookup fallbacks", () => {
  it("keeps resolving when the connector account store throws", async () => {
    const runtime = runtimeWithAccountLookups({
      getConnectorAccountStore: () => ({
        getAccount: async () => {
          throw new Error("connector account store unavailable");
        },
      }),
      getConnectorAccount: async () => ({
        accountId: "work",
        source: "x",
        credentials: {
          apiKey: "third-strategy-key",
          apiSecretKey: "third-strategy-secret",
          accessToken: "third-strategy-token",
          accessTokenSecret: "third-strategy-token-secret",
        },
      }),
    });

    const state = await resolveTwitterAccountConfig(runtime, {
      accountId: "work",
    });

    expect(state.TWITTER_API_KEY).toBe("third-strategy-key");
    expect(state.TWITTER_ACCESS_TOKEN).toBe("third-strategy-token");
  });

  it("still reports an unknown account as missing when every lookup finds nothing", async () => {
    const runtime = runtimeWithAccountLookups({
      getConnectorAccountStore: () => ({
        getAccount: async () => {
          throw new Error("connector account store unavailable");
        },
      }),
      getConnectorAccount: async () => null,
    });

    const state = await resolveTwitterAccountConfig(runtime, {
      accountId: "work",
    });

    expect(state.TWITTER_API_KEY).toBe("");
    expect(state.TWITTER_ACCESS_TOKEN).toBe("");
  });
});
