/** Exercises VideoService metadata and parsing boundaries with deterministic binary doubles. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElizaError, IAgentRuntime, Media } from "@elizaos/core";
import { ChannelType, TaskStatus, type UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it, vi } from "vitest";
import { mediaStatusAction, registerMediaJobWorker } from "../jobs";
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
  it("accepts a cache directory created after a stale absence observation", () => {
    fs.mkdirSync("./content_cache", { recursive: true });
    const exists = fs.existsSync.bind(fs);
    const probe = vi
      .spyOn(fs, "existsSync")
      .mockImplementation((value) =>
        value === "./content_cache" ? false : exists(value),
      );
    try {
      expect(() => createServiceWithYtDlp([])).not.toThrow();
    } finally {
      probe.mockRestore();
    }
  });

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

  it("rejects malformed fields before they enter the public format DTO", async () => {
    const malformedFields: Array<[string, unknown]> = [
      ["format_id", 123],
      ["url", {}],
      ["ext", false],
      ["quality", {}],
      ["quality", Number.POSITIVE_INFINITY],
      ["filesize", "huge"],
      ["filesize", -1],
      ["vcodec", 123],
      ["acodec", false],
      ["resolution", []],
      ["fps", Number.POSITIVE_INFINITY],
      ["fps", -1],
      ["tbr", Number.NaN],
      ["tbr", -1],
    ];

    for (const [field, value] of malformedFields) {
      const { service } = createServiceWithYtDlp([
        { formats: [{ [field]: value }] },
      ]);

      await expect(
        service.getVideoInfo("https://youtu.be/malformed-field"),
      ).rejects.toMatchObject({
        code: "VIDEO_METADATA_FORMAT_FIELD_INVALID",
        context: { index: 0, field },
      } satisfies Partial<ElizaError>);
    }
  });

  it("normalizes legitimate missing format fields without leaking null", async () => {
    const { service } = createServiceWithYtDlp([
      {
        formats: [
          {
            format_id: "720p",
            url: "https://example.com/video",
            ext: "mp4",
            quality: 7,
            filesize: null,
            vcodec: null,
            acodec: "aac",
            resolution: "1280x720",
            fps: 30,
            tbr: 2500,
          },
        ],
      },
    ]);

    await expect(
      service.getAvailableFormats("https://youtu.be/valid-format"),
    ).resolves.toEqual([
      {
        formatId: "720p",
        url: "https://example.com/video",
        extension: "mp4",
        quality: "7",
        fileSize: undefined,
        videoCodec: undefined,
        audioCodec: "aac",
        resolution: "1280x720",
        fps: 30,
        bitrate: 2500,
      },
    ]);
  });

  it("preserves the original yt-dlp failure", async () => {
    const upstreamFailure = new Error("yt-dlp unavailable");
    const { service } = createServiceWithYtDlp([upstreamFailure]);

    await expect(
      service.getAvailableFormats("https://youtu.be/upstream-failure"),
    ).rejects.toBe(upstreamFailure);
  });

  it("rejects calendar-invalid compact upload_date values that Date would overflow", async () => {
    const { service, runYtDlp } = createServiceWithYtDlp([
      {
        title: "Feb 31",
        upload_date: "20240231",
        formats: [],
      },
      {
        title: "Non-leap Feb 29",
        upload_date: "20230229",
        formats: [],
      },
      {
        title: "Apr 31",
        upload_date: "20240431",
        formats: [],
      },
      {
        title: "Leap Feb 29",
        upload_date: "20240229",
        formats: [],
      },
    ]);

    const feb31 = await service.getVideoInfo("https://youtu.be/feb31");
    const nonLeap = await service.getVideoInfo("https://youtu.be/nonleap");
    const apr31 = await service.getVideoInfo("https://youtu.be/apr31");
    const leap = await service.getVideoInfo("https://youtu.be/leap");

    expect(feb31.uploadDate).toBeUndefined();
    expect(nonLeap.uploadDate).toBeUndefined();
    expect(apr31.uploadDate).toBeUndefined();
    expect(leap.uploadDate?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(runYtDlp).toHaveBeenCalledTimes(4);
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

    const parsed = service.parseSRT(srtContent);
    expect(parsed).toBe("Hello world! This is a test. Line 2 text.");
  });

  it("keeps the first text line of WebVTT cues that have no identifier", () => {
    const { service } = createServiceWithYtDlp([]);
    const vttContent = [
      "WEBVTT",
      "",
      "NOTE produced by a caption editor",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Hello world!",
      "",
      "intro",
      "00:00:04.500 --> 00:00:07.000 align:start",
      "This is a test.",
      "Line 2 text.",
    ].join("\n");

    expect(service.parseSRT(vttContent)).toBe(
      "Hello world! This is a test. Line 2 text.",
    );
  });

  it("splits SRT cues on whitespace-only or bare-CR separators without leaking timings", () => {
    const { service } = createServiceWithYtDlp([]);
    const spaced = [
      "1",
      "00:00:01,000 --> 00:00:04,000",
      "Hello world!",
      "  ",
      "2",
      "00:00:04,500 --> 00:00:07,000",
      "This is a test.",
    ].join("\n");
    const bareCr = spaced.replace(/\n/g, "\r");

    expect(service.parseSRT(spaced)).toBe("Hello world! This is a test.");
    expect(service.parseSRT(bareCr)).toBe("Hello world! This is a test.");
  });

  it("ignores WebVTT metadata even when it contains cue-like timestamps", () => {
    const { service } = createServiceWithYtDlp([]);
    const metadata = [
      "NOTE",
      "NOTE editor comment",
      "NOTE\teditor comment",
      "STYLE",
      "REGION",
    ]
      .map((header) => `${header}\n00:00:01.000 --> 00:00:04.000\nnot spoken`)
      .join("\n\n");
    const content = `WEBVTT\n\n${metadata}\n\nNOTES\n00:00:04.000 --> 00:00:06.000\nActual speech`;
    expect(service.parseSRT(content)).toBe("Actual speech");
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

  it("normalizes CRLF and bare CR inside caption segments without leaking \\r", () => {
    const { service } = createServiceWithYtDlp([]);
    const captionJson = JSON.stringify({
      events: [
        { segs: [{ utf8: "first\r\nsecond" }, { utf8: "\rthird\r" }] },
        { segs: [{ utf8: "fourth\rfifth\n" }] },
      ],
    });

    const parsed = service.parseCaption(captionJson);
    expect(parsed).toBe("first second third fourth fifth ");
    expect(parsed).not.toContain("\r");
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

  it("returns false for non-string video URL input", () => {
    const { service } = createServiceWithYtDlp([]);
    expect(service.isVideoUrl(null as unknown as string)).toBe(false);
    expect(service.isVideoUrl({} as unknown as string)).toBe(false);
  });

  it("forwards VideoDownloadOptions (format precedence, subtitles, embedSubs, writeInfoJson) to yt-dlp", async () => {
    const { service, runYtDlp } = createServiceWithYtDlp([{}]);
    const outputPath = path.join(
      tmpdir(),
      `eliza-video-options-${randomUUID()}.mp4`,
    );

    await service.downloadVideo("https://youtu.be/options-test", {
      outputPath,
      format: "bestvideo",
      quality: "720p",
      subtitles: true,
      embedSubs: true,
      writeInfoJson: false,
    });

    expect(runYtDlp).toHaveBeenCalledWith("https://youtu.be/options-test", {
      verbose: true,
      output: outputPath,
      writeInfoJson: false,
      format: "bestvideo",
      writeSub: true,
      embedSubs: true,
    });
  });
});

it("runs reloaded media tasks and retains scoped failure status in the real task store", async () => {
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "MediaTaskContract",
  });
  try {
    const entityId = randomUUID() as UUID,
      roomId = randomUUID() as UUID,
      worldId = randomUUID() as UUID;
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      worldName: "Contract world",
      userName: "Fixture requester",
      name: "Fixture requester",
      source: "test",
      type: ChannelType.DM,
    });
    registerMediaJobWorker(runtime);
    const taskId = await runtime.createTask({
      name: "PROCESS_PUBLIC_MEDIA",
      agentId: runtime.agentId,
      roomId,
      worldId,
      entityId,
      tags: ["queue", "media"],
      dueAt: Date.now(),
      metadata: {
        status: TaskStatus.PENDING,
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        kind: "youtube",
      },
    });
    const task = await runtime.getTask(taskId);
    const worker = runtime.getTaskWorker("PROCESS_PUBLIC_MEDIA");
    expect(task).toBeTruthy();
    expect(worker).toBeTruthy();
    if (!task || !worker)
      throw new Error("Native task fixture did not initialize");
    expect(await worker.shouldRun?.(runtime, task)).toBe(true);
    expect(await worker.execute(runtime, {}, task)).toMatchObject({
      preserveTask: true,
    });
    const failed = await runtime.getTask(taskId);
    expect(failed?.metadata).toMatchObject({
      status: TaskStatus.FAILED,
      paused: true,
      error: "MEDIA_TASK_SERVICES_UNAVAILABLE",
    });
    if (!failed) throw new Error("Failed task was deleted");
    expect(await worker.shouldRun?.(runtime, failed)).toBe(false);
    const message = {
      id: randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId,
      roomId,
      worldId,
      content: { text: "status" },
    };
    const result = await mediaStatusAction.handler(
      runtime,
      message,
      undefined,
      { parameters: { taskId } },
    );
    expect(result).toMatchObject({
      success: true,
      data: { status: TaskStatus.FAILED },
    });
    for (const foreign of [
      { ...message, entityId: randomUUID() as UUID },
      { ...message, roomId: randomUUID() as UUID },
    ]) {
      await expect(
        mediaStatusAction.handler(runtime, foreign, undefined, {
          parameters: { taskId },
        }),
      ).rejects.toMatchObject({ code: "MEDIA_TASK_NOT_FOUND" });
    }
  } finally {
    await cleanup();
  }
}, 120_000);
