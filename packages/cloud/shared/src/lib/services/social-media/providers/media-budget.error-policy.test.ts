/**
 * Pins the shared media byte budget at every provider call site that is not a
 * URL download.
 *
 * #22604 bound `media.url` against `SOCIAL_MEDIA_MEDIA_MAX_BYTES` for the whole
 * service. The `media.data` and `media.base64` siblings of the same `if/else`
 * were left unbounded, so an oversized attachment posted successfully by moving
 * to another field of the same object. Each provider is driven through its real
 * exported entry point:
 *
 *   - `blueskyProvider.createPost`  (the in-loop chain)
 *   - `blueskyProvider.uploadMedia`
 *   - `mastodonProvider.uploadMedia`
 *   - `linkedinProvider.uploadMedia`
 *   - `twitterProvider.uploadMedia`
 *   - `slackProvider.uploadMedia`
 *
 * Both directions are pinned: an oversized attachment fails closed before the
 * upload transport is reached, and an ordinary attachment still posts.
 *
 * The `rate-limit` boundary is replaced with a sleepless pass-through so the
 * media chain — not the retry backoff — is what is under test. `mock.module`
 * patches the process-global registry, so the real exports are reinstalled in
 * `afterAll` (see the note in `slack.error-policy.test.ts`).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ElizaError } from "@elizaos/core";

import type { MediaAttachment, PostContent, SocialCredentials } from "../../../types/social-media";
import { SOCIAL_MEDIA_MEDIA_MAX_BYTES } from "../../../types/social-media";
import * as realRateLimit from "../rate-limit";

const realRateLimitExports = { ...realRateLimit };

mock.module("../rate-limit", () => ({
  withRetry: async (fn: () => Promise<Response>, parser: (r: Response) => Promise<unknown>) => ({
    data: await parser(await fn()),
  }),
  isRateLimitResponse: (r: Response) => r.status === 429,
}));

const { blueskyProvider } = await import("./bluesky");
const { mastodonProvider } = await import("./mastodon");
const { linkedinProvider } = await import("./linkedin");
const { twitterProvider } = await import("./twitter");
const { slackProvider } = await import("./slack");

/**
 * 11 MiB of raw bytes: past the budget, but small enough that the guard's
 * pre-allocation check rejects it without the test ever materializing a decode.
 */
const OVERSIZE_BASE64 = Buffer.alloc(11 * 1024 * 1024, 0x41).toString("base64");
const OVERSIZE_DATA = Buffer.alloc(SOCIAL_MEDIA_MEDIA_MAX_BYTES + 1, 0x41);
const SMALL_BYTES = Buffer.from("PNGBYTES");
const SMALL_BASE64 = SMALL_BYTES.toString("base64");

const oversizeBase64Media = (): MediaAttachment =>
  ({ type: "image", base64: OVERSIZE_BASE64, mimeType: "image/png" }) as MediaAttachment;
const oversizeDataMedia = (): MediaAttachment =>
  ({ type: "image", data: OVERSIZE_DATA, mimeType: "image/png" }) as MediaAttachment;
const smallBase64Media = (): MediaAttachment =>
  ({ type: "image", base64: SMALL_BASE64, mimeType: "image/png" }) as MediaAttachment;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchQueue: Array<() => Response>;
let mediaBodies: Uint8Array[];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchQueue = [];
  mediaBodies = [];
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
    const next = fetchQueue.shift();
    if (!next) throw new Error("unexpected fetch call - queue empty");
    const body = init?.body;
    if (body instanceof Uint8Array) mediaBodies.push(body);
    if (body instanceof FormData) {
      const file = body.get("file") ?? body.get("media");
      if (file instanceof Blob) mediaBodies.push(new Uint8Array(await file.arrayBuffer()));
    }
    return next();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../rate-limit", () => realRateLimitExports);
});

async function rejection(p: Promise<unknown>): Promise<ElizaError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(ElizaError);
    return error as ElizaError;
  }
  throw new Error("expected the media budget guard to reject, but the call resolved");
}

function expectTooLarge(error: ElizaError, platform: string): void {
  expect(error.code).toBe("SOCIAL_MEDIA_MEDIA_TOO_LARGE");
  expect(error.context).toMatchObject({ platform });
}

const BSKY_CREDS = { handle: "agent.bsky.social", appPassword: "app-pass" } as SocialCredentials;
const BSKY_SESSION = () =>
  json({ accessJwt: "jwt", refreshJwt: "refresh", handle: BSKY_CREDS.handle, did: "did:x" });

describe("blueskyProvider — media budget", () => {
  test("uploadMedia rejects an oversized base64 attachment before the blob upload", async () => {
    fetchQueue = [BSKY_SESSION];

    const error = await rejection(blueskyProvider.uploadMedia!(BSKY_CREDS, oversizeBase64Media()));
    expectTooLarge(error, "bluesky");
    // Only the session hop ran; the upload transport was never reached.
    expect(fetchQueue.length).toBe(0);
    expect(mediaBodies.length).toBe(0);
  });

  test("uploadMedia rejects an oversized caller-supplied Buffer", async () => {
    fetchQueue = [BSKY_SESSION];

    const error = await rejection(blueskyProvider.uploadMedia!(BSKY_CREDS, oversizeDataMedia()));
    expectTooLarge(error, "bluesky");
    expect(mediaBodies.length).toBe(0);
  });

  test("uploadMedia still posts an ordinary base64 attachment", async () => {
    fetchQueue = [
      BSKY_SESSION,
      () =>
        json({
          blob: {
            $type: "blob",
            ref: { $link: "blob-link" },
            mimeType: "image/png",
            size: SMALL_BYTES.length,
          },
        }),
    ];

    const result = await blueskyProvider.uploadMedia!(BSKY_CREDS, smallBase64Media());
    expect(result.mediaId).toBe("blob-link");
    expect(Buffer.from(mediaBodies[0]!).toString()).toBe("PNGBYTES");
  });

  test("createPost fails closed on an oversized base64 attachment instead of posting", async () => {
    fetchQueue = [BSKY_SESSION];
    const content = {
      text: "hello",
      media: [oversizeBase64Media()],
    } as PostContent;

    const result = await blueskyProvider.createPost(BSKY_CREDS, content);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Media attachment exceeds the media byte limit");
    // createRecord was never called.
    expect(fetchQueue.length).toBe(0);
    expect(mediaBodies.length).toBe(0);
  });
});

const MASTODON_CREDS = {
  accessToken: "token",
  instanceUrl: "https://mastodon.example",
} as SocialCredentials;

describe("mastodonProvider — media budget", () => {
  test("uploadMedia rejects an oversized base64 attachment", async () => {
    const error = await rejection(
      mastodonProvider.uploadMedia!(MASTODON_CREDS, oversizeBase64Media()),
    );
    expectTooLarge(error, "mastodon");
    expect(mediaBodies.length).toBe(0);
  });

  test("uploadMedia rejects an oversized caller-supplied Buffer", async () => {
    const error = await rejection(
      mastodonProvider.uploadMedia!(MASTODON_CREDS, oversizeDataMedia()),
    );
    expectTooLarge(error, "mastodon");
    expect(mediaBodies.length).toBe(0);
  });

  test("uploadMedia still posts an ordinary base64 attachment", async () => {
    fetchQueue = [() => json({ id: "M1", url: "https://mastodon.example/media/M1" })];

    const result = await mastodonProvider.uploadMedia!(MASTODON_CREDS, smallBase64Media());
    expect(result.mediaId).toBe("M1");
    expect(Buffer.from(mediaBodies[0]!).toString()).toBe("PNGBYTES");
  });
});

const LINKEDIN_CREDS = { accessToken: "token" } as SocialCredentials;
const LINKEDIN_PRELUDE = () => [
  () => json({ sub: "person-1", id: "person-1" }),
  () =>
    json({
      value: {
        asset: "urn:li:digitalmediaAsset:A1",
        uploadMechanism: {
          "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
            uploadUrl: "https://upload.linkedin.example/a1",
          },
        },
      },
    }),
];

describe("linkedinProvider — media budget", () => {
  test("uploadMedia rejects an oversized base64 attachment before the asset upload", async () => {
    fetchQueue = LINKEDIN_PRELUDE();

    const error = await rejection(
      linkedinProvider.uploadMedia!(LINKEDIN_CREDS, oversizeBase64Media()),
    );
    expectTooLarge(error, "linkedin");
    expect(fetchQueue.length).toBe(0);
    expect(mediaBodies.length).toBe(0);
  });

  test("uploadMedia rejects an oversized caller-supplied Buffer", async () => {
    fetchQueue = LINKEDIN_PRELUDE();

    const error = await rejection(
      linkedinProvider.uploadMedia!(LINKEDIN_CREDS, oversizeDataMedia()),
    );
    expectTooLarge(error, "linkedin");
    expect(mediaBodies.length).toBe(0);
  });

  test("uploadMedia still uploads an ordinary base64 attachment", async () => {
    fetchQueue = [...LINKEDIN_PRELUDE(), () => new Response(null, { status: 201 })];

    await linkedinProvider.uploadMedia!(LINKEDIN_CREDS, smallBase64Media());
    expect(Buffer.from(mediaBodies[0]!).toString()).toBe("PNGBYTES");
  });
});

const TWITTER_CREDS = { accessToken: "token" } as SocialCredentials;

describe("twitterProvider — media budget", () => {
  test("uploadMedia rejects an oversized base64 attachment", async () => {
    const error = await rejection(
      twitterProvider.uploadMedia!(TWITTER_CREDS, oversizeBase64Media()),
    );
    expectTooLarge(error, "twitter");
    expect(mediaBodies.length).toBe(0);
  });

  test("uploadMedia rejects an oversized caller-supplied Buffer", async () => {
    const error = await rejection(twitterProvider.uploadMedia!(TWITTER_CREDS, oversizeDataMedia()));
    expectTooLarge(error, "twitter");
    expect(mediaBodies.length).toBe(0);
  });

  test("uploadMedia still posts an ordinary base64 attachment", async () => {
    fetchQueue = [() => json({ media_id_string: "T1" })];

    const result = await twitterProvider.uploadMedia!(TWITTER_CREDS, smallBase64Media());
    expect(result.mediaId).toBe("T1");
  });
});

const SLACK_CREDS = { botToken: "xoxb-token", channelId: "C123" } as SocialCredentials;

describe("slackProvider — media budget", () => {
  test("uploadMedia rejects an oversized base64 attachment", async () => {
    const error = await rejection(slackProvider.uploadMedia!(SLACK_CREDS, oversizeBase64Media()));
    expectTooLarge(error, "slack");
    expect(mediaBodies.length).toBe(0);
  });

  test("uploadMedia rejects an oversized caller-supplied Buffer", async () => {
    const error = await rejection(slackProvider.uploadMedia!(SLACK_CREDS, oversizeDataMedia()));
    expectTooLarge(error, "slack");
    expect(mediaBodies.length).toBe(0);
  });

  test("uploadMedia still posts an ordinary base64 attachment", async () => {
    fetchQueue = [() => json({ ok: true, file: { id: "F1", permalink: "https://files/x" } })];

    const result = await slackProvider.uploadMedia!(SLACK_CREDS, smallBase64Media());
    expect(result.mediaId).toBe("F1");
    expect(Buffer.from(mediaBodies[0]!).toString()).toBe("PNGBYTES");
  });
});
