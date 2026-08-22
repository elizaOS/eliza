/** Unit tests for X account status and trusted multi-account connector routing. Network clients are deterministic fakes. */
import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ClientBase } from "../base";
import type { AuthenticatedTwitterSession } from "../client/auth";
import type { TwitterClientState } from "../types";
import { TwitterPostService } from "./PostService";
import { TwitterClientInstance, XService } from "./x.service";

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

function dmSession(userId: string, v2: object): AuthenticatedTwitterSession {
  return {
    client: { v2 },
    profile: { userId, username: `user-${userId}`, location: "" },
    revision: 1,
  } as unknown as AuthenticatedTwitterSession;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("XService account status", () => {
  it("passes validated interval state into production clients", async () => {
    const runtime = runtimeWithSettings({
      TWITTER_AUTH_MODE: "broker",
      TWITTER_BROKER_TOKEN: "test-token",
      TWITTER_ENABLE_DMS: "false",
      TWITTER_ENABLE_REPLIES: "false",
      TWITTER_ENABLE_ACTIONS: "false",
      TWITTER_ENABLE_DISCOVERY: "false",
      TWITTER_ENABLE_POST: "false",
    });
    const service = new XService(runtime);
    const init = vi
      .spyOn(ClientBase.prototype, "init")
      .mockResolvedValue(undefined);

    const instance = await (
      service as unknown as {
        getTwitterClientForAccount(
          accountId: string,
          options: { state: TwitterClientState },
        ): Promise<TwitterClientInstance>;
      }
    ).getTwitterClientForAccount("default", {
      state: {
        accountId: "default",
        TWITTER_AUTH_MODE: "broker",
        TWITTER_BROKER_TOKEN: "test-token",
        TWITTER_POST_INTERVAL: "1h",
        TWITTER_DM_POLL_INTERVAL_SECONDS: "90s",
      },
    });

    expect(instance.client.state.TWITTER_POST_INTERVAL).toBe("120");
    expect(instance.client.state.TWITTER_DM_POLL_INTERVAL_SECONDS).toBe("60");
    init.mockRestore();
  });

  it("honors account-scoped DM disablement over the runtime default", () => {
    const instance = new TwitterClientInstance(
      runtimeWithSettings({ TWITTER_ENABLE_DMS: "true" }),
      {
        accountId: "personal",
        TWITTER_ENABLE_DMS: "false",
      } as TwitterClientState,
    );

    expect(instance.directMessages).toBeUndefined();
  });

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
    const profile = {
      id: "secondary-user",
      username: "secondary-user",
      screenName: "Secondary User",
      bio: "",
      nicknames: [],
    };
    const withAuthenticatedSession = async <T>(
      operation: (session: {
        client: never;
        profile: typeof profile;
        revision: number;
      }) => Promise<T>,
    ) => operation({ client: {} as never, profile, revision: 1 });
    const getClient = vi
      .spyOn(
        service as unknown as {
          getTwitterClientForAccount: (accountId: unknown) => Promise<{
            client: {
              fetchHomeTimeline: typeof fetchHomeTimeline;
              runtime: IAgentRuntime;
              withAuthenticatedSession: typeof withAuthenticatedSession;
            };
          }>;
        },
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({
        client: { fetchHomeTimeline, runtime, withAuthenticatedSession },
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
    const profile = {
      id: "secondary-user",
      username: "secondary-user",
      screenName: "Secondary User",
      bio: "",
      nicknames: [],
    };
    const withAuthenticatedSession = async <T>(
      operation: (session: {
        client: never;
        profile: typeof profile;
        revision: number;
      }) => Promise<T>,
    ) => operation({ client: {} as never, profile, revision: 1 });
    const getClient = vi
      .spyOn(
        service as unknown as {
          getTwitterClientForAccount: (accountId: unknown) => Promise<{
            client: {
              fetchSearchTweets: typeof fetchSearchTweets;
              withAuthenticatedSession: typeof withAuthenticatedSession;
            };
          }>;
        },
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({
        client: { fetchSearchTweets, withAuthenticatedSession },
      });

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
    const sendDmToParticipant = vi.fn(async () => ({ dm_event_id: "dm-1" }));
    const session = dmSession("current-user", { sendDmToParticipant });
    const withAuthenticatedSession = vi.fn(
      async <T>(
        operation: (active: AuthenticatedTwitterSession) => Promise<T>,
      ) => operation(session),
    );
    const base = {
      twitterClient: {
        withAuthenticatedSession,
        isAuthenticatedSessionCurrent: () => true,
      },
    } as unknown as ClientBase;
    const getClient = vi
      .spyOn(
        service as unknown as {
          getTwitterClientForAccount: (accountId: unknown) => Promise<{
            client: ClientBase;
          }>;
        },
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({ client: base });

    await service.handleSendMessage(
      runtime,
      { source: "x", entityId: "123456" } as TargetInfo,
      {
        text: "hello",
        metadata: { accountId: "secondary" },
      } as Content,
    );

    expect(getClient).toHaveBeenCalledWith("default");
    expect(withAuthenticatedSession).toHaveBeenCalledOnce();
    expect(sendDmToParticipant).toHaveBeenCalledWith("123456", {
      text: "hello",
    });
  });

  it("ignores spoofed content account metadata in the post handler", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const profile = {
      id: "account-owner",
      username: "account-owner",
      screenName: "Account Owner",
      bio: "",
      nicknames: [],
    };
    const base = {
      profile,
      withAuthenticatedSession: async <T>(
        operation: (session: {
          client: never;
          profile: typeof profile;
          revision: number;
        }) => Promise<T>,
      ) => operation({ client: {} as never, profile, revision: 1 }),
    } as unknown as ClientBase;
    const getClient = vi
      .spyOn(
        service as unknown as {
          getTwitterClientForAccount: (accountId: unknown) => Promise<{
            client: ClientBase;
          }>;
        },
        "getTwitterClientForAccount",
      )
      .mockResolvedValue({ client: base });
    vi.spyOn(TwitterPostService.prototype, "createPost").mockResolvedValue({
      id: "post-1",
      agentId: runtime.agentId,
      roomId: "room-1" as never,
      userId: "account-owner",
      username: "account-owner",
      text: "hello",
      timestamp: 1,
    });

    await service.handleSendPost(
      runtime,
      {
        text: "hello",
        accountId: "attacker",
        metadata: { accountId: "attacker" },
      } as Content,
      {
        runtime,
        source: "x",
        accountId: "trusted",
      },
    );

    expect(getClient).toHaveBeenCalledWith("trusted");
  });

  it("forwards the canonical quote id through the post connector", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const profile = {
      id: "account-owner",
      username: "account-owner",
      screenName: "Account Owner",
      bio: "",
      nicknames: [],
    };
    const base = {
      profile,
      withAuthenticatedSession: async <T>(
        operation: (session: {
          client: never;
          profile: typeof profile;
          revision: number;
        }) => Promise<T>,
      ) => operation({ client: {} as never, profile, revision: 1 }),
    } as unknown as ClientBase;
    vi.spyOn(
      service as unknown as {
        getTwitterClientForAccount: () => Promise<{ client: ClientBase }>;
      },
      "getTwitterClientForAccount",
    ).mockResolvedValue({ client: base });
    const createPost = vi
      .spyOn(TwitterPostService.prototype, "createPost")
      .mockResolvedValue({
        id: "quote-1",
        agentId: runtime.agentId,
        roomId: "room-1" as never,
        userId: "account-owner",
        username: "account-owner",
        text: "commentary",
        timestamp: 1,
        quotedPostId: "source-post-1",
      });

    await service.handleSendPost(runtime, {
      text: "commentary",
      quotedPostId: "source-post-1",
    } as Content);

    expect(createPost).toHaveBeenCalledWith(
      expect.objectContaining({ quotedPostId: "source-post-1" }),
      profile,
    );
  });

  it("rejects CJK text that exceeds the X weighted 280 cap before egress", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const getClient = vi.spyOn(
      service as unknown as {
        getTwitterClientForAccount: () => Promise<{ client: ClientBase }>;
      },
      "getTwitterClientForAccount",
    );

    await expect(
      service.handleSendPost(runtime, {
        text: "你".repeat(141),
      } as Content),
    ).rejects.toThrow(/weighted characters; received 282/);
    expect(getClient).not.toHaveBeenCalled();
  });

  it("admits 140 CJK characters and 280 Latin characters", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    const profile = {
      id: "account-owner",
      username: "account-owner",
      screenName: "Account Owner",
      bio: "",
      nicknames: [],
    };
    const base = {
      profile,
      withAuthenticatedSession: async <T>(
        operation: (session: {
          client: never;
          profile: typeof profile;
          revision: number;
        }) => Promise<T>,
      ) => operation({ client: {} as never, profile, revision: 1 }),
    } as unknown as ClientBase;
    vi.spyOn(
      service as unknown as {
        getTwitterClientForAccount: () => Promise<{ client: ClientBase }>;
      },
      "getTwitterClientForAccount",
    ).mockResolvedValue({ client: base });
    const createPost = vi
      .spyOn(TwitterPostService.prototype, "createPost")
      .mockResolvedValue({
        id: "post-cjk",
        agentId: runtime.agentId,
        roomId: "room-1" as never,
        userId: "account-owner",
        username: "account-owner",
        text: "ok",
        timestamp: 1,
      });

    createPost.mockClear();
    await service.handleSendPost(runtime, {
      text: "你".repeat(140),
    } as Content);
    await service.handleSendPost(runtime, {
      text: "a".repeat(280),
    } as Content);

    expect(createPost).toHaveBeenCalledTimes(2);
    expect(createPost).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "你".repeat(140) }),
      profile,
    );
    expect(createPost).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "a".repeat(280) }),
      profile,
    );
  });

  it("keeps DM recipient lookup and send inside one authenticated session", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    let sessionActive = false;
    const sendDmToParticipant = vi.fn(async () => {
      expect(sessionActive).toBe(true);
      return { dm_event_id: "dm-bound" };
    });
    const session = dmSession("account-a", { sendDmToParticipant });
    const fetchProfile = vi.fn(async () => {
      expect(sessionActive).toBe(true);
      return { id: "987654" };
    });
    const withAuthenticatedSession = vi.fn(
      async <T>(
        operation: (active: AuthenticatedTwitterSession) => Promise<T>,
      ) => {
        sessionActive = true;
        try {
          return await operation(session);
        } finally {
          sessionActive = false;
        }
      },
    );
    const base = {
      fetchProfile,
      twitterClient: {
        withAuthenticatedSession,
        isAuthenticatedSessionCurrent: () => true,
      },
    } as unknown as ClientBase;
    vi.spyOn(
      service as unknown as {
        getTwitterClientForAccount: () => Promise<{ client: ClientBase }>;
      },
      "getTwitterClientForAccount",
    ).mockResolvedValue({ client: base });

    await service.handleSendMessage(
      runtime,
      {
        source: "x",
        metadata: { xUsername: "alice" },
      } as TargetInfo,
      { text: "hello alice" } as Content,
    );

    expect(withAuthenticatedSession).toHaveBeenCalledOnce();
    expect(fetchProfile).toHaveBeenCalledWith("alice");
    expect(sendDmToParticipant).toHaveBeenCalledWith("987654", {
      text: "hello alice",
    });
  });

  it("does not send after credentials rotate during DM recipient lookup", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    let current = true;
    const profile = deferred<{ id: string }>();
    const sendA = vi.fn();
    const sendB = vi.fn();
    const session = dmSession("account-a", { sendDmToParticipant: sendA });
    const base = {
      fetchProfile: vi.fn(() => profile.promise),
      twitterClient: {
        withAuthenticatedSession: async <T>(
          operation: (active: AuthenticatedTwitterSession) => Promise<T>,
        ) => operation(session),
        isAuthenticatedSessionCurrent: () => current,
      },
    } as unknown as ClientBase;
    vi.spyOn(
      service as unknown as {
        getTwitterClientForAccount: () => Promise<{ client: ClientBase }>;
      },
      "getTwitterClientForAccount",
    ).mockResolvedValue({ client: base });

    const send = service.handleSendMessage(
      runtime,
      {
        source: "x",
        metadata: { xUsername: "alice" },
      } as TargetInfo,
      { text: "do not cross accounts" } as Content,
    );
    await vi.waitFor(() => expect(base.fetchProfile).toHaveBeenCalledOnce());
    current = false;
    profile.resolve({ id: "987654" });

    await expect(send).rejects.toMatchObject({
      code: "X_AUTH_SESSION_ROTATED",
    });
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();
  });

  it("keeps conversation DM sends inside one authenticated session", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    let sessionActive = false;
    const sendDmInConversation = vi.fn(async () => {
      expect(sessionActive).toBe(true);
      return { dm_event_id: "conversation-reply" };
    });
    const session = dmSession("account-a", { sendDmInConversation });
    const withAuthenticatedSession = vi.fn(
      async <T>(
        operation: (active: AuthenticatedTwitterSession) => Promise<T>,
      ) => {
        sessionActive = true;
        try {
          return await operation(session);
        } finally {
          sessionActive = false;
        }
      },
    );
    const base = {
      twitterClient: {
        withAuthenticatedSession,
        isAuthenticatedSessionCurrent: () => true,
      },
    } as unknown as ClientBase;
    vi.spyOn(
      service as unknown as {
        getTwitterClientForAccount: () => Promise<{ client: ClientBase }>;
      },
      "getTwitterClientForAccount",
    ).mockResolvedValue({ client: base });

    await expect(
      service.sendDirectMessageToConversationForAccount("account-a", {
        conversationId: "conversation-1",
        text: "hello group",
      }),
    ).resolves.toEqual({
      ok: true,
      status: 201,
      messageId: "conversation-reply",
    });
    expect(withAuthenticatedSession).toHaveBeenCalledOnce();
    expect(sendDmInConversation).toHaveBeenCalledWith("conversation-1", {
      text: "hello group",
    });
  });

  it("classifies recent DMs with the captured session profile", async () => {
    const runtime = runtimeWithSettings({});
    const service = new XService(runtime);
    async function* events() {
      yield {
        id: "1",
        sender_id: "current-user",
        participant_ids: ["current-user", "alice"],
        text: "outbound",
      };
      yield {
        id: "2",
        sender_id: "alice",
        participant_ids: ["current-user", "alice"],
        text: "inbound",
      };
    }
    const iterator = Object.assign(events(), {
      includes: {
        users: [
          { id: "current-user", username: "current" },
          { id: "alice", username: "alice" },
        ],
      },
    });
    const session = dmSession("current-user", {
      listDmEvents: vi.fn(async () => iterator),
    });
    const base = {
      profile: { id: "stale-user", username: "stale" },
      twitterClient: {
        withAuthenticatedSession: async <T>(
          operation: (active: AuthenticatedTwitterSession) => Promise<T>,
        ) => operation(session),
        isAuthenticatedSessionCurrent: () => true,
      },
    } as unknown as ClientBase;
    vi.spyOn(
      service as unknown as {
        getTwitterClientForAccount: () => Promise<{ client: ClientBase }>;
      },
      "getTwitterClientForAccount",
    ).mockResolvedValue({ client: base });

    const messages = await (
      service as unknown as {
        listRecentDirectMessages: (
          accountId: string,
          limit: number,
        ) => Promise<Array<{ isInbound: boolean }>>;
      }
    ).listRecentDirectMessages("account-a", 10);

    expect(messages.map((message) => message.isInbound)).toEqual([false, true]);
  });
});
