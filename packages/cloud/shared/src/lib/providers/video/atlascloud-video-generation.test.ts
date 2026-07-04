// Exercises atlascloud video generation behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import {
  atlasCloudVideoProvider,
  buildAtlasVideoInput,
  firstAtlasVideoOutput,
  generateAtlasCloudVideo,
  getAtlasCloudVideoJobStatus,
} from "./atlascloud-video-generation";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Atlas Cloud video provider", () => {
  test("maps Cloud video request fields to Atlas input aliases", () => {
    expect(
      buildAtlasVideoInput({
        model: "vidu/image-to-video-2.0",
        prompt: "animate the product photo",
        referenceUrl: "https://example.com/source.png",
        durationSeconds: 4,
        resolution: "720p",
        audio: false,
        apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
      }),
    ).toEqual({
      model: "vidu/image-to-video-2.0",
      prompt: "animate the product photo",
      image_url: "https://example.com/source.png",
      image: "https://example.com/source.png",
      duration: 4,
      resolution: "720p",
      generate_audio: false,
    });
  });

  test("normalizes string and object Atlas outputs", () => {
    expect(firstAtlasVideoOutput(["https://cdn.atlas/video.mp4"])).toEqual({
      url: "https://cdn.atlas/video.mp4",
      content_type: "video/mp4",
    });
    expect(
      firstAtlasVideoOutput([
        {
          url: "https://cdn.atlas/video.webm",
          width: 1280,
          height: 720,
          filename: "video.webm",
          size: 1234,
          mime_type: "video/webm",
        },
      ]),
    ).toEqual({
      url: "https://cdn.atlas/video.webm",
      width: 1280,
      height: 720,
      file_name: "video.webm",
      file_size: 1234,
      content_type: "video/webm",
    });
  });

  test("generates through the registered Atlas provider with inline output", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          data: {
            id: "atlas-prediction",
            status: "completed",
            outputs: ["https://cdn.atlas/video.mp4"],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await generateAtlasCloudVideo({
      model: "vidu/q3-turbo/text-to-video",
      prompt: "a lighthouse",
      durationSeconds: 5,
      apiKeys: {
        ATLASCLOUD_API_KEY: "atlas-key",
        ATLASCLOUD_BASE_URL: "https://atlas.test/",
      },
    });

    expect(atlasCloudVideoProvider.billingSource).toBe("atlascloud");
    expect(atlasCloudVideoProvider.isConfigured?.({ ATLASCLOUD_API_KEY: " atlas-key " })).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://atlas.test/api/v1/model/generateVideo");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer atlas-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "vidu/q3-turbo/text-to-video",
      prompt: "a lighthouse",
      duration: 5,
      generate_audio: false,
    });
    expect(result).toEqual({
      requestId: "atlas-prediction",
      video: { url: "https://cdn.atlas/video.mp4", content_type: "video/mp4" },
      timings: null,
    });
  });

  test("rejects missing Atlas credentials before calling upstream", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;

    await expect(
      generateAtlasCloudVideo({
        model: "vidu/q3-turbo/text-to-video",
        prompt: "a lighthouse",
        apiKeys: {},
      }),
    ).rejects.toThrow("AI services are not configured on this deployment");
    expect(atlasCloudVideoProvider.isConfigured?.({})).toBe(false);
    expect(called).toBe(false);
  });

  test("reports Atlas job status success with normalized output", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          data: {
            id: "atlas-prediction",
            status: "succeeded",
            outputs: [{ url: "https://cdn.atlas/video.mp4", width: 640, height: 360 }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      getAtlasCloudVideoJobStatus({
        model: "vidu/q3-turbo/text-to-video",
        requestId: "atlas-prediction",
        apiKeys: {
          ATLASCLOUD_API_KEY: "atlas-key",
          ATLASCLOUD_BASE_URL: "https://atlas.test/",
        },
      }),
    ).resolves.toEqual({
      state: "succeeded",
      result: {
        requestId: "atlas-prediction",
        video: {
          url: "https://cdn.atlas/video.mp4",
          width: 640,
          height: 360,
          content_type: "video/mp4",
        },
        timings: null,
      },
    });
    expect(calls).toEqual(["https://atlas.test/api/v1/model/prediction/atlas-prediction"]);
  });

  test("reports Atlas in-flight jobs as pending", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { id: "atlas-prediction", status: "processing" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await expect(
      getAtlasCloudVideoJobStatus({
        model: "vidu/q3-turbo/text-to-video",
        requestId: "atlas-prediction",
        apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
      }),
    ).resolves.toEqual({ state: "pending" });
  });

  test("reports terminal Atlas failures without throwing", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            id: "atlas-prediction",
            status: "failed",
            error: "content policy",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(
      getAtlasCloudVideoJobStatus({
        model: "vidu/q3-turbo/text-to-video",
        requestId: "atlas-prediction",
        apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
      }),
    ).resolves.toEqual({ state: "failed", error: "content policy" });
  });

  test("treats unknown Atlas request ids as terminal failures", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await expect(
      getAtlasCloudVideoJobStatus({
        model: "vidu/q3-turbo/text-to-video",
        requestId: "missing",
        apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
      }),
    ).resolves.toEqual({
      state: "failed",
      error: "Atlas Cloud does not know request missing",
    });
  });
});
