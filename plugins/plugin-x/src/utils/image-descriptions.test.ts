/** Unit tests for `describeTweetPhotos`: empty when no photos/model/DISABLE flag, and per-photo image Media description otherwise; mocked runtime + model. */
import { type IAgentRuntime, ModelType, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { Tweet } from "../client/tweets";
import { describeTweetPhotos } from "./image-descriptions";

function asRuntime<T extends object>(runtime: T): IAgentRuntime & T {
  return runtime as IAgentRuntime & T;
}

function createRuntime(options: {
  hasImageModel?: boolean;
  settings?: Record<string, unknown>;
  describe?: (url: string) => Promise<{ title?: string; description?: string }>;
}) {
  const {
    hasImageModel = true,
    settings = {},
    describe: describeImpl,
  } = options;
  const useModel = vi.fn(async (_type: string, url: string) =>
    describeImpl
      ? await describeImpl(url)
      : { title: "Photo", description: `description of ${url}` },
  );
  return {
    runtime: asRuntime({
      agentId: "agent-1" as UUID,
      getSetting: vi.fn((key: string) => settings[key]),
      getModel: vi.fn((type: string) =>
        hasImageModel && type === ModelType.IMAGE_DESCRIPTION
          ? () => undefined
          : undefined,
      ),
      useModel,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }),
    useModel,
  };
}

function tweetWithPhotos(
  photos: { id: string; url: string; alt_text?: string }[],
): Pick<Tweet, "photos"> {
  return {
    photos: photos.map((p) => ({ alt_text: undefined, ...p })),
  };
}

describe("describeTweetPhotos", () => {
  it("returns empty when the tweet has no photos", async () => {
    const { runtime, useModel } = createRuntime({});
    const result = await describeTweetPhotos(runtime, tweetWithPhotos([]));
    expect(result).toEqual([]);
    expect(useModel).not.toHaveBeenCalled();
  });

  it("returns empty when no IMAGE_DESCRIPTION model is registered", async () => {
    const { runtime, useModel } = createRuntime({ hasImageModel: false });
    const result = await describeTweetPhotos(
      runtime,
      tweetWithPhotos([{ id: "p1", url: "https://example.com/a.jpg" }]),
    );
    expect(result).toEqual([]);
    expect(useModel).not.toHaveBeenCalled();
  });

  it("returns empty when DISABLE_IMAGE_DESCRIPTION is set", async () => {
    const { runtime, useModel } = createRuntime({
      settings: { DISABLE_IMAGE_DESCRIPTION: "true" },
    });
    const result = await describeTweetPhotos(
      runtime,
      tweetWithPhotos([{ id: "p1", url: "https://example.com/a.jpg" }]),
    );
    expect(result).toEqual([]);
    expect(useModel).not.toHaveBeenCalled();
  });

  it("describes each photo as an image Media attachment", async () => {
    const { runtime, useModel } = createRuntime({});
    const result = await describeTweetPhotos(
      runtime,
      tweetWithPhotos([
        { id: "p1", url: "https://example.com/a.jpg" },
        { id: "p2", url: "https://example.com/b.png" },
      ]),
    );

    expect(useModel).toHaveBeenCalledTimes(2);
    expect(useModel).toHaveBeenCalledWith(
      ModelType.IMAGE_DESCRIPTION,
      "https://example.com/a.jpg",
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "p1",
      url: "https://example.com/a.jpg",
      contentType: "image",
      source: "twitter",
      description: "description of https://example.com/a.jpg",
      text: "description of https://example.com/a.jpg",
    });
  });

  it("skips non-remote photo urls", async () => {
    const { runtime, useModel } = createRuntime({});
    const result = await describeTweetPhotos(
      runtime,
      tweetWithPhotos([{ id: "p1", url: "ftp://example.com/a.jpg" }]),
    );
    expect(result).toEqual([]);
    expect(useModel).not.toHaveBeenCalled();
  });

  it("falls back to alt text but still yields Media when description fails", async () => {
    const { runtime } = createRuntime({
      describe: async () => {
        throw new Error("vision model offline");
      },
    });
    const result = await describeTweetPhotos(
      runtime,
      tweetWithPhotos([
        { id: "p1", url: "https://example.com/a.jpg", alt_text: "a red cat" },
      ]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "p1",
      contentType: "image",
      description: "a red cat",
      text: "a red cat",
    });
  });
});
