import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import videoPlugin from "./index.js";
import { BinaryResolver } from "./services/binaries.js";
import { VideoService } from "./services/video.js";

const ytMock = vi.fn();

vi.mock("youtube-dl-exec", () => {
  const callable = (...args: unknown[]) => ytMock(...args);
  // youtube-dl-exec exposes `create(path)` returning a runner with the same shape.
  (callable as unknown as { create: (p: string) => typeof callable }).create = (
    _path: string,
  ) => callable;
  return {
    default: callable,
    create: (_path: string) => callable,
  };
});

describe("@elizaos/plugin-video", () => {
  beforeEach(() => {
    ytMock.mockResolvedValue({
      title: "Stub video",
      description: "",
      channel: "stub",
      subtitles: {
        en: [{ url: "https://example.invalid/subs.srt" }],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        statusText: "OK",
        text: async () =>
          "1\n00:00:00,000 --> 00:00:01,000\nhello world\n",
      })) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ytMock.mockReset();
    BinaryResolver.resetForTests();
  });

  it("exports a plugin wired with VideoService", () => {
    expect(videoPlugin.name).toBe("video");
    expect(videoPlugin.services?.length).toBe(1);
    expect(videoPlugin.services?.[0]).toBe(VideoService);
  });

  // Hand-rolled BinaryResolver double that skips real path resolution / network I/O.
  const stubBinaries = (): BinaryResolver =>
    ({
      getFfmpegPath: async () => null,
      getYtDlpPath: async () => "/usr/bin/yt-dlp",
      getYtDlpRunner: async () => ytMock,
      runYtDlp: (url: string, flags: Record<string, unknown>) =>
        ytMock(url, flags),
    }) as unknown as BinaryResolver;

  it("detects common video hosts", () => {
    const v = new VideoService(undefined, stubBinaries());
    expect(v.isVideoUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(v.isVideoUrl("https://youtu.be/abc")).toBe(true);
    expect(v.isVideoUrl("https://vimeo.com/123")).toBe(true);
    expect(v.isVideoUrl("https://example.com/page")).toBe(false);
  });

  it("processVideo resolves transcript from mocked subtitles", async () => {
    const runtime = {
      getCache: vi.fn(async () => null),
      setCache: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;

    const svc = new VideoService(runtime, stubBinaries());
    const media = await svc.processVideo(
      "https://www.youtube.com/watch?v=testvid",
      runtime,
    );
    expect(media.title).toBe("Stub video");
    expect(media.text).toContain("hello world");
    expect(runtime.setCache).toHaveBeenCalled();
  });
});
