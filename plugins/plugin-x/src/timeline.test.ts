/** Verifies timeline media interpretation and current-account self filtering with deterministic client fakes. */
import {
  type IAgentRuntime,
  ModelType,
  type ModelTypeName,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import type { Client, Tweet } from "./client/index";
import { TwitterTimelineClient } from "./timeline";
import type { TwitterClientState } from "./types";

function makeClient(overrides: Record<string, unknown> = {}): ClientBase {
  const identityCache = new Map<string, unknown>();
  const client = {
    twitterClient: {} as Client,
    accountId: "default",
    profile: { id: "agent", username: "agent" },
    getAuthenticatedProfile: async () => ({
      id: "agent",
      username: "agent",
      screenName: "Agent",
      bio: "",
      nicknames: [],
    }),
    isAuthenticatedSessionCurrent: () => true,
    identityCacheKey: (profile: { id: string }, suffix: string) =>
      `twitter/default/${profile.id}/${suffix}`,
    getIdentityCache: async (profile: { id: string }, suffix: string) =>
      identityCache.get(`twitter/default/${profile.id}/${suffix}`),
    setIdentityCache: async (
      profile: { id: string },
      suffix: string,
      value: unknown,
    ) => {
      identityCache.set(`twitter/default/${profile.id}/${suffix}`, value);
    },
    ...overrides,
  } as unknown as ClientBase;
  if (!("withAuthenticatedSession" in overrides)) {
    client.withAuthenticatedSession = async (operation) =>
      operation({
        client: client.twitterClient as never,
        profile: await client.getAuthenticatedProfile(),
        revision: 1,
      });
  }
  return client;
}

function makeRuntime(overrides: Partial<IAgentRuntime>): IAgentRuntime {
  return {
    agentId: "agent-1",
    character: { templates: {} },
    getSetting: () => undefined,
    ...overrides,
  } as unknown as IAgentRuntime;
}

function makeTweet(partial: Partial<Tweet>): Tweet {
  return {
    id: "tweet-1",
    userId: "user-1",
    username: "someone",
    text: "look at this",
    hashtags: [],
    mentions: [],
    photos: [],
    videos: [],
    thread: [],
    urls: [],
    ...partial,
  } as Tweet;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TwitterTimelineClient scheduling", () => {
  it("does not prefix-parse a partial engagement interval", async () => {
    vi.useFakeTimers();
    const client = new TwitterTimelineClient(makeClient(), makeRuntime({}), {
      TWITTER_ENGAGEMENT_INTERVAL: "1h",
    } as TwitterClientState);
    const handleTimeline = vi
      .spyOn(client, "handleTimeline")
      .mockResolvedValue(undefined);

    await client.start();
    expect(handleTimeline).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 - 1);
    expect(handleTimeline).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(handleTimeline).toHaveBeenCalledTimes(2);
    await client.stop();
    vi.clearAllTimers();
  });
});

describe("TwitterTimelineClient.describeTweetMedia", () => {
  it("interprets photos and video previews via IMAGE_DESCRIPTION", async () => {
    const useModel = vi.fn(async (_type: ModelTypeName, params: unknown) => {
      const { imageUrl } = params as { imageUrl: string };
      return {
        title: "img",
        description: `seen ${imageUrl}`,
      };
    });
    const runtime = makeRuntime({
      getModel: ((type: ModelTypeName) =>
        type === ModelType.IMAGE_DESCRIPTION
          ? () => undefined
          : undefined) as IAgentRuntime["getModel"],
      useModel: useModel as unknown as IAgentRuntime["useModel"],
    });

    const client = new TwitterTimelineClient(
      makeClient(),
      runtime,
      {} as TwitterClientState,
    );

    const tweet = makeTweet({
      photos: [{ id: "p1", url: "https://x/photo.jpg", alt_text: undefined }],
      videos: [
        {
          id: "v1",
          preview: "https://x/video-preview.jpg",
          url: "https://x/v.mp4",
        },
      ],
    });

    const result = await client.describeTweetMedia(
      tweet as Parameters<typeof client.describeTweetMedia>[0],
    );

    expect(useModel).toHaveBeenCalledTimes(2);
    expect(useModel).toHaveBeenCalledWith(ModelType.IMAGE_DESCRIPTION, {
      imageUrl: "https://x/photo.jpg",
    });
    expect(useModel).toHaveBeenCalledWith(ModelType.IMAGE_DESCRIPTION, {
      imageUrl: "https://x/video-preview.jpg",
    });
    expect(result).toContain("# Media in the tweet");
    expect(result).toContain("seen https://x/photo.jpg");
    expect(result).toContain("seen https://x/video-preview.jpg");
  });

  it("returns empty string when the tweet has no media", async () => {
    const useModel = vi.fn();
    const runtime = makeRuntime({
      getModel: (() => () => undefined) as IAgentRuntime["getModel"],
      useModel: useModel as unknown as IAgentRuntime["useModel"],
    });
    const client = new TwitterTimelineClient(
      makeClient(),
      runtime,
      {} as TwitterClientState,
    );

    const result = await client.describeTweetMedia(
      makeTweet({}) as Parameters<typeof client.describeTweetMedia>[0],
    );

    expect(result).toBe("");
    expect(useModel).not.toHaveBeenCalled();
  });

  it("skips interpretation when no IMAGE_DESCRIPTION model is registered", async () => {
    const useModel = vi.fn();
    const runtime = makeRuntime({
      getModel: (() => undefined) as IAgentRuntime["getModel"],
      useModel: useModel as unknown as IAgentRuntime["useModel"],
    });
    const client = new TwitterTimelineClient(
      makeClient(),
      runtime,
      {} as TwitterClientState,
    );

    const tweet = makeTweet({
      photos: [{ id: "p1", url: "https://x/photo.jpg", alt_text: undefined }],
    });

    const result = await client.describeTweetMedia(
      tweet as Parameters<typeof client.describeTweetMedia>[0],
    );

    expect(result).toBe("");
    expect(useModel).not.toHaveBeenCalled();
  });

  it("accepts string IMAGE_DESCRIPTION results and tolerates per-media failures", async () => {
    const useModel = vi
      .fn()
      .mockResolvedValueOnce("a cat sitting on a keyboard")
      .mockRejectedValueOnce(new Error("vision model timeout"));
    const runtime = makeRuntime({
      getModel: (() => () => undefined) as IAgentRuntime["getModel"],
      useModel: useModel as unknown as IAgentRuntime["useModel"],
    });
    const client = new TwitterTimelineClient(
      makeClient(),
      runtime,
      {} as TwitterClientState,
    );

    const tweet = makeTweet({
      photos: [
        { id: "p1", url: "https://x/a.jpg", alt_text: undefined },
        { id: "p2", url: "https://x/b.jpg", alt_text: undefined },
      ],
    });

    const result = await client.describeTweetMedia(
      tweet as Parameters<typeof client.describeTweetMedia>[0],
    );

    expect(result).toContain("a cat sitting on a keyboard");
    // The second image failed, so only one description survives.
    expect(result.match(/^- /gm)?.length).toBe(1);
  });
});

describe("TwitterTimelineClient.getTimeline", () => {
  it("filters the current account by user id after identity rotation", async () => {
    const fetchHomeTimeline = vi.fn(async () => [
      makeTweet({
        id: "current-self",
        userId: "account-b",
        username: "renamed-current-b",
      }),
      makeTweet({
        id: "former-self",
        userId: "account-a",
        username: "stale-a",
      }),
      makeTweet({ id: "external", userId: "person-1" }),
    ]);
    const runtime = makeRuntime({});
    const client = new TwitterTimelineClient(
      makeClient({
        profile: { id: "account-a", username: "stale-a" },
        getAuthenticatedProfile: async () => ({
          id: "account-b",
          username: "current-b",
          screenName: "Current B",
          bio: "",
          nicknames: [],
        }),
        twitterClient: { fetchHomeTimeline },
      }),
      runtime,
      {} as TwitterClientState,
    );

    const tweets = await client.getTimeline(20);

    expect(tweets.map((tweet) => tweet.id)).toEqual([
      "former-self",
      "external",
    ]);
  });
});

describe("TwitterTimelineClient.handleTimeline", () => {
  function actionRuntime(overrides: Partial<IAgentRuntime> = {}) {
    return makeRuntime({
      getModel: (() => undefined) as IAgentRuntime["getModel"],
      getMemoryById: vi.fn(async () => null),
      composeState: vi.fn(async () => ({ values: {}, data: {}, text: "" })),
      useModel: vi.fn(
        async () => "[LIKE]",
      ) as unknown as IAgentRuntime["useModel"],
      ensureRoomExists: vi.fn(async () => undefined),
      createMemory: vi.fn(async () => undefined),
      ensureWorldExists: vi.fn(async () => undefined),
      updateWorld: vi.fn(async () => undefined),
      ensureConnection: vi.fn(async () => undefined),
      reportError: vi.fn(),
      ...overrides,
    });
  }

  it("keeps timeline reads, model decisions, and effects inside one authenticated session", async () => {
    let sessionDepth = 0;
    const phases: string[] = [];
    const profile = {
      id: "account-a",
      username: "account-a",
      screenName: "Account A",
      bio: "",
      nicknames: [],
    };
    const fetchHomeTimeline = vi.fn(async () => {
      expect(sessionDepth).toBe(1);
      phases.push("read");
      return [makeTweet({ id: "candidate", userId: "person-1" })];
    });
    const likeTweet = vi.fn(async () => {
      expect(sessionDepth).toBe(1);
      phases.push("effect");
    });
    const twitterClient = { fetchHomeTimeline, likeTweet };
    const session = { client: twitterClient as never, profile, revision: 1 };
    const withAuthenticatedSession = vi.fn(
      async (operation: (captured: typeof session) => Promise<unknown>) => {
        sessionDepth += 1;
        try {
          return await operation(session);
        } finally {
          sessionDepth -= 1;
        }
      },
    );
    const runtime = actionRuntime({
      getMemoryById: vi.fn(async () => {
        expect(sessionDepth).toBe(1);
        return null;
      }),
      composeState: vi.fn(async () => {
        expect(sessionDepth).toBe(1);
        return { values: {}, data: {}, text: "" };
      }),
      useModel: vi.fn(async () => {
        expect(sessionDepth).toBe(1);
        phases.push("model");
        return "[LIKE]";
      }) as unknown as IAgentRuntime["useModel"],
    });
    const client = makeClient({
      twitterClient,
      withAuthenticatedSession,
      isAuthenticatedSessionCurrent: () => true,
    });

    await new TwitterTimelineClient(
      client,
      runtime,
      {} as TwitterClientState,
    ).handleTimeline();

    expect(withAuthenticatedSession).toHaveBeenCalledOnce();
    expect(phases).toEqual(["read", "model", "effect"]);
    expect(likeTweet).toHaveBeenCalledWith("candidate");
    expect(sessionDepth).toBe(0);
  });

  it("does not execute an account B effect for a timeline read under account A", async () => {
    let current = true;
    let markModelStarted!: () => void;
    let releaseModel!: (value: string) => void;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const modelResult = new Promise<string>((resolve) => {
      releaseModel = resolve;
    });
    const profile = {
      id: "account-a",
      username: "account-a",
      screenName: "Account A",
      bio: "",
      nicknames: [],
    };
    const likeTweet = vi.fn();
    const twitterClient = {
      fetchHomeTimeline: vi.fn(async () => [
        makeTweet({ id: "candidate", userId: "person-1" }),
      ]),
      likeTweet,
    };
    const session = { client: twitterClient as never, profile, revision: 1 };
    const runtime = actionRuntime({
      useModel: vi.fn(async () => {
        markModelStarted();
        return modelResult;
      }) as unknown as IAgentRuntime["useModel"],
    });
    const client = makeClient({
      twitterClient,
      withAuthenticatedSession: async (
        operation: (captured: typeof session) => Promise<unknown>,
      ) => operation(session),
      isAuthenticatedSessionCurrent: () => current,
    });
    const processing = new TwitterTimelineClient(
      client,
      runtime,
      {} as TwitterClientState,
    ).handleTimeline();
    await modelStarted;

    current = false;
    releaseModel("[LIKE]");

    await expect(processing).rejects.toMatchObject({
      code: "X_AUTH_SESSION_ROTATED",
    });
    expect(likeTweet).not.toHaveBeenCalled();
  });
});
