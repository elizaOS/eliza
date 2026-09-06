/** Regression: empty/malformed yt-dlp subtitle and caption arrays must degrade through getTranscript's fallback order (never throw), and a url-less leading variant must not discard the usable track behind it. */

import type {
  IAgentRuntime,
  ITranscriptionService,
  Media,
} from "@elizaos/core";
import { ServiceType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { BinaryResolver } from "./binaries";
import { VideoService } from "./video";

function createRuntime(transcription?: ITranscriptionService) {
  const cache = new Map<string, Media>();
  return {
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: Media) => {
      cache.set(key, value);
    }),
    getService: vi.fn((type: string) =>
      type === ServiceType.TRANSCRIPTION ? transcription : undefined,
    ),
    cache,
  } as unknown as IAgentRuntime & { cache: Map<string, Media> };
}

function createServiceWithYtDlp(result: unknown) {
  const runYtDlp = vi.fn(async () => result);
  const binaries = {
    getFfmpegPath: vi.fn(async () => null),
    runYtDlp,
  } as unknown as BinaryResolver;

  return { service: new VideoService(undefined, binaries), runYtDlp };
}

describe("VideoService.getTranscript empty-caption degradation", () => {
  it("ignores an empty subtitles.en array and short-circuits the Music path", async () => {
    const { service } = createServiceWithYtDlp({
      title: "Empty Subs Music",
      channel: "chan",
      description: "desc",
      categories: ["Music"],
      subtitles: { en: [] },
    });
    const runtime = createRuntime();

    const result = await service.processVideo(
      "https://youtu.be/empty-subs-music",
      runtime,
    );

    expect(result.text).toBe("No lyrics available.");
  });

  it("ignores a subtitles.en track that is missing its url and still degrades", async () => {
    const { service } = createServiceWithYtDlp({
      title: "Malformed Track Music",
      channel: "chan",
      description: "desc",
      categories: ["Music"],
      subtitles: { en: [{}] },
    });
    const runtime = createRuntime();

    const result = await service.processVideo(
      "https://youtu.be/malformed-track-music",
      runtime,
    );

    expect(result.text).toBe("No lyrics available.");
  });

  it("falls through an empty subtitles.en array to automatic captions", async () => {
    const { service } = createServiceWithYtDlp({
      title: "Empty Subs Auto Captions",
      channel: "chan",
      description: "desc",
      subtitles: { en: [] },
      automatic_captions: { en: [{ url: "https://caption.example/en.json" }] },
    });
    const captionJson = JSON.stringify({
      events: [{ segs: [{ utf8: "captured lyric\n" }] }],
    });
    const downloadCaption = vi
      .spyOn(
        service as unknown as {
          downloadCaption: (u: string) => Promise<string>;
        },
        "downloadCaption",
      )
      .mockResolvedValue(captionJson);
    const runtime = createRuntime();

    const result = await service.processVideo(
      "https://youtu.be/empty-subs-auto",
      runtime,
    );

    expect(downloadCaption).toHaveBeenCalledWith(
      "https://caption.example/en.json",
    );
    expect(result.text).toBe("captured lyric ");
  });

  it("falls through both empty caption arrays to audio transcription for a non-music video", async () => {
    const { service } = createServiceWithYtDlp({
      title: "Empty Both Non Music",
      channel: "chan",
      description: "desc",
      subtitles: { en: [] },
      automatic_captions: { en: [] },
      categories: ["Education"],
    });
    const transcribeAudio = vi
      .spyOn(service, "transcribeAudio")
      .mockResolvedValue("mock audio transcript");
    const runtime = createRuntime();

    const result = await service.processVideo(
      "https://youtu.be/empty-both-nonmusic",
      runtime,
    );

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(transcribeAudio).toHaveBeenCalledWith(
      "https://youtu.be/empty-both-nonmusic",
      runtime,
    );
    expect(result.text).toBe("mock audio transcript");
  });

  it("skips a leading url-less subtitles.en variant and consumes the next usable one", async () => {
    const { service } = createServiceWithYtDlp({
      title: "Multi Variant Subs",
      channel: "chan",
      description: "desc",
      categories: ["Music"],
      subtitles: {
        en: [{}, { url: "https://caption.example/en.srt" }],
      },
    });
    const srt = ["1", "00:00:01,000 --> 00:00:04,000", "second variant"].join(
      "\n",
    );
    const downloadSRT = vi
      .spyOn(
        service as unknown as { downloadSRT: (u: string) => Promise<string> },
        "downloadSRT",
      )
      .mockResolvedValue(srt);
    const runtime = createRuntime();

    const result = await service.processVideo(
      "https://youtu.be/multi-variant-subs",
      runtime,
    );

    expect(downloadSRT).toHaveBeenCalledWith("https://caption.example/en.srt");
    expect(result.text).toBe("second variant");
  });

  it("still consumes a populated subtitles.en track ahead of the fallbacks", async () => {
    const { service } = createServiceWithYtDlp({
      title: "Real Subs",
      channel: "chan",
      description: "desc",
      categories: ["Music"],
      subtitles: { en: [{ url: "https://caption.example/en.srt" }] },
    });
    const srt = ["1", "00:00:01,000 --> 00:00:04,000", "hello there"].join(
      "\n",
    );
    const downloadSRT = vi
      .spyOn(
        service as unknown as { downloadSRT: (u: string) => Promise<string> },
        "downloadSRT",
      )
      .mockResolvedValue(srt);
    const runtime = createRuntime();

    const result = await service.processVideo(
      "https://youtu.be/real-subs",
      runtime,
    );

    expect(downloadSRT).toHaveBeenCalledWith("https://caption.example/en.srt");
    expect(result.text).toBe("hello there");
  });
});
