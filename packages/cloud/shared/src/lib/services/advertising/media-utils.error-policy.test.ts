/**
 * Error-policy regression guard (#13415) for ad-media download: a failed or
 * errored provider fetch must PROPAGATE (throw), never be swallowed into an
 * empty/default DownloadedAdMedia a caller would trust. Pins that a
 * legitimately-empty download (200 + zero bytes) succeeds and stays DISTINCT
 * from a transport/HTTP failure. `safeFetch` is the only stub — a controllable
 * transport standing in for the real SSRF-pinned fetch.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type SafeFetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

let safeFetchImpl: SafeFetchImpl;

// Mirrors media-utils.ts's own import specifier so the module under test binds
// to this controllable transport instead of the real IP-pinning safeFetch.
mock.module("../../security/safe-fetch", () => ({
  safeFetch: (url: string, init?: RequestInit) => safeFetchImpl(url, init),
}));

const URL_UNDER_TEST = "https://cdn.example.com/creative/ad.png";

beforeEach(() => {
  safeFetchImpl = async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
});

afterEach(() => {
  mock.restore();
});

describe("#13415 — downloadAdMedia surfaces fetch failures, never fabricates a download", () => {
  test("designed success: a real 200 response returns the exact bytes", async () => {
    const { downloadAdMedia } = await import("./media-utils");
    const result = await downloadAdMedia(URL_UNDER_TEST);
    // Distinguishes the healthy path from every failure below: real bytes and a
    // real base64 payload, not an empty/default result.
    expect(result.bytes.byteLength).toBe(4);
    expect(result.base64).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(result.contentType).toBe("image/png");
    expect(result.url).toBe(URL_UNDER_TEST);
  });

  test("legitimately-empty download (200 + zero bytes) succeeds and is DISTINCT from a failure", async () => {
    safeFetchImpl = async () =>
      new Response(new Uint8Array(0), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    const { downloadAdMedia } = await import("./media-utils");
    const result = await downloadAdMedia(URL_UNDER_TEST);
    // A valid but empty asset resolves — the empty result is a legitimate
    // download, never conflated with the thrown transport/HTTP errors below.
    expect(result.bytes.byteLength).toBe(0);
    expect(result.base64).toBe("");
  });

  test("non-2xx HTTP status PROPAGATES (never swallowed into an empty media object)", async () => {
    safeFetchImpl = async () => new Response("upstream boom", { status: 500 });
    const { downloadAdMedia } = await import("./media-utils");
    await expect(downloadAdMedia(URL_UNDER_TEST)).rejects.toThrow(
      /Failed to download ad media \(500\)/,
    );
  });

  test("transport rejection PROPAGATES (no catch masks a network failure as success)", async () => {
    safeFetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { downloadAdMedia } = await import("./media-utils");
    await expect(downloadAdMedia(URL_UNDER_TEST)).rejects.toThrow(/ECONNREFUSED/);
  });

  test("redirect without a Location header throws instead of resolving empty", async () => {
    safeFetchImpl = async () => new Response(null, { status: 302 });
    const { downloadAdMedia } = await import("./media-utils");
    await expect(downloadAdMedia(URL_UNDER_TEST)).rejects.toThrow(
      /redirected without a Location header/,
    );
  });

  test("an endless redirect chain fails closed with a redirect-budget error", async () => {
    safeFetchImpl = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example.com/creative/next.png" },
      });
    const { downloadAdMedia } = await import("./media-utils");
    await expect(downloadAdMedia(URL_UNDER_TEST)).rejects.toThrow(/Too many redirects/);
  });

  test("a disallowed content type throws rather than returning the untrusted bytes", async () => {
    safeFetchImpl = async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const { downloadAdMedia } = await import("./media-utils");
    await expect(
      downloadAdMedia(URL_UNDER_TEST, { allowedContentTypes: ["image/png"] }),
    ).rejects.toThrow(/Unsupported ad media content type/);
  });

  test("an oversize asset throws rather than buffering past the cap", async () => {
    safeFetchImpl = async () =>
      new Response(new Uint8Array(100), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    const { downloadAdMedia } = await import("./media-utils");
    await expect(downloadAdMedia(URL_UNDER_TEST, { maxBytes: 10 })).rejects.toThrow(
      /exceeds maximum size/,
    );
  });
});
