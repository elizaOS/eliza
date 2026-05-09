import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultXAccountId,
  resolveTwitterAccountConfig,
} from "./accounts";
import { getTwitterAuthMode } from "./auth-providers/factory";

function createRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

describe("X account config", () => {
  it("uses the configured default account with env credentials", async () => {
    const runtime = createRuntime({
      TWITTER_DEFAULT_ACCOUNT_ID: "primary",
      TWITTER_AUTH_MODE: "env",
      TWITTER_API_KEY: "api-key",
      TWITTER_API_SECRET_KEY: "api-secret",
      TWITTER_ACCESS_TOKEN: "access-token",
      TWITTER_ACCESS_TOKEN_SECRET: "access-secret",
    });

    const state = await resolveTwitterAccountConfig(runtime);

    expect(resolveDefaultXAccountId(runtime, state)).toBe("primary");
    expect(state).toMatchObject({
      accountId: "primary",
      TWITTER_ACCOUNT_ID: "primary",
      TWITTER_AUTH_MODE: "env",
      TWITTER_API_KEY: "api-key",
      TWITTER_ACCESS_TOKEN: "access-token",
    });
  });

  it("does not silently reuse default credentials for an unknown account", async () => {
    const runtime = createRuntime({
      TWITTER_DEFAULT_ACCOUNT_ID: "primary",
      TWITTER_AUTH_MODE: "env",
      TWITTER_API_KEY: "api-key",
      TWITTER_API_SECRET_KEY: "api-secret",
      TWITTER_ACCESS_TOKEN: "access-token",
      TWITTER_ACCESS_TOKEN_SECRET: "access-secret",
    });

    const state = await resolveTwitterAccountConfig(runtime, {
      accountId: "secondary",
    });

    expect(state.accountId).toBe("secondary");
    expect(state.TWITTER_API_KEY).toBe("");
    expect(state.TWITTER_ACCESS_TOKEN).toBe("");
  });

  it("reads account-scoped credentials from TWITTER_ACCOUNTS JSON", async () => {
    const runtime = createRuntime({
      TWITTER_DEFAULT_ACCOUNT_ID: "primary",
      TWITTER_ACCOUNTS: JSON.stringify({
        secondary: {
          authMode: "oauth",
          clientId: "client-2",
          redirectUri: "http://127.0.0.1:8081/callback",
          scopes: "tweet.read users.read offline.access",
        },
      }),
    });

    const state = await resolveTwitterAccountConfig(runtime, {
      accountId: "secondary",
    });

    expect(state).toMatchObject({
      accountId: "secondary",
      TWITTER_AUTH_MODE: "oauth",
      TWITTER_CLIENT_ID: "client-2",
      TWITTER_REDIRECT_URI: "http://127.0.0.1:8081/callback",
      TWITTER_SCOPES: "tweet.read users.read offline.access",
    });
  });

  it("rejects the removed broker auth mode", () => {
    const runtime = createRuntime({ TWITTER_AUTH_MODE: "broker" });

    expect(() => getTwitterAuthMode(runtime)).toThrow(
      "Invalid TWITTER_AUTH_MODE=broker. Expected env|oauth.",
    );
  });
});
