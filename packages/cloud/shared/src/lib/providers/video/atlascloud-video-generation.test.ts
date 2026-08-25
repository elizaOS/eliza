/**
 * Exercises Atlas Cloud video submission and reconciliation with deterministic
 * fetch fixtures, plus real loopback HTTP servers for the redirect-containment
 * tests so the true fetch redirect behavior is under test rather than a mock.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  atlasCloudVideoProvider,
  atlasFetch,
  buildAtlasVideoInput,
  firstAtlasVideoOutput,
  generateAtlasCloudVideo,
  getAtlasCloudVideoJobStatus,
} from "./atlascloud-video-generation";
import {
  VideoGenerationPendingError,
  VideoGenerationSubmissionUnknownError,
  VideoGenerationTerminalError,
} from "./types";

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

  test("classifies a definitive submit rejection as terminal", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "invalid input" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await expect(
      generateAtlasCloudVideo({
        model: "vidu/q3-turbo/text-to-video",
        prompt: "a lighthouse",
        apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
      }),
    ).rejects.toBeInstanceOf(VideoGenerationTerminalError);
  });

  test("classifies submit transport failure as unknown, not terminal", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection reset after upload");
    }) as typeof fetch;

    await expect(
      generateAtlasCloudVideo({
        model: "vidu/q3-turbo/text-to-video",
        prompt: "a lighthouse",
        apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
      }),
    ).rejects.toBeInstanceOf(VideoGenerationSubmissionUnknownError);
  });

  test("classifies an invalid successful submit response as unknown", async () => {
    globalThis.fetch = (async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await expect(
      generateAtlasCloudVideo({
        model: "vidu/q3-turbo/text-to-video",
        prompt: "a lighthouse",
        apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
      }),
    ).rejects.toBeInstanceOf(VideoGenerationSubmissionUnknownError);
  });

  test("classifies a submit server error as terminal: no prediction was created", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "gateway timeout" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const error = await generateAtlasCloudVideo({
      model: "vidu/q3-turbo/text-to-video",
      prompt: "a lighthouse",
      apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(VideoGenerationTerminalError);
    expect(error.message).toBe("gateway timeout");
    expect(
      (error as InstanceType<typeof VideoGenerationTerminalError>).providerCause,
    ).toMatchObject({ status: 503 });
  });

  test("retains the Atlas prediction id when polling is unreachable", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return new Response(
          JSON.stringify({
            data: { id: "atlas-prediction", status: "starting" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error("prediction status unavailable");
    }) as typeof fetch;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    try {
      const error = await generateAtlasCloudVideo({
        model: "vidu/q3-turbo/text-to-video",
        prompt: "a lighthouse",
        apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
      }).catch((caught) => caught);
      expect(error).toBeInstanceOf(VideoGenerationPendingError);
      expect((error as InstanceType<typeof VideoGenerationPendingError>).requestId).toBe(
        "atlas-prediction",
      );
    } finally {
      timer.mockRestore();
    }
  });

  test("never sends the Atlas bearer credential to an off-origin poll URL", async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        authorization: headers.get("authorization") ?? undefined,
      });
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            data: {
              id: "atlas-prediction",
              status: "starting",
              urls: { get: "https://attacker.invalid/collect" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
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
    const timer = spyOn(globalThis, "setTimeout").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    try {
      await expect(
        generateAtlasCloudVideo({
          model: "vidu/q3-turbo/text-to-video",
          prompt: "a lighthouse",
          apiKeys: {
            ATLASCLOUD_API_KEY: "atlas-key",
            ATLASCLOUD_BASE_URL: "https://atlas.test",
          },
        }),
      ).resolves.toMatchObject({ requestId: "atlas-prediction" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://atlas.test/api/v1/model/generateVideo",
        "https://atlas.test/api/v1/model/prediction/atlas-prediction",
      ]);
      expect(calls.every((call) => call.authorization === "Bearer atlas-key")).toBe(true);
      expect(calls.some((call) => call.url.includes("attacker.invalid"))).toBe(false);
    } finally {
      timer.mockRestore();
    }
  });

  test("refuses to follow a poll redirect that would re-send the bearer credential", async () => {
    const attackerRequests: Array<{ url: string; authorization: string | null }> = [];
    const attacker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        attackerRequests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
        });
        return Response.json({
          data: {
            id: "atlas-prediction",
            status: "completed",
            outputs: ["https://cdn.atlas/video.mp4"],
          },
        });
      },
    });
    let pollRequests = 0;
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/model/generateVideo") {
          return Response.json({ data: { id: "atlas-prediction", status: "starting" } });
        }
        pollRequests++;
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${attacker.port}${url.pathname}` },
        });
      },
    });
    const timer = spyOn(globalThis, "setTimeout").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    try {
      const error = await generateAtlasCloudVideo({
        model: "vidu/q3-turbo/text-to-video",
        prompt: "a lighthouse",
        apiKeys: {
          ATLASCLOUD_API_KEY: "atlas-key",
          ATLASCLOUD_BASE_URL: `http://127.0.0.1:${origin.port}`,
        },
      }).catch((caught) => caught);
      expect(error).toBeInstanceOf(VideoGenerationPendingError);
      expect((error as InstanceType<typeof VideoGenerationPendingError>).requestId).toBe(
        "atlas-prediction",
      );
      expect(pollRequests).toBe(1);
      expect(attackerRequests).toEqual([]);
    } finally {
      timer.mockRestore();
      origin.stop(true);
      attacker.stop(true);
    }
  });

  test("keeps the status-probe credential on the configured origin when redirected", async () => {
    const attackerRequests: Array<{ url: string; authorization: string | null }> = [];
    const attacker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        attackerRequests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
        });
        return Response.json({
          data: {
            id: "atlas-prediction",
            status: "succeeded",
            outputs: ["https://cdn.atlas/video.mp4"],
          },
        });
      },
    });
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${attacker.port}${url.pathname}` },
        });
      },
    });

    try {
      await expect(
        getAtlasCloudVideoJobStatus({
          model: "vidu/q3-turbo/text-to-video",
          requestId: "atlas-prediction",
          apiKeys: {
            ATLASCLOUD_API_KEY: "atlas-key",
            ATLASCLOUD_BASE_URL: `http://127.0.0.1:${origin.port}`,
          },
        }),
      ).rejects.toThrow("Atlas prediction status failed: 302");
      expect(attackerRequests).toEqual([]);
    } finally {
      origin.stop(true);
      attacker.stop(true);
    }
  });

  test("returns a pending error with the prediction id on poll timeout", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: { id: "atlas-prediction", status: "starting" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const clock = spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(180_001);

    try {
      const error = await generateAtlasCloudVideo({
        model: "vidu/q3-turbo/text-to-video",
        prompt: "a lighthouse",
        apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
      }).catch((caught) => caught);
      expect(error).toBeInstanceOf(VideoGenerationPendingError);
      expect((error as InstanceType<typeof VideoGenerationPendingError>).requestId).toBe(
        "atlas-prediction",
      );
    } finally {
      clock.mockRestore();
    }
  });

  test("keeps a known prediction pending when its poll payload is invalid", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return fetchCalls === 1
        ? new Response(
            JSON.stringify({
              data: { id: "atlas-prediction", status: "starting" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    }) as typeof fetch;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    try {
      const error = await generateAtlasCloudVideo({
        model: "vidu/q3-turbo/text-to-video",
        prompt: "a lighthouse",
        apiKeys: { ATLASCLOUD_API_KEY: "atlas-key" },
      }).catch((caught) => caught);
      expect(error).toBeInstanceOf(VideoGenerationPendingError);
      expect((error as InstanceType<typeof VideoGenerationPendingError>).requestId).toBe(
        "atlas-prediction",
      );
    } finally {
      timer.mockRestore();
    }
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

describe("atlasFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung Atlas Cloud API hop at the timeout", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;

    const start = Date.now();
    await expect(
      atlasFetch("https://api.atlascloud.ai/api/v1/model/generateVideo", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("composes a caller-provided abort signal with the hop deadline", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const controller = new AbortController();
    await atlasFetch("https://api.atlascloud.ai/api/v1/model/generateVideo", {
      signal: controller.signal,
    });
    // The wrapper owns the deadline, so the signal handed to the transport is
    // a composition of the caller's signal and that deadline — never the caller's
    // object verbatim. Asserting identity here would pin the very behavior that
    // lets a never-firing caller signal defeat the bound.
    expect(seen).not.toBe(controller.signal);
  });
});
