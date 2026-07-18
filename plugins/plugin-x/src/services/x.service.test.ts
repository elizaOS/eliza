/** Unit tests for X account status and trusted multi-account connector routing. Network clients are deterministic fakes. */
import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
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
  it("declares that its unscoped message connector dispatches trusted account ids", () => {
    const registerMessageConnector = vi.fn();
    const runtime = asRuntime({
      agentId: "agent-1",
      getSetting: () => undefined,
      registerMessageConnector,
      registerPostConnector: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const service = new XService(runtime);

    XService.registerSendHandlers(runtime, service);

    expect(registerMessageConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "x",
        accountRouting: "connector",
      }),
    );
  });

  it("declares that its unscoped post connector dispatches trusted account ids", () => {
    const registerPostConnector = vi.fn();
    const runtime = asRuntime({
      agentId: "agent-1",
      getSetting: () => undefined,
      registerPostConnector,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const service = new XService(runtime);

    (
      service as unknown as {
        registerPostConnector(runtime: IAgentRuntime): void;
      }
    ).registerPostConnector(runtime);

    expect(registerPostConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "x",
        accountRouting: "connector",
      }),
    );
  });

  it("routes connector user context through the trusted account id", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const getScreenNameByUserId = vi.fn(async () => "secondary-user");
    type ServiceInternals = {
      getTwitterClientForAccount: (accountId: unknown) => Promise<{
        client: {
          twitterClient: {
            getScreenNameByUserId: typeof getScreenNameByUserId;
          };
        };
      }>;
    };
    const getClient = vi
      .spyOn(
        service as unknown as ServiceInternals,
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({
        client: { twitterClient: { getScreenNameByUserId } },
      });

    const context = {
      runtime,
      source: "x",
      accountId: "secondary",
      target: { source: "x", accountId: "secondary" },
    };
    const result = await service.getConnectorUserContext("123456", context);

    expect(getClient).toHaveBeenCalledWith("secondary");
    expect(result).toMatchObject({
      entityId: "123456",
      label: "@secondary-user",
      metadata: { accountId: "secondary" },
    });
  });

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

describe("XService trusted account routing", () => {
  it("routes feed reads through the trusted secondary account context", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const fetchHomeTimeline = vi.fn(async () => []);
    const getClient = vi
      .spyOn(
        service as unknown as {
          getTwitterClientForAccount: (accountId: unknown) => Promise<{
            client: {
              fetchHomeTimeline: typeof fetchHomeTimeline;
              runtime: IAgentRuntime;
            };
          }>;
        },
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({
        client: { fetchHomeTimeline, runtime },
      });

    await service.fetchConnectorFeed(
      {
        runtime,
        source: "x",
        accountId: "secondary",
        target: { source: "x", accountId: "primary" },
        metadata: { accountId: "primary" },
      },
      {
        target: { source: "x", accountId: "primary" },
      },
    );

    expect(getClient).toHaveBeenCalledWith("secondary");
    expect(fetchHomeTimeline).toHaveBeenCalledOnce();
  });

  it("routes post searches through the trusted secondary account context", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const fetchSearchTweets = vi.fn(async () => ({ tweets: [] }));
    const getClient = vi
      .spyOn(
        service as unknown as {
          getTwitterClientForAccount: (accountId: unknown) => Promise<{
            client: {
              fetchSearchTweets: typeof fetchSearchTweets;
            };
          }>;
        },
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({ client: { fetchSearchTweets } });

    await service.searchConnectorPosts(
      {
        runtime,
        source: "x",
        accountId: "secondary",
        target: { source: "x", accountId: "primary" },
        metadata: { accountId: "primary" },
      },
      { query: "multi-account routing" },
    );

    expect(getClient).toHaveBeenCalledWith("secondary");
    expect(fetchSearchTweets).toHaveBeenCalledWith(
      "multi-account routing",
      20,
      expect.anything(),
      undefined,
    );
  });

  it("ignores spoofed content account metadata in the unscoped send handler", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const getClient = vi
      .spyOn(
        service as unknown as {
          getTwitterClientForAccount: (accountId: unknown) => Promise<{
            client: Record<string, never>;
          }>;
        },
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({ client: {} });
    const sendXDirectMessage = vi
      .spyOn(
        service as unknown as {
          sendXDirectMessage: (
            accountId: string,
            recipient: string,
            text: string,
          ) => Promise<{ messageId: string | null }>;
        },
        "sendXDirectMessage",
      )
      .mockResolvedValue({ messageId: "dm-1" });

    await service.handleSendMessage(
      runtime,
      { source: "x", entityId: "123456" } as TargetInfo,
      {
        text: "hello",
        metadata: { accountId: "secondary" },
      } as Content,
    );

    expect(getClient).toHaveBeenCalledWith("default");
    expect(sendXDirectMessage).toHaveBeenCalledWith(
      "default",
      "123456",
      "hello",
    );
  });
});
