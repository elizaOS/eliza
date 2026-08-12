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
    const keys = (
      runtime.setCache as unknown as { mock: { calls: Array<[string]> } }
    ).mock.calls.map(([key]) => key);
    expect(new Set(keys).size).toBe(2);
  });

  it("handles invalid compact upload_date strings by returning undefined", async () => {
    const { service } = createServiceWithYtDlp([
      {
        title: "Invalid Date Video",
        upload_date: "20249999",
        formats: null,
      },
    ]);

    const info = await service.getVideoInfo("https://youtu.be/invalid-date");
    expect(info.uploadDate).toBeUndefined();
    expect(info.formats).toEqual([]);
  });

  it("parses SRT subtitles with CRLF line endings cleanly", () => {
    const { service } = createServiceWithYtDlp([]);
    const srtContent =
      "1\r\n00:00:01,000 --> 00:00:04,000\r\nHello world!\r\n\r\n2\r\n00:00:04,500 --> 00:00:07,000\r\nThis is a test.\r\nLine 2 text.";

    const parsed = service.parseSRT(srtContent);
    expect(parsed).toBe("Hello world! This is a test. Line 2 text.");
  });

  it("handles empty or non-string SRT input", () => {
    const { service } = createServiceWithYtDlp([]);
    expect(service.parseSRT("")).toBe("");
    expect(service.parseSRT(null as unknown as string)).toBe("");
  });

  it("parses caption JSON and replaces all linebreaks globally", () => {
    const { service } = createServiceWithYtDlp([]);
    const captionJson = JSON.stringify({
      events: [
        { segs: [{ utf8: "First line\n" }, { utf8: "second line\n" }] },
        { segs: [{ utf8: "Third line\n" }] },
      ],
    });

    const parsed = service.parseCaption(captionJson);
    expect(parsed).toBe("First line second line Third line ");
  });

  it("handles invalid or malformed caption JSON gracefully", () => {
    const { service } = createServiceWithYtDlp([]);
    expect(service.parseCaption("")).toBe("");
    expect(service.parseCaption("not-json")).toBe(
      "Error: Unable to parse captions",
    );
    expect(service.parseCaption(JSON.stringify({ events: "invalid" }))).toBe(
      "Error: Unable to parse captions",
    );
  });

  it("safely handles non-string or empty URLs in isVideoUrl", () => {
    const { service } = createServiceWithYtDlp([]);
    expect(service.isVideoUrl("")).toBe(false);
    expect(service.isVideoUrl(null as unknown as string)).toBe(false);
    expect(service.isVideoUrl(undefined as unknown as string)).toBe(false);
    expect(service.isVideoUrl("https://youtube.com/watch?v=123")).toBe(true);
  });
});
