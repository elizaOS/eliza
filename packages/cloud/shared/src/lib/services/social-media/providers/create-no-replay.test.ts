import { afterEach, expect, spyOn, test } from "bun:test";
import { blueskyProvider } from "./bluesky";
import { discordProvider } from "./discord";
import { linkedinProvider } from "./linkedin";
import { mastodonProvider } from "./mastodon";
import { metaProvider } from "./meta";
import { redditProvider } from "./reddit";
import { slackProvider } from "./slack";
import { telegramProvider } from "./telegram";
import { tiktokProvider } from "./tiktok";
import { twitterProvider } from "./twitter";

/**
 * A create request whose outcome is unknown (the connection timed out after
 * the platform may have published) must not be sent again: none of these
 * platforms deduplicate a replayed create, so a replay publishes twice.
 */
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function timeout(): never {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** Routes every request; the first call matching `createPath` times out, later ones succeed. */
function stubPlatform(
  createPath: string,
  handlers: Record<string, (init?: RequestInit) => Response>,
): { creates: number } {
  const seen = { creates: 0 };
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.href.includes(createPath) && init?.method === "POST") {
        seen.creates += 1;
        if (seen.creates === 1) timeout();
        return handlers.create(init);
      }
      const handler = Object.entries(handlers).find(
        ([key]) => key !== "create" && url.href.includes(key),
      );
      if (!handler) throw new Error(`unexpected request ${url.href}`);
      return handler[1](init);
    }),
  );
  return seen;
}

test("bluesky sends createRecord once and reports the unknown outcome", async () => {
  const seen = stubPlatform("com.atproto.repo.createRecord", {
    "com.atproto.server.createSession": () =>
      json({ accessJwt: "jwt", refreshJwt: "r", did: "did:plc:app", handle: "app.bsky.social" }),
    create: () => json({ uri: "at://did:plc:app/app.bsky.feed.post/k2", cid: "cid" }),
  });

  const result = await blueskyProvider.createPost(
    { handle: "app.bsky.social", appPassword: "app-password" },
    { text: "Launch day" },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The platform may have published it: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});

test("reddit sends /api/submit once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/api/submit", {
    "/api/v1/access_token": () => json({ access_token: "token", expires_in: 3600 }),
    create: () =>
      json({ json: { data: { id: "t3_1", name: "t3_1", url: "https://reddit.com/r/x/1" } } }),
  });

  const result = await redditProvider.createPost(
    { apiKey: "id", apiSecret: "secret", username: "u", password: "p" },
    { text: "Launch day" },
    { reddit: { subreddit: "elizaos", title: "Launch day" } },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The platform may have published it: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});

test("linkedin sends /ugcPosts once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/ugcPosts", {
    create: () => json({}, 201, { "x-restli-id": "urn:li:share:1" }),
  });

  const result = await linkedinProvider.createPost(
    { accessToken: "token" },
    { text: "Launch day" },
    { linkedin: { organizationId: "123" } },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The platform may have published it: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});

test("twitter sends /tweets once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/tweets", {
    create: () => json({ data: { id: "1", text: "Launch day" } }),
  });

  const result = await twitterProvider.createPost({ accessToken: "token" }, { text: "Launch day" });

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The platform may have published it: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});

test("telegram sends sendMessage once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/sendMessage", {
    create: () => json({ ok: true, result: { message_id: 7, chat: { id: -100, type: "group" } } }),
  });

  const result = await telegramProvider.createPost(
    { botToken: "123:abc" },
    { text: "Launch day" },
    { telegram: { chatId: "-100" } },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The platform may have published it: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});

test("discord sends a channel message once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/channels/42/messages", {
    create: () => json({ id: "9", channel_id: "42", content: "Launch day" }),
  });

  const result = await discordProvider.createPost(
    { botToken: "bot-token" },
    { text: "Launch day" },
    { discord: { channelId: "42" } },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The platform may have published it: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});

test("discord executes a webhook once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/api/webhooks/1/token", {
    create: () => json({ id: "9", channel_id: "42", content: "Launch day" }),
  });

  const result = await discordProvider.createPost(
    { webhookUrl: "https://discord.com/api/webhooks/1/token" },
    { text: "Launch day" },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The platform may have published it: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});

test("slack sends chat.postMessage once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/chat.postMessage", {
    create: () => json({ ok: true, ts: "1.2", channel: "C1", message: { ts: "1.2" } }),
  });

  const result = await slackProvider.createPost(
    { botToken: "xoxb-token" },
    { text: "Launch day" },
    { slack: { channelId: "C1" } },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The platform may have published it: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});

test("facebook sends a page feed post once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/page-1/feed", {
    create: () => json({ id: "page-1_1" }),
  });

  const result = await metaProvider.createPost(
    { accessToken: "token" },
    { text: "Launch day" },
    { facebook: { pageId: "page-1" } },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The platform may have published it: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});

test("tiktok sends a pulled video init once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/post/publish/video/init/", {
    create: () => json({ data: { publish_id: "p1" }, error: { code: "ok", message: "" } }),
    "/post/publish/status/fetch/": () =>
      json({
        data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["v1"] },
        error: { code: "ok", message: "" },
      }),
  });

  const result = await tiktokProvider.createPost(
    { accessToken: "token" },
    { text: "Launch day", media: [{ type: "video", url: "https://cdn.example.com/v.mp4" }] },
  );

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The platform may have published it: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});

test("a create the platform refuses is a plain, refundable failure", async () => {
  let sends = 0;
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      sends += 1;
      return json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400);
    }),
  );

  const result = await telegramProvider.createPost(
    { botToken: "123:abc" },
    { text: "Launch day" },
    { telegram: { chatId: "-100" } },
  );

  expect(sends).toBe(1);
  expect(result.success).toBe(false);
  expect(result.creditDisposition).toBeUndefined();
});

for (const [label, response] of [
  ["truncated JSON", () => new Response('{"ok":true,"ts":', { status: 200 })],
  [
    "interrupted body",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("body connection closed"));
          },
        }),
        { status: 200 },
      ),
  ],
] as const) {
  test(`a Slack create with ${label} retains its unknown outcome`, async () => {
    let sends = 0;
    spies.push(
      spyOn(globalThis, "fetch").mockImplementation(async () => {
        sends += 1;
        return response();
      }),
    );
    const result = await slackProvider.createPost(
      { botToken: "xoxb-token" },
      { text: "Launch day" },
      { slack: { channelId: "C1" } },
    );
    expect(sends).toBe(1);
    expect(result.success).toBe(false);
    expect(result.creditDisposition).toBe("hold");
    expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
  });
}

test("an explicit Slack refusal in a successful HTTP response remains refundable", async () => {
  let sends = 0;
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      sends += 1;
      return json({ ok: false, error: "channel_not_found" });
    }),
  );
  const result = await slackProvider.createPost(
    { botToken: "xoxb-token" },
    { text: "Launch day" },
    { slack: { channelId: "C1" } },
  );
  expect(sends).toBe(1);
  expect(result.success).toBe(false);
  expect(result.creditDisposition).toBeUndefined();
});

for (const outcome of ["unreadable", "failed", "complete"] as const) {
  test(`TikTok preserves the original publication when its status is ${outcome}`, async () => {
    let creates = 0;
    spies.push(
      spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/post/publish/video/init/")) {
          creates += 1;
          return json({ data: { publish_id: "original-publication" }, error: { code: "ok" } });
        }
        if (url.includes("/post/publish/status/fetch/")) {
          if (outcome === "unreadable") throw new Error("status connection closed");
          return json({
            data:
              outcome === "failed"
                ? { status: "FAILED", fail_reason: "rejected" }
                : { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["post-7"] },
            error: { code: "ok" },
          });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    );
    const result = await tiktokProvider.createPost(
      { accessToken: "token" },
      { text: "Launch day", media: [{ type: "video", url: "https://cdn.example.com/v.mp4" }] },
    );
    expect(creates).toBe(1);
    expect(result.success).toBe(outcome === "complete");
    if (outcome === "unreadable") {
      expect(result.creditDisposition).toBe("hold");
      expect(result.errorCode).toBe("TIKTOK_PUBLISH_STATUS_UNKNOWN");
      expect(result.metadata?.publishId).toBe("original-publication");
    } else {
      expect(result.creditDisposition).toBeUndefined();
      if (outcome === "complete") expect(result.postId).toBe("post-7");
      else expect(result.errorCode).toBe("TIKTOK_PUBLISH_FAILED");
    }
  });
}

for (const platform of ["slack", "telegram"] as const) {
  for (const payload of [{}, { ok: 0 }, { ok: "false" }, { ok: true }, { ok: true, result: {} }]) {
    test(`${platform} keeps a malformed acknowledgement unknown: ${JSON.stringify(payload)}`, async () => {
      let sends = 0;
      spies.push(
        spyOn(globalThis, "fetch").mockImplementation(async () => {
          sends++;
          return json(payload);
        }),
      );
      const result =
        platform === "slack"
          ? await slackProvider.createPost(
              { botToken: "fixture" },
              { text: "Launch day" },
              { slack: { channelId: "C1" } },
            )
          : await telegramProvider.createPost(
              { botToken: "123:fixture" },
              { text: "Launch day" },
              { telegram: { chatId: "-100" } },
            );
      expect(sends).toBe(1);
      expect(result.success).toBe(false);
      expect(result.creditDisposition).toBe("hold");
      expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
    });
  }
}

for (const platform of ["slack", "telegram"] as const) {
  test(`${platform} retains a confirmed publication receipt`, async () => {
    let sends = 0;
    spies.push(
      spyOn(globalThis, "fetch").mockImplementation(async () => {
        sends++;
        return json(
          platform === "slack"
            ? { ok: true, ts: "123.456", channel: "C1" }
            : { ok: true, result: { message_id: 7, chat: { id: -100, type: "group" } } },
        );
      }),
    );
    const result =
      platform === "slack"
        ? await slackProvider.createPost(
            { botToken: "fixture" },
            { text: "Launch day" },
            { slack: { channelId: "C1" } },
          )
        : await telegramProvider.createPost(
            { botToken: "123:fixture" },
            { text: "Launch day" },
            { telegram: { chatId: "-100" } },
          );
    expect(sends).toBe(1);
    expect(result.success).toBe(true);
    expect(result.postId).toBe(platform === "slack" ? "123.456" : "7");
    expect(result.creditDisposition).toBeUndefined();
  });
}

const receiptCases = [
  {
    platform: "twitter",
    path: "/tweets",
    receipt: { data: { id: "1" } },
    send: () => twitterProvider.createPost({ accessToken: "fixture" }, { text: "Receipt review" }),
  },
  {
    platform: "discord",
    path: "/channels/42/messages",
    receipt: { id: "9", channel_id: "42" },
    send: () =>
      discordProvider.createPost(
        { botToken: "fixture" },
        { text: "Receipt review" },
        { discord: { channelId: "42" } },
      ),
  },
  {
    platform: "bluesky",
    path: "com.atproto.repo.createRecord",
    receipt: { uri: "at://did:plc:app/app.bsky.feed.post/k2", cid: "cid" },
    send: () =>
      blueskyProvider.createPost(
        { handle: "app.bsky.social", appPassword: "fixture" },
        { text: "Receipt review" },
      ),
  },
  {
    platform: "linkedin",
    path: "/ugcPosts",
    receipt: { id: "urn:li:share:1" },
    send: () =>
      linkedinProvider.createPost(
        { accessToken: "fixture" },
        { text: "Receipt review" },
        { linkedin: { organizationId: "123" } },
      ),
  },
  {
    platform: "facebook",
    path: "/page-1/feed",
    receipt: { id: "page-1_1" },
    send: () =>
      metaProvider.createPost(
        { accessToken: "fixture" },
        { text: "Receipt review" },
        { facebook: { pageId: "page-1" } },
      ),
  },
  {
    platform: "instagram",
    path: "/account-1/media_publish",
    receipt: { id: "media-1" },
    send: () =>
      metaProvider.createPost(
        { accessToken: "fixture", accountId: "account-1" },
        {
          text: "Receipt review",
          media: [{ type: "image" as const, url: "https://cdn.example.com/image.png" }],
        },
      ),
  },
  {
    platform: "mastodon",
    path: "/api/v1/statuses",
    receipt: { id: "110000000000000001", url: "https://mastodon.example/@app/110000000000000001" },
    send: () =>
      mastodonProvider.createPost(
        { accessToken: "fixture", instanceUrl: "https://mastodon.example" },
        { text: "Receipt review" },
      ),
  },
  {
    platform: "reddit",
    path: "/api/submit",
    receipt: { json: { errors: [], data: { id: "t3_1", url: "/r/elizaos/comments/1" } } },
    send: () =>
      redditProvider.createPost(
        { apiKey: "id", apiSecret: "fixture", username: "u", password: "fixture" },
        { text: "Receipt review" },
        { reddit: { subreddit: "elizaos", title: "Receipt review" } },
      ),
  },
];

for (const scenario of receiptCases) {
  for (const outcome of ["missing", "null", "numeric", "blank", "confirmed"] as const) {
    test(`${scenario.platform} classifies ${outcome} create receipts without replay`, async () => {
      let creates = 0;
      const id = outcome === "numeric" ? 17 : "  ";
      const malformed = {
        id,
        channel_id: id,
        uri: id,
        data: { id },
        json: { errors: [], data: { id } },
      };
      const payload =
        outcome === "confirmed"
          ? scenario.receipt
          : outcome === "missing"
            ? {}
            : outcome === "null"
              ? null
              : malformed;
      spies.push(
        spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          const url = String(input);
          if (url.includes(scenario.path) && init?.method === "POST") {
            creates++;
            return json(payload);
          }
          if (url.includes("com.atproto.server.createSession"))
            return json({
              accessJwt: "jwt",
              refreshJwt: "r",
              did: "did:plc:app",
              handle: "app.bsky.social",
            });
          if (url.includes("/api/v1/access_token"))
            return json({ access_token: "token", expires_in: 3600 });
          if (url.includes("/account-1/media?")) return json({ id: "container-1" });
          throw new Error(`Unexpected fixture request ${url}`);
        }),
      );
      const result = await scenario.send();
      expect(creates).toBe(1);
      expect(result.success).toBe(outcome === "confirmed");
      if (outcome === "confirmed") {
        expect(result.postId).toBeTruthy();
        expect(result.creditDisposition).toBeUndefined();
      } else {
        expect(result.creditDisposition).toBe("hold");
        expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
      }
    });
  }
}

for (const errors of ["malformed", [null], [["REJECTED", "not permitted", "field"]]]) {
  test(`reddit distinguishes explicit rejection from malformed errors ${JSON.stringify(errors)}`, async () => {
    let creates = 0;
    spies.push(
      spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/api/v1/access_token"))
          return json({ access_token: "token", expires_in: 3600 });
        creates++;
        return json({ json: { errors } });
      }),
    );
    const scenario = receiptCases.find((item) => item.platform === "reddit");
    if (!scenario) throw new Error("Reddit fixture missing");
    const result = await scenario.send();
    expect(creates).toBe(1);
    expect(result.success).toBe(false);
    const explicitRejection = Array.isArray(errors) && Array.isArray(errors[0]);
    expect(result.creditDisposition).toBe(explicitRejection ? undefined : "hold");
  });
}
/** Answers the Reddit token request and returns `submit` for /api/submit. */
function stubReddit(submit: () => Response): { submits: number } {
  const seen = { submits: 0 };
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v1/access_token")) {
        return json({ access_token: "token", expires_in: 3600 });
      }
      if (url.includes("/api/submit") && init?.method === "POST") {
        seen.submits += 1;
        return submit();
      }
      throw new Error(`unexpected request ${url}`);
    }),
  );
  return seen;
}

function redditSubmit() {
  return redditProvider.createPost(
    { apiKey: "id", apiSecret: "secret", username: "u", password: "p" },
    { text: "Launch day" },
    { reddit: { subreddit: "elizaos", title: "Launch day" } },
  );
}

for (const payload of [
  {},
  { json: { errors: [], data: null } },
  { json: { errors: [], data: { url: "/r/x/1" } } },
]) {
  test(`reddit keeps a malformed acknowledgement unknown: ${JSON.stringify(payload)}`, async () => {
    const seen = stubReddit(() => json(payload));
    const result = await redditSubmit();
    expect(seen.submits).toBe(1);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
    expect(result.creditDisposition).toBe("hold");
  });
}

test("an explicit Reddit refusal in a successful HTTP response remains refundable", async () => {
  const seen = stubReddit(() =>
    json({ json: { errors: [["NO_TEXT", "we need something here"]] } }),
  );
  const result = await redditSubmit();
  expect(seen.submits).toBe(1);
  expect(result.success).toBe(false);
  expect(result.creditDisposition).toBeUndefined();
});

test("reddit retains a confirmed publication receipt", async () => {
  const seen = stubReddit(() =>
    json({ json: { errors: [], data: { id: "abc", name: "t3_abc", url: "/r/elizaos/abc" } } }),
  );
  const result = await redditSubmit();
  expect(seen.submits).toBe(1);
  expect(result.success).toBe(true);
  expect(result.postId).toBe("abc");
  expect(result.creditDisposition).toBeUndefined();
});

test("twitter sends a like once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/likes", {
    "/users/me": () => json({ data: { id: "7" } }),
    create: () => json({ data: { liked: true } }),
  });

  const result = await twitterProvider.likePost({ accessToken: "token" }, "1");

  // The like timed out, so it was sent exactly once: X refuses a duplicate
  // like, and a replay would report the delivered like as a failure the
  // caller refunds.
  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
});

test("twitter sends /retweets once and reports the unknown outcome", async () => {
  const seen = stubPlatform("/retweets", {
    "/users/me": () => json({ data: { id: "7" } }),
    create: () => json({ data: { retweeted: true } }),
  });

  const result = await twitterProvider.repost({ accessToken: "token" }, "1");

  expect(seen.creates).toBe(1);
  expect(result.success).toBe(false);
  // The retweet may already exist: hold the credit, do not refund.
  expect(result.creditDisposition).toBe("hold");
  expect(result.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});
