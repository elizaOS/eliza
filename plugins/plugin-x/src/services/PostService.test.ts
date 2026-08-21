/** Verifies post effects, identity attribution, and fail-closed provider boundaries through deterministic X client fakes. */
import type { UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientBase,
  TwitterAccountSession,
  TwitterProfile,
} from "../base";
import { TwitterPostService } from "./PostService";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000002" as UUID;

const CURRENT_PROFILE: TwitterProfile = {
  id: "account-b",
  username: "current-b",
  screenName: "Current B",
  bio: "",
  nicknames: [],
};

function withSession(
  profile: TwitterProfile,
  client: object,
): Pick<
  ClientBase,
  "withAuthenticatedSession" | "isAuthenticatedSessionCurrent"
> {
  const session = { client, profile, revision: 2 } as TwitterAccountSession;
  return {
    withAuthenticatedSession: async (operation) => operation(session),
    isAuthenticatedSessionCurrent: () => true,
  };
}

describe("TwitterPostService", () => {
  const unlikeTweet = vi.fn();
  const unretweet = vi.fn();
  let service: TwitterPostService;

  beforeEach(() => {
    unlikeTweet.mockReset();
    unretweet.mockReset();
    service = new TwitterPostService({
      twitterClient: {
        unlikeTweet,
        unretweet,
      },
    } as unknown as ClientBase);
  });

  it("unlikes posts through the Twitter client", async () => {
    await service.unlikePost("tweet-1", AGENT_ID);

    expect(unlikeTweet).toHaveBeenCalledWith("tweet-1");
  });

  it("removes reposts through the Twitter client", async () => {
    await service.unrepost("tweet-2", AGENT_ID);

    expect(unretweet).toHaveBeenCalledWith("tweet-2");
  });

  it("reports and rejects getPosts provider failures", async () => {
    const providerError = new Error("twitter 429 rate limited");
    const reportError = vi.fn();
    const getUserTweets = vi.fn().mockRejectedValue(providerError);
    const failing = new TwitterPostService({
      runtime: { reportError },
      twitterClient: { getUserTweets },
    } as unknown as ClientBase);

    await expect(
      failing.getPosts({
        agentId: AGENT_ID,
        userId: "123",
        limit: 5,
      }),
    ).rejects.toBe(providerError);
    expect(reportError).toHaveBeenCalledWith(
      "XPostService.getPosts",
      providerError,
    );
  });

  it("keeps a legitimate empty provider result distinct from failure", async () => {
    const reportError = vi.fn();
    const getUserTweets = vi.fn(async () => ({ tweets: [] }));
    const empty = new TwitterPostService({
      runtime: { reportError },
      twitterClient: { getUserTweets },
    } as unknown as ClientBase);

    await expect(
      empty.getPosts({
        agentId: AGENT_ID,
        userId: "123",
        limit: 5,
      }),
    ).resolves.toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports and rejects mention provider failures", async () => {
    const providerError = new Error("search transport unavailable");
    const reportError = vi.fn();
    const fetchSearchTweets = vi.fn().mockRejectedValue(providerError);
    const failing = new TwitterPostService({
      runtime: { reportError },
      ...withSession(CURRENT_PROFILE, {}),
      fetchSearchTweets,
    } as unknown as ClientBase);

    await expect(failing.getMentions(AGENT_ID)).rejects.toBe(providerError);
    expect(reportError).toHaveBeenCalledWith(
      "XPostService.getMentions",
      providerError,
    );
  });

  it("uses the admitted profile for created-post attribution", async () => {
    const sendTweet = vi.fn(async () => ({ data: { id: "tweet-b" } }));
    const sessionBoundary = withSession(CURRENT_PROFILE, {});
    const withAuthenticatedSession = vi.spyOn(
      sessionBoundary,
      "withAuthenticatedSession",
    );
    const current = new TwitterPostService({
      profile: { id: "account-a", username: "stale-a" },
      ...sessionBoundary,
      twitterClient: { sendTweet },
    } as unknown as ClientBase);

    const post = await current.createPost({
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      text: "hello from b",
    });

    expect(withAuthenticatedSession).toHaveBeenCalledOnce();
    expect(post).toMatchObject({
      id: "tweet-b",
      userId: "account-b",
      username: "current-b",
    });
  });

  it("routes quote posts through the dedicated quote request", async () => {
    const sendTweet = vi.fn();
    const sendQuoteTweet = vi.fn(async () => ({ data: { id: "quote-b" } }));
    const current = new TwitterPostService({
      ...withSession(CURRENT_PROFILE, {}),
      twitterClient: { sendTweet, sendQuoteTweet },
    } as unknown as ClientBase);

    const post = await current.createPost({
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      text: "why this post matters",
      quotedPostId: "source-post-1",
    });

    expect(sendQuoteTweet).toHaveBeenCalledWith(
      "why this post matters",
      "source-post-1",
    );
    expect(sendTweet).not.toHaveBeenCalled();
    expect(post).toMatchObject({
      id: "quote-b",
      quotedPostId: "source-post-1",
    });
  });

  it("surfaces an accepted post without a receipt as non-retriable and indeterminate", async () => {
    const sendTweet = vi.fn(async () => ({ data: { id: "   " } }));
    const current = new TwitterPostService({
      accountId: "default",
      ...withSession(CURRENT_PROFILE, {}),
      twitterClient: { sendTweet },
    } as unknown as ClientBase);

    await expect(
      current.createPost({
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        text: "provider accepted this request",
      }),
    ).rejects.toMatchObject({
      code: "X_POST_RECEIPT_INDETERMINATE",
      context: {
        accountId: "default",
        providerAccepted: true,
        retrySafe: false,
      },
    });
    expect(sendTweet).toHaveBeenCalledOnce();
  });

  it("queries mentions with the admitted username", async () => {
    const fetchSearchTweets = vi.fn(async () => ({ tweets: [] }));
    const current = new TwitterPostService({
      profile: { id: "account-a", username: "stale-a" },
      runtime: { reportError: vi.fn() },
      ...withSession(CURRENT_PROFILE, {}),
      fetchSearchTweets,
    } as unknown as ClientBase);

    await current.getMentions(AGENT_ID);

    expect(fetchSearchTweets).toHaveBeenCalledWith(
      "@current-b",
      20,
      expect.anything(),
      undefined,
    );
  });

  it("refuses a post when the caller profile and admitted session differ", async () => {
    const sendTweet = vi.fn();
    const current = new TwitterPostService({
      ...withSession(CURRENT_PROFILE, {}),
      twitterClient: { sendTweet },
    } as unknown as ClientBase);

    await expect(
      current.createPost(
        {
          agentId: AGENT_ID,
          roomId: ROOM_ID,
          text: "must not cross accounts",
        },
        { ...CURRENT_PROFILE, id: "account-a" },
      ),
    ).rejects.toMatchObject({ code: "X_AUTH_SESSION_ROTATED" });
    expect(sendTweet).not.toHaveBeenCalled();
  });

  it("aborts publication when the second requested media upload fails", async () => {
    const uploadFailure = new Error("second upload rejected");
    const uploadMedia = vi
      .fn()
      .mockResolvedValueOnce("media-1")
      .mockRejectedValueOnce(uploadFailure);
    const sendTweet = vi.fn();
    const current = new TwitterPostService({
      ...withSession(CURRENT_PROFILE, {}),
      twitterClient: { uploadMedia, sendTweet },
    } as unknown as ClientBase);

    await expect(
      current.createPost({
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        text: "both attachments are required",
        media: [
          { data: Buffer.from("first"), type: "image/png" },
          { data: Buffer.from("second"), type: "image/jpeg" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "X_MEDIA_UPLOAD_FAILED",
      cause: uploadFailure,
    });
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(sendTweet).not.toHaveBeenCalled();
  });
});
