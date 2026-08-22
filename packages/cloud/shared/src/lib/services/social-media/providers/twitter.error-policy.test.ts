/**
 * Error-policy pin for the Twitter provider (#13415). Drives the real exported
 * `twitterProvider` methods and proves the fail-closed split:
 *   - the analytics readers (`getPostAnalytics`/`getAccountAnalytics`) PROPAGATE an
 *     internal upstream failure (throw) instead of swallowing it into a fabricated
 *     `null`; `null` stays reserved for the designed no-credentials guard the service
 *     layer treats as "provider not available";
 *   - `createPost`, `validateCredentials`, and `deletePost` still translate an upstream
 *     failure into their structured `{success:false}` / `{valid:false}` DTO (J1 boundary)
 *     that the connect + credit-refund flows depend on — a returned failure, not a throw
 *     and not a fabricated success.
 *
 * The rate-limit/transport seam (`../rate-limit`) is replaced with a no-backoff
 * pass-through that mirrors the real `!response.ok` throw, so the REAL provider mapping
 * and JSON parser run without the exponential-backoff sleeps; `globalThis.fetch` supplies
 * the raw upstream Response.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { SocialCredentials } from "../../../types/social-media";
import * as realRateLimit from "../rate-limit";

// bun's `mock.module` patches the process-global module registry (afterEach
// here only restores fetch). Under the batched cloud-unit runner (`--isolate`
// occasionally fails to contain these on a memory-pressured runner) this
// twitter-specific `../rate-limit` double otherwise bleeds into the shared
// rate-limit / token-refresh suites, whose `withRetry` then throws
// "twitter API error". Snapshot the real exports now and reinstall them in
// afterAll so this file's stub is strictly local.
const realRateLimitExports = { ...realRateLimit };

// Pass-through withRetry: run fetch once, mirror the real non-ok throw, run the parser.
// No backoff sleeps, no retry loop — the point under test is that the provider does NOT
// catch what this throws.
mock.module("../rate-limit", () => ({
  withRetry: async <T>(
    fn: () => Promise<Response>,
    parser: (r: Response) => Promise<T>,
  ): Promise<{ data: T }> => {
    const response = await fn();
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`twitter API error ${response.status}: ${body}`);
    }
    return { data: await parser(response) };
  },
}));

const { twitterProvider, twitterFetch, waitForProcessing } = await import("./twitter");

const CREDS = { accessToken: "tok" } as SocialCredentials;

const originalFetch = globalThis.fetch;
let fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>;

function okJson(body: unknown): Response {
  return Response.json(body);
}

function upstreamFailure(status: number, body: string): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  globalThis.fetch = mock((url: string, init?: RequestInit) =>
    fetchImpl(url, init),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../rate-limit", () => realRateLimitExports);
});

describe("twitterProvider.getPostAnalytics — internal failure propagates, guard stays null", () => {
  it("PROPAGATES an upstream failure instead of returning a fabricated null", async () => {
    fetchImpl = async () => upstreamFailure(500, "twitter upstream boom");

    const call = twitterProvider.getPostAnalytics?.(CREDS, "post-1");
    expect(call).toBeDefined();
    await expect(call).rejects.toThrow(/twitter API error 500/);
  });

  it("returns null ONLY for the designed no-credentials guard (never for a failure)", async () => {
    let fetched = false;
    fetchImpl = async () => {
      fetched = true;
      return okJson({});
    };

    const result = await twitterProvider.getPostAnalytics?.({} as SocialCredentials, "post-1");
    expect(result).toBeNull();
    expect(fetched).toBe(false);
  });

  it("maps real metrics on success", async () => {
    fetchImpl = async () =>
      okJson({
        data: {
          public_metrics: {
            like_count: 5,
            retweet_count: 3,
            reply_count: 2,
            quote_count: 1,
            impression_count: 99,
          },
        },
      });

    const result = await twitterProvider.getPostAnalytics?.(CREDS, "post-1");
    expect(result?.metrics.likes).toBe(5);
    expect(result?.metrics.reposts).toBe(3);
    expect(result?.metrics.impressions).toBe(99);
  });
});

describe("twitterProvider.getAccountAnalytics — internal failure propagates", () => {
  it("PROPAGATES an upstream failure instead of returning a fabricated null", async () => {
    fetchImpl = async () => upstreamFailure(429, "twitter account rate limit");

    const call = twitterProvider.getAccountAnalytics?.(CREDS);
    expect(call).toBeDefined();
    await expect(call).rejects.toThrow(/twitter API error 429/);
  });

  it("returns null ONLY for the designed no-credentials guard", async () => {
    let fetched = false;
    fetchImpl = async () => {
      fetched = true;
      return okJson({});
    };

    const result = await twitterProvider.getAccountAnalytics?.({} as SocialCredentials);
    expect(result).toBeNull();
    expect(fetched).toBe(false);
  });

  it("maps real account metrics on success", async () => {
    fetchImpl = async () =>
      okJson({
        data: {
          id: "acct-1",
          public_metrics: {
            followers_count: 1000,
            following_count: 10,
            tweet_count: 42,
          },
        },
      });

    const result = await twitterProvider.getAccountAnalytics?.(CREDS);
    expect(result?.accountId).toBe("acct-1");
    expect(result?.metrics.followers).toBe(1000);
    expect(result?.metrics.totalPosts).toBe(42);
  });
});

describe("twitterProvider J1 boundaries — upstream failure becomes a structured failure DTO", () => {
  it("createPost returns {success:false} (the refund flow depends on this, not a throw)", async () => {
    fetchImpl = async () => upstreamFailure(403, "post rejected");

    const result = await twitterProvider.createPost(CREDS, { text: "hello" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("post rejected");
  });

  it("validateCredentials returns {valid:false} on an upstream auth failure", async () => {
    fetchImpl = async () => upstreamFailure(401, "bad token");

    const result = await twitterProvider.validateCredentials(CREDS);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("bad token");
  });

  it("deletePost returns {success:false} on an upstream failure", async () => {
    fetchImpl = async () => upstreamFailure(404, "not found");

    const result = await twitterProvider.deletePost?.(CREDS, "post-1");
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("not found");
  });
});

describe("twitterFetch — bounded hops fail closed and keep caller signals", () => {
  it("aborts a hung X/Twitter API hop at the timeout", async () => {
    // An API that never settles on its own: the only way out is the caller's
    // AbortSignal firing (the 30s default bounds every media-upload hop).
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;

    const start = Date.now();
    await expect(
      twitterFetch("https://upload.twitter.com/media/upload.json", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("composes caller cancellation with the hop deadline", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(seen?.reason), { once: true });
        }),
    ) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = twitterFetch("https://upload.twitter.com/media/upload.json", {
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(seen).not.toBe(controller.signal);
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow(/caller cancelled/);
    expect(seen?.aborted).toBe(true);
  });

  it("keeps the deadline when a supplied caller signal never aborts", async () => {
    const controller = new AbortController();
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;

    await expect(
      twitterFetch(
        "https://upload.twitter.com/media/upload.json",
        { signal: controller.signal },
        100,
      ),
    ).rejects.toThrow(/timed out/i);
    expect(controller.signal.aborted).toBe(false);
  });

  it("does not dispatch a request when the caller is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before dispatch");
    controller.abort(reason);
    let fetched = false;
    globalThis.fetch = mock(async () => {
      fetched = true;
      return new Response();
    }) as unknown as typeof fetch;

    await expect(
      twitterFetch("https://upload.twitter.com/media/upload.json", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(fetched).toBe(false);
  });

  it("bounds a response body stall under the same hop deadline and cancels the stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = mock(async () => new Response(body)) as unknown as typeof fetch;

    await expect(
      twitterFetch("https://upload.twitter.com/media/upload.json", undefined, 50),
    ).rejects.toThrow(/timed out/i);
    expect(cancelled).toBe(true);
  });

  it("rejects a declared oversized body before reading and cancels it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = mock(
      async () =>
        new Response(body, {
          headers: { "content-length": String(4 * 1024 * 1024 + 1) },
        }),
    ) as unknown as typeof fetch;

    await expect(
      twitterFetch("https://upload.twitter.com/media/upload.json", undefined, 1_000),
    ).rejects.toMatchObject({ code: "TWITTER_RESPONSE_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  it("rejects an incrementally oversized body when content-length is absent", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = mock(async () => new Response(body)) as unknown as typeof fetch;

    await expect(
      twitterFetch("https://upload.twitter.com/media/upload.json", undefined, 1_000),
    ).rejects.toMatchObject({ code: "TWITTER_RESPONSE_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  it("clears its timer and caller listener after success", async () => {
    const controller = new AbortController();
    const removeListener = spyOn(controller.signal, "removeEventListener");
    const clearTimer = spyOn(globalThis, "clearTimeout");
    globalThis.fetch = mock(async () => new Response("ok")) as unknown as typeof fetch;
    try {
      const response = await twitterFetch(
        "https://upload.twitter.com/media/upload.json",
        { signal: controller.signal },
        1_000,
      );
      expect(await response.text()).toBe("ok");
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(clearTimer).toHaveBeenCalled();
    } finally {
      removeListener.mockRestore();
      clearTimer.mockRestore();
    }
  });

  it("rejects invalid timeout values before dispatch", async () => {
    let fetched = false;
    globalThis.fetch = mock(async () => {
      fetched = true;
      return new Response();
    }) as unknown as typeof fetch;

    for (const timeout of [0, -1, Number.NaN, 2_147_483_648]) {
      await expect(
        twitterFetch("https://upload.twitter.com/media/upload.json", undefined, timeout),
      ).rejects.toMatchObject({ code: "INVALID_TWITTER_TIMEOUT" });
    }
    expect(fetched).toBe(false);
  });

  it("rejects over-budget post media before the first upload mutation", async () => {
    let fetched = false;
    fetchImpl = async () => {
      fetched = true;
      return okJson({});
    };
    const media = Array.from({ length: 5 }, () => ({
      type: "image" as const,
      mimeType: "image/png",
      data: Buffer.from([1]),
    }));

    const result = await twitterProvider.createPost(CREDS, { text: "hello", media });
    expect(result.success).toBe(false);
    expect(result.error).toContain("at most 4 media items");
    expect(fetched).toBe(false);
  });

  it("clears upload and request deadlines after a successful media post", async () => {
    const clearTimer = spyOn(globalThis, "clearTimeout");
    fetchImpl = async (url) => {
      if (url.includes("media/upload.json")) {
        return okJson({ media_id_string: "media-1" });
      }
      return okJson({ data: { id: "post-1", text: "hello" } });
    };
    try {
      const result = await twitterProvider.createPost(CREDS, {
        text: "hello",
        media: [{ type: "image", mimeType: "image/png", data: Buffer.from([1]) }],
      });
      expect(result).toMatchObject({ success: true, postId: "post-1" });
      expect(clearTimer.mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      clearTimer.mockRestore();
    }
  });

  it("rejects every present non-record FINALIZE processing_info before posting", async () => {
    for (const malformed of [null, false, 0, ""] as const) {
      let posted = false;
      fetchImpl = async (url) => {
        if (url.includes("command=INIT")) return okJson({ media_id_string: "media-1" });
        if (url.includes("command=APPEND")) return okJson({});
        if (url.includes("command=FINALIZE")) {
          return okJson({ processing_info: malformed });
        }
        if (url.endsWith("/tweets")) posted = true;
        return okJson({ data: { id: "post-1", text: "hello" } });
      };

      const result = await twitterProvider.createPost(CREDS, {
        text: "hello",
        media: [{ type: "video", mimeType: "video/mp4", data: Buffer.from([1]) }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("malformed processing_info");
      expect(posted).toBe(false);
    }
  });
});

describe("waitForProcessing — one wall-clock budget bounds provider polling", () => {
  it("keeps a non-2xx STATUS response distinct", async () => {
    globalThis.fetch = mock(
      async () => new Response("busy", { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(waitForProcessing("tok", "media-1", 1_000)).rejects.toThrow(
      "Media processing STATUS failed: 503",
    );
  });

  it("rejects malformed and unknown processing states", async () => {
    const payloads = [
      { processing_info: [] },
      { processing_info: null },
      { processing_info: false },
      { processing_info: 0 },
      { processing_info: "" },
      { processing_info: { state: "mystery" } },
      { processing_info: { state: "pending", check_after_secs: "soon" } },
    ];
    for (const payload of payloads) {
      globalThis.fetch = mock(async () => Response.json(payload)) as unknown as typeof fetch;
      await expect(waitForProcessing("tok", "media-1", 1_000)).rejects.toThrow(
        /malformed|invalid state|invalid check_after_secs/,
      );
    }
  });

  it("clamps an oversized provider poll delay to the operation deadline", async () => {
    let statusCalls = 0;
    globalThis.fetch = mock(async () => {
      statusCalls += 1;
      return Response.json({
        processing_info: { state: "pending", check_after_secs: 999_999_999 },
      });
    }) as unknown as typeof fetch;

    const start = Date.now();
    await expect(waitForProcessing("tok", "media-1", 50)).rejects.toThrow(/timed out/i);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(statusCalls).toBe(1);
  });

  it("clears the processing deadline timer on terminal success", async () => {
    const clearTimer = spyOn(globalThis, "clearTimeout");
    globalThis.fetch = mock(async () =>
      Response.json({ processing_info: { state: "succeeded" } }),
    ) as unknown as typeof fetch;
    try {
      await waitForProcessing("tok", "media-1", 1_000);
      expect(clearTimer.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      clearTimer.mockRestore();
    }
  });
});
