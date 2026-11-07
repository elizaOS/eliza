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

  it("skips a leading url-less automatic_captions.en variant and consumes the next usable one", async () => {
    const { service } = createServiceWithYtDlp({
      title: "Multi Variant Auto Captions",
      channel: "chan",
      description: "desc",
      categories: ["Music"],
      subtitles: { en: [] },
      automatic_captions: {
        en: [{}, { url: "https://caption.example/auto-en.json" }],
      },
    });
    const captionJson = JSON.stringify({
      events: [{ segs: [{ utf8: "second auto variant\n" }] }],
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
      "https://youtu.be/multi-variant-auto",
      runtime,
    );

    expect(downloadCaption).toHaveBeenCalledWith(
      "https://caption.example/auto-en.json",
    );
    expect(result.text).toBe("second auto variant ");
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

describe("VideoService.getTranscript manual subtitle format selection", () => {
  // yt-dlp's YouTube extractor lists every manual subtitle language as these
  // variants, in this order; only SRT and WebVTT are line-based cue formats.
  const youtubeVariants = (formats: string[]) =>
    formats.map((ext) => ({
      ext,
      url: `https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=${ext}`,
    }));
  const json3 = JSON.stringify(
    {
      wireMagic: "pb3",
      events: [
        { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "hello there" }] },
      ],
    },
    null,
    2,
  );
  const bodies: Record<string, string> = {
    json3,
    srv1: '<?xml version="1.0" encoding="utf-8" ?><transcript><text start="1" dur="3">hello there</text></transcript>',
    srt: ["1", "00:00:01,000 --> 00:00:04,000", "hello there", ""].join("\n"),
    vtt: [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "hello there",
      "",
      "00:00:04.000 --> 00:00:06.000 align:start position:0%",
      "general kenobi",
      "",
    ].join("\n"),
  };

  function serviceWithManualSubtitles(formats: string[]) {
    const { service } = createServiceWithYtDlp({
      title: "YouTube Manual Subs",
      channel: "chan",
      description: "desc",
      subtitles: { en: youtubeVariants(formats) },
    });
    const downloadSRT = vi
      .spyOn(
        service as unknown as { downloadSRT: (u: string) => Promise<string> },
        "downloadSRT",
      )
      .mockImplementation(
        async (url: string) =>
          bodies[new URL(url).searchParams.get("fmt") ?? ""] ?? "",
      );
    return { service, downloadSRT };
  }

  it.each(["json3", "srv1", "ttml"])(
    "skips unsupported manual %s subtitles and uses available automatic captions",
    async (ext) => {
      const { service } = createServiceWithYtDlp({
        title: "Unsupported manual format",
        subtitles: { en: youtubeVariants([ext]) },
        automatic_captions: {
          en: [{ url: "https://caption.example/auto.json" }],
        },
      });
      const downloadSRT = vi.spyOn(
        service as unknown as { downloadSRT: (url: string) => Promise<string> },
        "downloadSRT",
      );
      const downloadCaption = vi
        .spyOn(
          service as unknown as {
            downloadCaption: (url: string) => Promise<string>;
          },
          "downloadCaption",
        )
        .mockResolvedValue(json3);
      const result = await service.processVideo(
        "https://youtu.be/unsupported-manual",
        createRuntime(),
      );
      expect(result.text).toBe("hello there");
      expect(downloadSRT).not.toHaveBeenCalled();
      expect(downloadCaption).toHaveBeenCalledWith(
        "https://caption.example/auto.json",
      );
    },
  );

  it("finds extensionless SRT after a known unsupported manual variant", async () => {
    const { service } = createServiceWithYtDlp({
      title: "Extensionless manual format",
      subtitles: {
        en: [
          ...youtubeVariants(["json3"]),
          { url: "https://caption.example/manual" },
        ],
      },
    });
    const downloadSRT = vi
      .spyOn(
        service as unknown as { downloadSRT: (url: string) => Promise<string> },
        "downloadSRT",
      )
      .mockResolvedValue(bodies.srt);
    const result = await service.processVideo(
      "https://youtu.be/extensionless-manual",
      createRuntime(),
    );
    expect(result.text).toBe("hello there");
    expect(downloadSRT).toHaveBeenCalledExactlyOnceWith(
      "https://caption.example/manual",
    );
  });

  it.each(["", "WEBVTT\n\nNOTE captions unavailable"])(
    "continues to automatic captions when manual cues are empty (%s)",
    async (body) => {
      const { service } = createServiceWithYtDlp({
        title: "Empty manual cues",
        subtitles: { en: youtubeVariants(["srt"]) },
        automatic_captions: {
          en: [{ url: "https://caption.example/auto.json" }],
        },
      });
      vi.spyOn(
        service as unknown as { downloadSRT: (url: string) => Promise<string> },
        "downloadSRT",
      ).mockResolvedValue(body);
      const downloadCaption = vi
        .spyOn(
          service as unknown as {
            downloadCaption: (url: string) => Promise<string>;
          },
          "downloadCaption",
        )
        .mockResolvedValue(json3);
      const result = await service.processVideo(
        "https://youtu.be/empty-manual",
        createRuntime(),
      );
      expect(result.text).toBe("hello there");
      expect(downloadCaption).toHaveBeenCalledOnce();
    },
  );

  it("falls back to audio when manual cues are empty and no automatic captions exist", async () => {
    const { service, downloadSRT } = serviceWithManualSubtitles(["srt"]);
    downloadSRT.mockResolvedValue("");
    const transcribeAudio = vi
      .spyOn(service, "transcribeAudio")
      .mockResolvedValue("audio evidence");
    const runtime = createRuntime();
    const result = await service.processVideo(
      "https://youtu.be/empty-manual-audio",
      runtime,
    );
    expect(result.text).toBe("audio evidence");
    expect(transcribeAudio).toHaveBeenCalledExactlyOnceWith(
      "https://youtu.be/empty-manual-audio",
      runtime,
    );
  });

  it("uses the SRT variant instead of yt-dlp's leading json3 variant", async () => {
    const { service, downloadSRT } = serviceWithManualSubtitles([
      "json3",
      "srv1",
      "srv2",
      "srv3",
      "ttml",
      "srt",
      "vtt",
    ]);

    const result = await service.processVideo(
      "https://www.youtube.com/watch?v=manual-srt",
      createRuntime(),
    );

    expect(result.text).toBe("hello there");
    expect(downloadSRT).toHaveBeenCalledTimes(1);
    expect(downloadSRT).toHaveBeenCalledWith(
      "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=srt",
    );
  });

  it("falls back to the WebVTT variant and keeps cues that have no identifier", async () => {
    const { service, downloadSRT } = serviceWithManualSubtitles([
      "json3",
      "srv1",
      "vtt",
    ]);

    const result = await service.processVideo(
      "https://www.youtube.com/watch?v=manual-vtt",
      createRuntime(),
    );

    expect(result.text).toBe("hello there general kenobi");
    expect(downloadSRT).toHaveBeenCalledWith(
      "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=vtt",
    );
  });
});
