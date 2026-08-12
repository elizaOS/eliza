import type { ElizaError, IAgentRuntime, Media } from "@elizaos/core";
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

  it("rejects malformed yt-dlp format collections with a typed error", async () => {
    const { service } = createServiceWithYtDlp([
      { title: "Malformed metadata", formats: { format_id: "not-an-array" } },
      { formats: [null] },
      "not-json-metadata",
    ]);

    await expect(
      service.getVideoInfo("https://youtu.be/malformed"),
    ).rejects.toMatchObject({
      code: "VIDEO_METADATA_FORMATS_INVALID",
    } satisfies Partial<ElizaError>);
    await expect(
      service.getAvailableFormats("https://youtu.be/malformed"),
    ).rejects.toMatchObject({
      code: "VIDEO_METADATA_FORMAT_ENTRY_INVALID",
      context: { index: 0 },
    } satisfies Partial<ElizaError>);
    await expect(
      service.getAvailableFormats("https://youtu.be/malformed"),
    ).rejects.toMatchObject({
      code: "VIDEO_METADATA_INVALID",
    } satisfies Partial<ElizaError>);
  });

  it("preserves the original yt-dlp failure", async () => {
    const upstreamFailure = new Error("yt-dlp unavailable");
    const { service } = createServiceWithYtDlp([upstreamFailure]);

    await expect(
      service.getAvailableFormats("https://youtu.be/upstream-failure"),
    ).rejects.toBe(upstreamFailure);
  });

  it("parses SRT subtitles with CRLF line endings cleanly", () => {
    const { service } = createServiceWithYtDlp([]);
    const srtContent = [
      "1",
      "00:00:01,000 --> 00:00:04,000",
      "Hello world!",
      "",
      "2",
      "00:00:04,500 --> 00:00:07,000",
      "This is a test.",
      "Line 2 text.",
    ].join("\r\n");

    const parsed = service["parseSRT"](srtContent);
    expect(parsed).toBe("Hello world! This is a test. Line 2 text.");
  });

  it("handles empty or non-string SRT input", () => {
    const { service } = createServiceWithYtDlp([]);
    expect(service["parseSRT"]("")).toBe("");
    expect(service["parseSRT"](null as unknown as string)).toBe("");
  });

  it("parses caption JSON and replaces all linebreaks globally", () => {
    const { service } = createServiceWithYtDlp([]);
    const captionJson = JSON.stringify({
      events: [
        { segs: [{ utf8: "First line\n" }, { utf8: "second line\n" }] },
        { segs: [{ utf8: "Third line\n" }] },
      ],
    });

    const parsed = service["parseCaption"](captionJson);
    expect(parsed).toBe("First line second line Third line ");
  });

  it("handles invalid or malformed caption JSON gracefully", () => {
    const { service } = createServiceWithYtDlp([]);
    expect(service["parseCaption"]("")).toBe("");
    expect(service["parseCaption"]("not-json")).toBe(
      "Error: Unable to parse captions",
    );
    expect(service["parseCaption"](JSON.stringify({ events: "invalid" }))).toBe(
      "Error: Unable to parse captions",
    );
  });

  it("returns false for non-string video URL input", () => {
    const { service } = createServiceWithYtDlp([]);
    expect(service.isVideoUrl(null as unknown as string)).toBe(false);
    expect(service.isVideoUrl({} as unknown as string)).toBe(false);
  });
});
