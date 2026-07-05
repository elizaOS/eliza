// Pins the fail-closed error policy of the LinkedIn provider (#13415). Two
// distinct failure surfaces are under test, driving the real exported
// `linkedinProvider` against deterministic fetch fixtures (no live network):
//   1. Media upload (`uploadMedia`) must NOT fabricate an asset handle when the
//      image download or the asset-upload PUT returns a non-OK status — the
//      failure must propagate so callers never attach bytes LinkedIn never
//      stored. A fully-successful path still returns the real `mediaId`.
//   2. Analytics readers (`getPostAnalytics`/`getAccountAnalytics`) keep the
//      designed-empty result (`null` for absent creds / a post with no recorded
//      social actions) DISTINGUISHABLE from an internal failure, which throws.
// The rate-limit backoff sleeps are collapsed so a retrying failure rejects
// promptly instead of waiting out real exponential-backoff delays.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { MediaAttachment, SocialCredentials } from "../../../types/social-media";

mock.module("../../../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

const { linkedinProvider } = await import("./linkedin");

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

const CREDS = { accessToken: "tok" } as SocialCredentials;
const NO_CREDS = {} as SocialCredentials;

const UPLOAD_URL = "https://upload.li.example/stream/abc";
const ASSET_URN = "urn:li:digitalmediaAsset:xyz";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return String(input);
}

const REGISTER_RESPONSE = {
  value: {
    uploadMechanism: {
      "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
        uploadUrl: UPLOAD_URL,
        headers: {},
      },
    },
    asset: ASSET_URN,
  },
};

beforeEach(() => {
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

/**
 * Routes the LinkedIn API calls (`/me`, `registerUpload`) to fixtures and lets
 * the caller decide the outcome of the raw asset-upload PUT and any image
 * download.
 */
function mockLinkedInFetch(opts: { uploadStatus?: number; downloadStatus?: number }): void {
  globalThis.fetch = mock(async (input: unknown) => {
    const url = urlOf(input);
    if (url === UPLOAD_URL) return jsonResponse({}, opts.uploadStatus ?? 200);
    if (url.includes("/me")) return jsonResponse({ id: "person123" });
    if (url.includes("registerUpload") || url.includes("/assets"))
      return jsonResponse(REGISTER_RESPONSE);
    // Any other URL is treated as a remote image download.
    if (opts.downloadStatus && opts.downloadStatus >= 400)
      return jsonResponse({}, opts.downloadStatus);
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as typeof fetch;
}

describe("linkedinProvider.uploadMedia — fail closed", () => {
  it("returns the real asset URN when the upload PUT succeeds (drives the real path)", async () => {
    mockLinkedInFetch({ uploadStatus: 200 });
    const media: MediaAttachment = {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from([1, 2, 3]),
    };

    const result = await linkedinProvider.uploadMedia!(CREDS, media);
    expect(result.mediaId).toBe(ASSET_URN);
  });

  it("PROPAGATES a non-OK asset-upload PUT instead of fabricating a media handle", async () => {
    mockLinkedInFetch({ uploadStatus: 500 });
    const media: MediaAttachment = {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from([1, 2, 3]),
    };

    const err = await rejects(linkedinProvider.uploadMedia!(CREDS, media));
    expect(err.message).toContain("upload failed");
    expect(err.message).toContain("500");
  });

  it("PROPAGATES a non-OK image download instead of uploading garbage bytes", async () => {
    mockLinkedInFetch({ uploadStatus: 200, downloadStatus: 404 });
    const media: MediaAttachment = {
      type: "image",
      mimeType: "image/png",
      url: "https://cdn.example/missing.png",
    };

    const err = await rejects(linkedinProvider.uploadMedia!(CREDS, media));
    expect(err.message).toContain("download failed");
    expect(err.message).toContain("404");
  });

  it("throws (designed invalid input) without any fetch when the access token is absent", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch;

    await expect(
      linkedinProvider.uploadMedia!(NO_CREDS, { type: "image", mimeType: "image/png" }),
    ).rejects.toThrow("Access token required");
    expect(fetchCalls).toBe(0);
  });
});

describe("linkedinProvider analytics — designed-empty vs internal failure", () => {
  it("getPostAnalytics returns null (not configured) without any fetch when creds are absent", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch;

    const result = await linkedinProvider.getPostAnalytics!(NO_CREDS, "urn:li:share:1");
    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it("getPostAnalytics returns null (designed empty) when the post has no social actions", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ elements: [] })) as typeof fetch;

    const result = await linkedinProvider.getPostAnalytics!(CREDS, "urn:li:share:1");
    expect(result).toBeNull();
  });

  it("getPostAnalytics returns real metrics for a post with recorded actions", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        elements: [{ likesSummary: { totalLikes: 9 }, commentsSummary: { totalComments: 4 } }],
      }),
    ) as typeof fetch;

    const result = await linkedinProvider.getPostAnalytics!(CREDS, "urn:li:share:1");
    expect(result).not.toBeNull();
    expect(result?.metrics.likes).toBe(9);
    expect(result?.metrics.comments).toBe(4);
  });

  it("getPostAnalytics PROPAGATES an internal 5xx instead of masking it as null", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ message: "server error", status: 500 }, 500),
    ) as typeof fetch;

    const err = await rejects(linkedinProvider.getPostAnalytics!(CREDS, "urn:li:share:1"));
    expect(err.message).toContain("500");
  });

  it("getAccountAnalytics PROPAGATES an internal /me failure instead of returning null", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ message: "unauthorized", status: 401 }, 401),
    ) as typeof fetch;

    const err = await rejects(linkedinProvider.getAccountAnalytics!(CREDS));
    expect(err.message).toContain("401");
  });
});
