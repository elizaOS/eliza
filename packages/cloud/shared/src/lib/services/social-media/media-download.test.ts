/**
 * Exercises the real social-media download boundary with deterministic
 * transports, including streaming overflow, cancellation, and abort identity.
 */

import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";

import * as realSafeFetchModule from "../../security/safe-fetch";

const realSafeFetchExports = { ...realSafeFetchModule };
const realSafeFetch = realSafeFetchModule.safeFetch;
const safeFetch = mock(realSafeFetch);
mock.module("../../security/safe-fetch", () => ({ ...realSafeFetchExports, safeFetch }));

const { downloadSocialMediaBytes } = await import("./media-download");

const MAX_BYTES = 10 * 1024 * 1024;

beforeEach(() => {
  safeFetch.mockClear();
  safeFetch.mockImplementation(realSafeFetch);
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  mock.module("../../security/safe-fetch", () => realSafeFetchExports);
});

describe("downloadSocialMediaBytes", () => {
  test("uses the real outbound guard and rejects a private initial target", async () => {
    const error = await downloadSocialMediaBytes("http://127.0.0.1/private").catch(
      (cause) => cause,
    );

    expect(error).toBeInstanceOf(ElizaError);
    expect(error.code).toBe("SOCIAL_MEDIA_DOWNLOAD_FAILED");
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toMatch(/private|reserved|forbidden/i);
  });

  test("returns successful response bytes through the shared safe-fetch boundary", async () => {
    safeFetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const result = await downloadSocialMediaBytes("https://media.example/image.png");

    expect([...result]).toEqual([1, 2, 3]);
  });

  test("preserves the provider-specific non-OK message and cancels the body", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 404 },
    );

    safeFetch.mockResolvedValue(response);
    const error = await downloadSocialMediaBytes("https://media.example/missing.png", {
      httpErrorMessage: (status) => `Provider download failed: ${status}`,
    }).catch((cause) => cause);

    expect(error).toBeInstanceOf(ElizaError);
    expect(error.code).toBe("SOCIAL_MEDIA_DOWNLOAD_HTTP_ERROR");
    expect(error.message).toBe("Provider download failed: 404");
    expect(cancelled).toBe(true);
  });

  test("does not let non-cooperative cancellation mask a non-OK response", async () => {
    let cancellationStarted = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancellationStarted = true;
          return new Promise<void>(() => undefined);
        },
      }),
      { status: 503 },
    );

    safeFetch.mockResolvedValue(response);
    const outcome = await Promise.race([
      downloadSocialMediaBytes("https://media.example/unavailable.bin").catch((cause) => cause),
      new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 100)),
    ]);

    expect(outcome).toBeInstanceOf(ElizaError);
    expect((outcome as ElizaError).code).toBe("SOCIAL_MEDIA_DOWNLOAD_HTTP_ERROR");
    expect((outcome as ElizaError).context).toMatchObject({ status: 503 });
    expect(cancellationStarted).toBe(true);
  });

  test("rejects a declared overflow before reading and cancels the body", async () => {
    let reads = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull() {
          reads += 1;
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-length": String(MAX_BYTES + 1) } },
    );

    safeFetch.mockResolvedValue(response);
    const error = await downloadSocialMediaBytes("https://media.example/large.bin").catch(
      (cause) => cause,
    );

    expect(error).toBeInstanceOf(ElizaError);
    expect(error.code).toBe("SOCIAL_MEDIA_DOWNLOAD_TOO_LARGE");
    // Web streams may perform one eager pull while constructing the Response;
    // the downloader itself never acquires a reader for a declared overflow.
    expect(reads).toBeLessThanOrEqual(1);
    expect(cancelled).toBe(true);
  });

  test("stops a chunked response at the cap and cancels without reading the tail", async () => {
    let cancelled = false;
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls <= 2) {
            controller.enqueue(new Uint8Array(6 * 1024 * 1024));
          } else {
            controller.enqueue(new Uint8Array([9]));
          }
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    safeFetch.mockResolvedValue(response);
    const error = await downloadSocialMediaBytes("https://media.example/chunked.bin").catch(
      (cause) => cause,
    );

    expect(error).toBeInstanceOf(ElizaError);
    expect(error.code).toBe("SOCIAL_MEDIA_DOWNLOAD_TOO_LARGE");
    // The stream implementation may prefetch one tail chunk, but the
    // downloader retains only the two chunks needed to cross the cap.
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  test("propagates the caller's exact abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    safeFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = downloadSocialMediaBytes("https://media.example/slow.bin", {
      signal: controller.signal,
    });

    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test("enforces the deadline even when the transport ignores AbortSignal", async () => {
    jest.useFakeTimers();
    safeFetch.mockImplementation(() => new Promise(() => undefined));
    const pending = downloadSocialMediaBytes("https://media.example/stalled.bin");

    jest.advanceTimersByTime(10_000);
    const error = await pending.catch((cause) => cause);
    expect(error).toBeInstanceOf(ElizaError);
    expect(error.code).toBe("SOCIAL_MEDIA_DOWNLOAD_TIMEOUT");
  });
});
