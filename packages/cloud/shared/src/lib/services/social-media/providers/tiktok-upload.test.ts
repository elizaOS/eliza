/**
 * Exercises TikTok file upload planning and transport through the real
 * exported provider with only the external HTTP boundary mocked. The suite
 * pins decimal-MB ranges, sequential response statuses, and zero-copy views.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import * as realSafeFetch from "../../../security/safe-fetch";
import type { SocialCredentials } from "../../../types/social-media";
import * as realRateLimit from "../rate-limit";

const realSafeFetchExports = { ...realSafeFetch };
const realRateLimitExports = { ...realRateLimit };
let safeFetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

mock.module("../../../security/safe-fetch", () => ({
  ...realSafeFetchExports,
  safeFetch: (input: string, init?: RequestInit) => safeFetchImpl(input, init),
}));

mock.module("../rate-limit", () => ({
  withRetry: async <T>(
    fn: () => Promise<Response>,
    parser: (response: Response) => Promise<T>,
  ): Promise<{ data: T }> => ({ data: await parser(await fn()) }),
}));

const {
  createTikTokUploadPlan,
  tiktokProvider,
  validateTikTokUploadUrl,
  validateTikTokVideoMimeType,
} = await import("./tiktok");

const credentials = { accessToken: "test-token" } as SocialCredentials;
const originalFetch = globalThis.fetch;
let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: { code: "ok", message: "" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  safeFetchImpl = (input, init) => fetchImpl(input, init);
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) =>
    fetchImpl(input, init),
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../../../security/safe-fetch", () => realSafeFetchExports);
  mock.module("../rate-limit", () => realRateLimitExports);
});

function cancellableResponse(status: number, cancellations: number[]): Response {
  return new Response(
    new ReadableStream({
      cancel() {
        cancellations.push(status);
      },
    }),
    { status },
  );
}

describe("TikTok upload input validation", () => {
  test("accepts only documented HTTPS upload hosts without dropping signed queries", () => {
    expect(
      validateTikTokUploadUrl("https://open-upload.tiktokapis.com/video?upload_id=signed"),
    ).toBe("https://open-upload.tiktokapis.com/video?upload_id=signed");
    expect(validateTikTokUploadUrl("https://upload.us.tiktokapis.com/video?upload_id=signed")).toBe(
      "https://upload.us.tiktokapis.com/video?upload_id=signed",
    );

    for (const url of [
      "http://open-upload.tiktokapis.com/video",
      "https://upload..tiktokapis.com/video",
      "https://upload.us.extra.tiktokapis.com/video",
      "https://example.com/video",
      "https://user:secret@open-upload.tiktokapis.com/video",
      "not a url",
    ]) {
      expect(() => validateTikTokUploadUrl(url)).toThrow();
    }
  });

  test("normalizes the supported containers and rejects unsupported MIME types", () => {
    expect(validateTikTokVideoMimeType("video/mp4; codecs=avc1")).toBe("video/mp4");
    expect(validateTikTokVideoMimeType("VIDEO/QUICKTIME")).toBe("video/quicktime");
    expect(validateTikTokVideoMimeType("video/webm")).toBe("video/webm");
    for (const mimeType of ["video/avi", "image/png", ""]) {
      expect(() => validateTikTokVideoMimeType(mimeType)).toThrow();
    }
  });
});

describe("createTikTokUploadPlan", () => {
  test("uses one exact-size chunk for videos below TikTok's 5 MB minimum", () => {
    expect(createTikTokUploadPlan(4_999_999)).toEqual({
      chunkSize: 4_999_999,
      totalChunkCount: 1,
      chunks: [{ firstByte: 0, lastByte: 4_999_998, byteLength: 4_999_999 }],
    });
  });

  test("uses floor-counted decimal chunks and merges the remainder into the final range", () => {
    const plan = createTikTokUploadPlan(50_000_123);

    expect(plan.chunkSize).toBe(10_000_000);
    expect(plan.totalChunkCount).toBe(5);
    expect(plan.chunks).toEqual([
      { firstByte: 0, lastByte: 9_999_999, byteLength: 10_000_000 },
      { firstByte: 10_000_000, lastByte: 19_999_999, byteLength: 10_000_000 },
      { firstByte: 20_000_000, lastByte: 29_999_999, byteLength: 10_000_000 },
      { firstByte: 30_000_000, lastByte: 39_999_999, byteLength: 10_000_000 },
      { firstByte: 40_000_000, lastByte: 50_000_122, byteLength: 10_000_123 },
    ]);
  });

  test("plans multiple legal ranges above TikTok's 64 MB mandatory-chunk threshold", () => {
    const plan = createTikTokUploadPlan(64_000_001);

    expect(plan.totalChunkCount).toBe(6);
    expect(plan.chunks.at(-1)).toEqual({
      firstByte: 50_000_000,
      lastByte: 64_000_000,
      byteLength: 14_000_001,
    });
    expect(plan.chunks.every((chunk) => chunk.byteLength >= 5_000_000)).toBe(true);
    expect(plan.chunks.every((chunk) => chunk.byteLength <= 64_000_000)).toBe(true);
  });

  test("rejects empty and non-integral sizes with a contextual domain error", () => {
    for (const videoSize of [0, 1.5]) {
      let caught: unknown;
      try {
        createTikTokUploadPlan(videoSize);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ElizaError);
      expect((caught as ElizaError).code).toBe("TIKTOK_INVALID_VIDEO_SIZE");
      expect((caught as ElizaError).context).toMatchObject({ videoSize });
    }
  });
});

describe("tiktokProvider file upload", () => {
  test("preserves QuickTime and WebM content types and rejects unsupported video before init", async () => {
    for (const mimeType of ["video/quicktime", "video/webm"]) {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      fetchImpl = async (input, init) => {
        const callIndex = calls.push({ url: String(input), init }) - 1;
        if (callIndex === 0) {
          return jsonResponse({
            publish_id: `publish-${mimeType}`,
            upload_url: "https://upload.us.tiktokapis.com/video?upload_id=mime",
          });
        }
        if (callIndex === 1) return new Response(null, { status: 201 });
        return jsonResponse({ status: "PUBLISH_COMPLETE" });
      };

      const result = await tiktokProvider.createPost(credentials, {
        text: "hello",
        media: [{ type: "video", data: Buffer.from("video"), mimeType }],
      });

      expect(result.success).toBe(true);
      expect(new Headers(calls[1]?.init?.headers).get("content-type")).toBe(mimeType);
    }

    let fetchCount = 0;
    fetchImpl = async () => {
      fetchCount += 1;
      throw new Error("transport must not run");
    };
    const rejected = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.from("video"), mimeType: "video/avi" }],
    });
    expect(rejected).toMatchObject({ success: false, errorCode: "TIKTOK_VIDEO_MIME_INVALID" });
    expect(fetchCount).toBe(0);
  });

  test("rejects untrusted and private-resolving upload URLs before any outbound PUT", async () => {
    for (const uploadUrl of [
      "http://open-upload.tiktokapis.com/video",
      "https://example.com/video",
      "https://user:secret@open-upload.tiktokapis.com/video",
    ]) {
      let uploadFetchCount = 0;
      fetchImpl = async () =>
        jsonResponse({ publish_id: "publish-untrusted", upload_url: uploadUrl });
      safeFetchImpl = async () => {
        uploadFetchCount += 1;
        throw new Error("upload transport must not run");
      };

      const result = await tiktokProvider.createPost(credentials, {
        text: "hello",
        media: [{ type: "video", data: Buffer.from("video"), mimeType: "video/mp4" }],
      });
      expect(result).toMatchObject({ success: false, errorCode: "TIKTOK_UPLOAD_URL_INVALID" });
      expect(uploadFetchCount).toBe(0);
    }

    let guardCallCount = 0;
    let apiCallCount = 0;
    fetchImpl = async () => {
      apiCallCount += 1;
      if (apiCallCount === 1) {
        return jsonResponse({
          publish_id: "publish-private",
          upload_url: "https://upload.private.tiktokapis.com/video",
        });
      }
      return jsonResponse({ status: "FAILED", fail_reason: "upload not received" });
    };
    safeFetchImpl = async () => {
      guardCallCount += 1;
      // Mirrors safeFetch rejecting the allowed-form hostname during DNS
      // screening, before its pinned transport opens a socket.
      throw new Error("Endpoint resolves to a private or reserved IP address");
    };
    const privateResult = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.from("video"), mimeType: "video/mp4" }],
    });
    expect(privateResult.success).toBe(false);
    expect(guardCallCount).toBe(1);
    expect(apiCallCount).toBe(2);
  });

  test("rejects and disposes redirects without sending bytes to their target", async () => {
    let apiCallCount = 0;
    let uploadCallCount = 0;
    const cancellations: number[] = [];
    fetchImpl = async () => {
      apiCallCount += 1;
      return jsonResponse({
        publish_id: "publish-redirect",
        upload_url: "https://open-upload.tiktokapis.com/video?upload_id=redirect",
      });
    };
    safeFetchImpl = async (_input, init) => {
      uploadCallCount += 1;
      expect(init?.redirect).toBe("manual");
      return new Response(
        new ReadableStream({
          cancel() {
            cancellations.push(307);
          },
        }),
        { status: 307, headers: { location: "https://attacker.example/steal" } },
      );
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.from("video"), mimeType: "video/mp4" }],
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: "TIKTOK_UPLOAD_CHUNK_STATUS_INVALID",
    });
    expect(apiCallCount).toBe(1);
    expect(uploadCallCount).toBe(1);
    expect(cancellations).toEqual([307]);
  });

  test("sends sequential zero-copy ranges and requires 206 then 201", async () => {
    const videoData = Buffer.alloc(20_000_001, 0x41);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const cancellations: number[] = [];

    fetchImpl = async (input, init) => {
      const callIndex = calls.push({ url: String(input), init }) - 1;
      if (callIndex === 0) {
        return jsonResponse({
          publish_id: "publish-1",
          upload_url: "https://open-upload.tiktokapis.com/video?upload_id=publish-1",
        });
      }
      if (callIndex === 1) return cancellableResponse(206, cancellations);
      if (callIndex === 2) return cancellableResponse(201, cancellations);
      if (callIndex === 3) {
        return jsonResponse({
          status: "PUBLISH_COMPLETE",
          publicaly_available_post_id: ["post-1"],
        });
      }
      throw new Error(`unexpected fetch call ${callIndex}`);
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: videoData, mimeType: "video/mp4" }],
    });

    expect(result).toMatchObject({ success: true, postId: "post-1" });
    expect(calls).toHaveLength(4);

    const initBody = JSON.parse(String(calls[0]?.init?.body));
    expect(initBody.source_info).toEqual({
      source: "FILE_UPLOAD",
      video_size: 20_000_001,
      chunk_size: 10_000_000,
      total_chunk_count: 2,
    });

    const firstHeaders = new Headers(calls[1]?.init?.headers);
    const finalHeaders = new Headers(calls[2]?.init?.headers);
    expect(firstHeaders.get("content-range")).toBe("bytes 0-9999999/20000001");
    expect(firstHeaders.get("content-length")).toBe("10000000");
    expect(firstHeaders.get("content-type")).toBe("video/mp4");
    expect(finalHeaders.get("content-range")).toBe("bytes 10000000-20000000/20000001");
    expect(finalHeaders.get("content-length")).toBe("10000001");

    const firstBody = calls[1]?.init?.body;
    const finalBody = calls[2]?.init?.body;
    expect(firstBody).toBeInstanceOf(Uint8Array);
    expect(finalBody).toBeInstanceOf(Uint8Array);
    expect((firstBody as Uint8Array).buffer).toBe(videoData.buffer);
    expect((finalBody as Uint8Array).buffer).toBe(videoData.buffer);
    expect((firstBody as Uint8Array).byteOffset).toBe(videoData.byteOffset);
    expect((finalBody as Uint8Array).byteOffset).toBe(videoData.byteOffset + 10_000_000);
    expect(cancellations).toEqual([206, 201]);
    expect(calls[1]?.init?.redirect).toBe("manual");
    expect(calls[1]?.url).toContain("upload_id=publish-1");
  });

  test("retries identical 5xx ranges, disposes responses, and accepts the final 201", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const cancellations: number[] = [];
    fetchImpl = async (input, init) => {
      const callIndex = calls.push({ url: String(input), init }) - 1;
      if (callIndex === 0) {
        return jsonResponse({
          publish_id: "publish-retry",
          upload_url: "https://open-upload.tiktokapis.com/video?upload_id=retry",
        });
      }
      if (callIndex === 1) return cancellableResponse(503, cancellations);
      if (callIndex === 2) return cancellableResponse(201, cancellations);
      return jsonResponse({ status: "PUBLISH_COMPLETE" });
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.from("video"), mimeType: "video/webm" }],
    });

    expect(result.success).toBe(true);
    expect(cancellations).toEqual([503, 201]);
    expect(new Headers(calls[1]?.init?.headers)).toEqual(new Headers(calls[2]?.init?.headers));
    expect(calls[1]?.init?.body).toEqual(calls[2]?.init?.body);
  });

  test("stops after bounded 5xx retries and disposes every response", async () => {
    let apiCallCount = 0;
    let putCount = 0;
    const cancellations: number[] = [];
    fetchImpl = async () => {
      apiCallCount += 1;
      return jsonResponse({
        publish_id: "publish-503",
        upload_url: "https://open-upload.tiktokapis.com/video?upload_id=503",
      });
    };
    safeFetchImpl = async () => {
      putCount += 1;
      return cancellableResponse(503, cancellations);
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.from("video"), mimeType: "video/mp4" }],
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: "TIKTOK_UPLOAD_CHUNK_STATUS_INVALID",
    });
    expect(apiCallCount).toBe(1);
    expect(putCount).toBe(3);
    expect(cancellations).toEqual([503, 503, 503]);
  });

  test("does not retry a lost final response before status reconciliation", async () => {
    let apiCallCount = 0;
    let putCount = 0;
    fetchImpl = async () => {
      apiCallCount += 1;
      if (apiCallCount === 1) {
        return jsonResponse({
          publish_id: "publish-lost-final",
          upload_url: "https://open-upload.tiktokapis.com/video?upload_id=lost",
        });
      }
      return jsonResponse({
        status: "PUBLISH_COMPLETE",
        publicaly_available_post_id: ["post-reconciled"],
      });
    };
    safeFetchImpl = async () => {
      putCount += 1;
      throw new Error("response connection reset");
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.from("video"), mimeType: "video/mp4" }],
    });

    expect(result).toMatchObject({ success: true, postId: "post-reconciled" });
    expect(putCount).toBe(1);
  });

  test("replays the same final range only after PROCESSING_UPLOAD reconciliation", async () => {
    let apiCallCount = 0;
    const putCalls: RequestInit[] = [];
    fetchImpl = async () => {
      apiCallCount += 1;
      if (apiCallCount === 1) {
        return jsonResponse({
          publish_id: "publish-replay",
          upload_url: "https://open-upload.tiktokapis.com/video?upload_id=replay",
        });
      }
      if (apiCallCount === 2) return jsonResponse({ status: "PROCESSING_UPLOAD" });
      return jsonResponse({ status: "PUBLISH_COMPLETE" });
    };
    safeFetchImpl = async (_input, init) => {
      putCalls.push(init ?? {});
      if (putCalls.length === 1) throw new Error("response connection reset");
      return new Response(null, { status: 201 });
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.from("video"), mimeType: "video/mp4" }],
    });

    expect(result.success).toBe(true);
    expect(putCalls).toHaveLength(2);
    expect(new Headers(putCalls[0]?.headers)).toEqual(new Headers(putCalls[1]?.headers));
    expect(putCalls[0]?.body).toEqual(putCalls[1]?.body);
  });

  test("returns an explicit credit hold when final transport and replay remain unresolved", async () => {
    let apiCallCount = 0;
    fetchImpl = async () => {
      apiCallCount += 1;
      if (apiCallCount === 1) {
        return jsonResponse({
          publish_id: "publish-unknown",
          upload_url: "https://open-upload.tiktokapis.com/video?upload_id=unknown",
        });
      }
      return jsonResponse({ status: "PROCESSING_UPLOAD" });
    };
    safeFetchImpl = async () => {
      throw new Error("response connection reset");
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.from("video"), mimeType: "video/mp4" }],
    });

    expect(result).toMatchObject({
      success: false,
      errorCode: "TIKTOK_UPLOAD_OUTCOME_UNKNOWN",
      creditDisposition: "hold",
      metadata: { publishId: "publish-unknown", providerStatus: "PROCESSING_UPLOAD" },
    });
  });

  test("accepts SharedArrayBuffer input with one ArrayBuffer copy per chunk", async () => {
    const sharedBacking = new SharedArrayBuffer(20_000_001);
    const videoData = Buffer.from(sharedBacking);
    expect(videoData.buffer).toBe(sharedBacking);
    videoData[0] = 0x41;
    videoData[10_000_000] = 0x42;
    videoData[20_000_000] = 0x43;
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    fetchImpl = async (input, init) => {
      const callIndex = calls.push({ url: String(input), init }) - 1;
      if (callIndex === 0) {
        return jsonResponse({
          publish_id: "publish-shared",
          upload_url: "https://upload.us.tiktokapis.com/video?upload_id=shared",
        });
      }
      if (callIndex === 1) return new Response(null, { status: 206 });
      if (callIndex === 2) return new Response(null, { status: 201 });
      if (callIndex === 3) return jsonResponse({ status: "PUBLISH_COMPLETE" });
      throw new Error(`unexpected fetch call ${callIndex}`);
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: videoData, mimeType: "video/mp4" }],
    });

    expect(result.success).toBe(true);
    const firstBody = calls[1]?.init?.body as Uint8Array;
    const finalBody = calls[2]?.init?.body as Uint8Array;
    expect(firstBody.buffer).toBeInstanceOf(ArrayBuffer);
    expect(finalBody.buffer).toBeInstanceOf(ArrayBuffer);
    expect(firstBody.buffer).not.toBe(sharedBacking);
    expect(finalBody.buffer).not.toBe(sharedBacking);
    expect(firstBody.buffer).not.toBe(finalBody.buffer);
    expect(firstBody.buffer.byteLength).toBe(10_000_000);
    expect(finalBody.buffer.byteLength).toBe(10_000_001);
    expect(firstBody.byteLength).toBe(10_000_000);
    expect(finalBody.byteLength).toBe(10_000_001);
    expect(firstBody[0]).toBe(0x41);
    expect(finalBody[0]).toBe(0x42);
    expect(finalBody.at(-1)).toBe(0x43);
  });

  test("stops before status polling when an intermediate chunk is not 206", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const cancellations: number[] = [];
    fetchImpl = async (input, init) => {
      const callIndex = calls.push({ url: String(input), init }) - 1;
      if (callIndex === 0) {
        return jsonResponse({
          publish_id: "publish-2",
          upload_url: "https://open-upload.tiktokapis.com/video?upload_id=publish-2",
        });
      }
      return cancellableResponse(201, cancellations);
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.alloc(20_000_001), mimeType: "video/mp4" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("chunk 1/2 returned 201; expected 206");
    expect(calls).toHaveLength(2);
    expect(cancellations).toEqual([201]);
  });

  test("requires 201 for the final chunk and does not poll after a 206", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    fetchImpl = async (input, init) => {
      const callIndex = calls.push({ url: String(input), init }) - 1;
      if (callIndex === 0) {
        return jsonResponse({
          publish_id: "publish-3",
          upload_url: "https://open-upload.tiktokapis.com/video?upload_id=publish-3",
        });
      }
      return new Response(null, { status: 206 });
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.from("video"), mimeType: "video/mp4" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("chunk 1/1 returned 206; expected 201");
    expect(calls).toHaveLength(2);
  });

  test("rejects empty inline video before initializing an upload", async () => {
    let fetchCount = 0;
    fetchImpl = async () => {
      fetchCount += 1;
      throw new Error("transport must not run");
    };

    const result = await tiktokProvider.createPost(credentials, {
      text: "hello",
      media: [{ type: "video", data: Buffer.alloc(0), mimeType: "video/mp4" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("positive whole number of bytes");
    expect(fetchCount).toBe(0);
  });
});
