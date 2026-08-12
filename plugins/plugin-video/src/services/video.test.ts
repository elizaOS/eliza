import type { IAgentRuntime, Media } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { BinaryResolver } from "./binaries";
import { VideoService } from "./video";

function createRuntime() {
  const cache = new Map<string, Media>();
  return {
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: Media) => {
      cache.set(key, value);
    }),
    cache,
  } as unknown as IAgentRuntime & { cache: Map<string, Media> };
}

function createServiceWithYtDlp(results: unknown[]) {
  const runYtDlp = vi.fn(async () => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const binaries = {
    getFfmpegPath: vi.fn(async () => null),
    runYtDlp,
  } as unknown as BinaryResolver;

  return {
    service: new VideoService(undefined, binaries),
    runYtDlp,
  };
}

describe("VideoService deterministic behavior", () => {
  it("parses yt-dlp compact upload_date into a valid Date", async () => {
    const { service } = createServiceWithYtDlp([
      {
        title: "Video",
        upload_date: "20240531",
        formats: [],
      },
    ]);

    const info = await service.getVideoInfo("https://youtu.be/video-id");

    expect(info.uploadDate).toBeInstanceOf(Date);
    expect(info.uploadDate?.toISOString()).toBe("2024-05-31T00:00:00.000Z");
  });

  it("uses distinct cache keys for non-YouTube video URLs", async () => {
    const { service } = createServiceWithYtDlp([
      {
        title: "First Vimeo",
        channel: "channel",
        description: "first",
        categories: ["Music"],
      },
      {
        title: "Second Vimeo",
        channel: "channel",
        description: "second",
        categories: ["Music"],
      },
    ]);
    const runtime = createRuntime();

    const first = await service.processVideo("https://vimeo.com/111", runtime);
    const second = await service.processVideo("https://vimeo.com/222", runtime);

    expect(first.title).toBe("First Vimeo");
    expect(second.title).toBe("Second Vimeo");
    expect(runtime.setCache).toHaveBeenCalledTimes(2);
    const keys = vi.mocked(runtime.setCache).mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(2);
  });

  it("normalizes every automatic-caption line break", async () => {
    const { service } = createServiceWithYtDlp([
      {
        title: "Captioned video",
        channel: "channel",
        description: "description",
        automatic_captions: {
          en: [{ url: "https://captions.example/video.json" }],
        },
      },
    ]);
    const runtime = createRuntime();
    const captionResponse = new Response(
      JSON.stringify({
        events: [
          { segs: [{ utf8: "first\nsecond\r\n" }] },
          { segs: [{ utf8: "third\nfourth" }] },
        ],
      }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(captionResponse);

    try {
      const result = await service.processVideo(
        "https://youtu.be/captioned-video",
        runtime,
      );

      expect(result.text).toBe("first second third fourth");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://captions.example/video.json",
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
