/** Unit tests for `TwitterTimelineClient.describeTweetMedia`: photo/video interpretation via IMAGE_DESCRIPTION, empty-media and missing-model paths, and per-media failure tolerance; mocked runtime. */
import {
  type IAgentRuntime,
  ModelType,
  type ModelTypeName,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import type { Client, Tweet } from "./client/index";
import { TwitterTimelineClient } from "./timeline";
import type { TwitterClientState } from "./types";

function makeClient(): ClientBase {
  return {
    twitterClient: {} as Client,
    accountId: "default",
    profile: { username: "agent" },
  } as unknown as ClientBase;
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
