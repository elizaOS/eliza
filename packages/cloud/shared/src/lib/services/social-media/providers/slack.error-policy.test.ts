/**
 * Pins the fail-closed error policy of the Slack provider (#13415).
 *
 * Two contracts are under test against the real exported `slackProvider`:
 *   1. `uploadMedia` now throws when the source media download fails
 *      (non-OK HTTP). Before the sweep it read `response.arrayBuffer()`
 *      unconditionally, so a 404/500 error page was uploaded as the file —
 *      a failed download silently fabricated a "successful" upload. The
 *      already-existing fail-closed paths (`data.ok === false`, missing bytes)
 *      are pinned alongside it.
 *   2. `createPost`'s outermost J1 boundary translates a genuine send failure
 *      into a structured `PostResult` with `success:false` (never a fabricated
 *      "sent"), while the happy path returns `success:true` — the two stay
 *      distinguishable.
 *
 * The `rate-limit` boundary (`withRetry`) is replaced with a sleepless
 * pass-through mirroring its real throw-on-non-OK semantics so the changed
 * branch — not the retry backoff — is exercised. `fetch` is stubbed per-test
 * and restored in afterEach.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { MediaAttachment, PostContent, SocialCredentials } from "../../../types/social-media";

mock.module("../rate-limit", () => ({
  withRetry: async (fn: () => Promise<Response>, parser: (r: Response) => Promise<unknown>) => {
    const response = await fn();
    if (response.status === 429) throw new Error("Rate limited by slack");
    const json = (await response.json()) as { ok?: boolean; error?: string };
    if (!json.ok) throw new Error(json.error ?? "Slack API error");
    // slackApiRequest's parser re-reads response.json(); hand it a clone-equivalent.
    return {
      data: json,
    };
  },
  isRateLimitResponse: (r: Response) => r.status === 429,
}));

const { slackProvider } = await import("./slack");

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const raw = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });

const BOT_CREDS = { botToken: "xoxb-token", channelId: "C123" } as SocialCredentials;

let fetchQueue: Array<(input: unknown) => Response>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchQueue = [];
  globalThis.fetch = mock(async (input: unknown) => {
    const next = fetchQueue.shift();
    if (!next) throw new Error("unexpected fetch call — queue empty");
    return next(input);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("slackProvider.uploadMedia — fail closed on a failed source download", () => {
  const urlMedia = {
    type: "image",
    url: "https://cdn.example/pic.png",
    mimeType: "image/png",
  } as MediaAttachment;

  test("PROPAGATES a non-OK media download instead of uploading the error body", async () => {
    // Only the download is attempted; the files.upload fetch must never run.
    fetchQueue = [() => raw("not found", 404)];

    const err = await rejects(slackProvider.uploadMedia!(BOT_CREDS, urlMedia));
    expect(err.message).toContain("Failed to download media");
    expect(err.message).toContain("404");
    // The upload call was never reached — the download failure short-circuited.
    expect(fetchQueue.length).toBe(0);
  });

  test("uploads successfully when the download AND files.upload both succeed (drives the real path)", async () => {
    fetchQueue = [
      () => raw("PNGBYTES", 200),
      () => json({ ok: true, file: { id: "F1", permalink: "https://files/x" } }),
    ];

    const result = await slackProvider.uploadMedia!(BOT_CREDS, urlMedia);
    expect(result.mediaId).toBe("F1");
    expect(result.url).toBe("https://files/x");
  });

  test("PROPAGATES a files.upload rejection (ok:false) instead of returning a fake mediaId", async () => {
    fetchQueue = [() => raw("PNGBYTES", 200), () => json({ ok: false, error: "invalid_auth" })];

    const err = await rejects(slackProvider.uploadMedia!(BOT_CREDS, urlMedia));
    expect(err.message).toContain("invalid_auth");
  });

  test("throws when no media bytes/url are provided (designed invalid input, distinct from a download failure)", async () => {
    const err = await rejects(
      slackProvider.uploadMedia!(BOT_CREDS, {
        type: "image",
        mimeType: "image/png",
      } as MediaAttachment),
    );
    expect(err.message).toContain("No media data provided");
  });
});

describe("slackProvider.createPost — designed failure vs success stay distinguishable", () => {
  const content = { text: "hello" } as PostContent;

  test("returns success:true with a postId on a real send", async () => {
    fetchQueue = [() => json({ ok: true, message: { ts: "1700.1" }, channel: "C123" })];

    const result = await slackProvider.createPost(BOT_CREDS, content);
    expect(result.success).toBe(true);
    expect(result.postId).toBe("1700.1");
  });

  test("returns a structured success:false (never a fabricated 'sent') when Slack rejects the post", async () => {
    fetchQueue = [() => json({ ok: false, error: "channel_not_found" })];

    const result = await slackProvider.createPost(BOT_CREDS, content);
    expect(result.success).toBe(false);
    expect(result.error).toContain("channel_not_found");
    // A failure carries no postId — the caller cannot mistake it for a real message.
    expect(result.postId).toBeUndefined();
  });

  test("designed pre-flight failure (missing channel) is a distinct success:false, no fetch attempted", async () => {
    const result = await slackProvider.createPost(
      { botToken: "xoxb-token" } as SocialCredentials,
      content,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Channel ID required");
    // No outbound call happened — the queue was never touched.
    expect(fetchQueue.length).toBe(0);
  });
});
