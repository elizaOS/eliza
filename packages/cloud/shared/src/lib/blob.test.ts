// Exercises uploadFromUrl's SSRF-guarded fetch and streamed byte cap with a
// mocked safeFetch and an in-memory R2 binding. Deterministic, no network.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const safeFetchMock = vi.fn();

vi.mock("./security/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
}));

const { uploadFromUrl } = await import("./blob");
const { setRuntimeR2Bucket } = await import("./storage/r2-runtime-binding");

const MAX_BYTES = 25 * 1024 * 1024;

const puts: Array<{ key: string; bytes: Uint8Array; contentType?: string }> = [];

function streamResponse(
  chunks: Uint8Array[],
  init: { headers?: Record<string, string> } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    statusText: "OK",
    headers: init.headers,
  });
}

describe("uploadFromUrl", () => {
  beforeEach(() => {
    puts.length = 0;
    safeFetchMock.mockReset();
    setRuntimeR2Bucket({
      get: async () => null,
      put: async (
        key: string,
        value: unknown,
        options?: { httpMetadata?: { contentType?: string } },
      ) => {
        puts.push({
          key,
          bytes: new Uint8Array(value as ArrayBuffer),
          contentType: options?.httpMetadata?.contentType,
        });
      },
      delete: async () => undefined,
    });
  });

  afterEach(() => {
    setRuntimeR2Bucket(null);
  });

  test("uploads a capped payload with the response content type", async () => {
    const payload = new TextEncoder().encode("affiliate image bytes");
    safeFetchMock.mockResolvedValue(
      streamResponse([payload], { headers: { "content-type": "image/png" } }),
    );

    const result = await uploadFromUrl("https://images.example/avatar.png", {
      filename: "avatar.png",
      folder: "affiliate/char-1",
    });

    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(/^affiliate\/char-1\/\d+-avatar\.png$/);
    expect(Buffer.from(puts[0].bytes).toString()).toBe("affiliate image bytes");
    expect(puts[0].contentType).toBe("image/png");
    expect(result.size).toBe(payload.length);
  });

  test("propagates the outbound guard rejection without touching R2", async () => {
    safeFetchMock.mockRejectedValue(new Error("Private or reserved IP addresses are not allowed"));

    await expect(
      uploadFromUrl("http://169.254.169.254/latest/meta-data", { filename: "x.png" }),
    ).rejects.toThrow("Private or reserved IP addresses are not allowed");
    expect(puts).toHaveLength(0);
  });

  test("rejects a non-OK response without reading the body", async () => {
    safeFetchMock.mockResolvedValue(new Response("nope", { status: 404, statusText: "Not Found" }));

    await expect(
      uploadFromUrl("https://images.example/missing.png", { filename: "x.png" }),
    ).rejects.toThrow("Failed to fetch URL: Not Found");
    expect(puts).toHaveLength(0);
  });

  test("rejects a declared Content-Length above the cap before reading", async () => {
    safeFetchMock.mockResolvedValue(
      streamResponse([], {
        headers: { "content-length": String(MAX_BYTES + 1) },
      }),
    );

    await expect(
      uploadFromUrl("https://images.example/huge.png", { filename: "x.png" }),
    ).rejects.toThrow(`exceeds the ${MAX_BYTES}-byte cap`);
    expect(puts).toHaveLength(0);
  });

  test("stops reading the stream once the running total crosses the cap", async () => {
    // 2MB chunks: the 13th chunk (26MB) crosses the 25MB cap. If the reader
    // bailed at the crossing instead of draining the body, the source can have
    // produced at most a high-water-mark prefetch past it — never all 16.
    let sent = 0;
    const chunk = new Uint8Array(2 * 1024 * 1024).fill(1);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 16) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    safeFetchMock.mockResolvedValue(new Response(stream, { status: 200, statusText: "OK" }));

    await expect(
      uploadFromUrl("https://images.example/lying.png", { filename: "x.png" }),
    ).rejects.toThrow(`exceeds the ${MAX_BYTES}-byte cap`);
    expect(sent).toBeLessThan(16);
    expect(puts).toHaveLength(0);
  });
});
