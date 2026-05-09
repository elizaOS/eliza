import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { XService } from "./x.service";

function asRuntime<T extends object>(runtime: T): IAgentRuntime & T {
  return runtime as IAgentRuntime & T;
}

function runtimeWithSettings(settings: Record<string, string>): IAgentRuntime {
  return asRuntime({
    agentId: "agent-1",
    getSetting: (key: string) => settings[key],
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  });
}

function serviceWithRuntime(settings: Record<string, string>): XService {
  return new XService(runtimeWithSettings(settings));
}

describe("XService account status", () => {
  it("reports config_missing when env auth credentials are absent", async () => {
    const service = serviceWithRuntime({ TWITTER_AUTH_MODE: "env" });

    await expect(service.getAccountStatus("default")).resolves.toMatchObject({
      accountId: "default",
      configured: false,
      connected: false,
      reason: "config_missing",
      grantedCapabilities: [],
      grantedScopes: [],
      authMode: "env",
    });
  });

  it("reports accountId-first env capabilities without making a network call", async () => {
    const service = serviceWithRuntime({
      TWITTER_AUTH_MODE: "env",
      TWITTER_API_KEY: "api-key",
      TWITTER_API_SECRET_KEY: "api-secret",
      TWITTER_ACCESS_TOKEN: "access-token",
      TWITTER_ACCESS_TOKEN_SECRET: "access-secret",
    });

    await expect(service.getAccountStatus("primary")).resolves.toMatchObject({
      accountId: "primary",
      configured: true,
      connected: true,
      reason: "connected",
      grantedCapabilities: ["x.read", "x.write", "x.dm.read", "x.dm.write"],
      authMode: "env",
    });
  });

  it("maps OAuth scopes into X capabilities", async () => {
    const service = serviceWithRuntime({
      TWITTER_AUTH_MODE: "oauth",
      TWITTER_CLIENT_ID: "client-id",
      TWITTER_REDIRECT_URI: "http://127.0.0.1:8080/callback",
      TWITTER_SCOPES: "tweet.read users.read dm.read",
    });

    await expect(
      service.getAccountStatus("oauth-account"),
    ).resolves.toMatchObject({
      accountId: "oauth-account",
      configured: true,
      connected: true,
      grantedCapabilities: ["x.read", "x.dm.read"],
      grantedScopes: ["tweet.read", "users.read", "dm.read"],
      authMode: "oauth",
    });
  });
});
