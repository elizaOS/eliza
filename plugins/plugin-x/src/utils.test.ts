/** Verifies accepted X sends remain single-shot while account-bound cursor and cache receipts stay monotonic across rotation. */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ClientBase, type TwitterProfile } from "./base";
import type { TwitterClientState } from "./types";
import { sendChunkedTweet, sendTweet } from "./utils";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function profile(id: string): TwitterProfile {
  return {
    id,
    username: id,
    screenName: id,
    bio: "",
    nicknames: [],
  };
}

describe("sendTweet", () => {
  it("does not advance the mention cursor when publishing an outgoing tweet", async () => {
    // Regression for #22433: an outgoing post must never move the incoming
    // mention cursor (`lastCheckedTweetId`). The published tweet always carries
    // the newest snowflake id, so advancing the cursor here would silently skip
    // every unprocessed @mention older than this post.
    const authenticatedProfile = profile("account-a");
    const setCache = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getCache: vi.fn(async () => undefined),
      setCache,
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const client = new ClientBase(runtime, {} as TwitterClientState);
    // A mention arrived earlier and the interactions loop has already advanced
    // the cursor to it. The outgoing post below carries a strictly newer id.
    const pendingMentionCursor = 1_000_000_000_000_000_500n;
    client.profile = authenticatedProfile;
    client.recordLatestCheckedTweetId(
      authenticatedProfile.id,
      pendingMentionCursor,
    );
    const send = vi.fn().mockResolvedValue({
      data: { data: { id: "1000000000000001000", text: "gm" } },
    });
    client.twitterClient = {
      sendTweet: send,
    } as unknown as ClientBase["twitterClient"];
    client.withAuthenticatedSession = async (operation) =>
      operation({
        client: {} as never,
        profile: authenticatedProfile,
        revision: 1,
      });
    client.isAuthenticatedSessionCurrent = () => true;

    await expect(sendTweet(client, "gm")).resolves.toMatchObject({
      id: "1000000000000001000",
      text: "gm",
    });
    expect(send).toHaveBeenCalledTimes(1);
    // The cursor is unchanged even though the published id is much newer.
    expect(client.getLatestCheckedTweetId(authenticatedProfile.id)).toBe(
      pendingMentionCursor,
    );
    // No cursor persistence write happened for the outgoing publish.
    expect(
      setCache.mock.calls.some(([key]) =>
        String(key).endsWith("latest_checked_tweet_id"),
      ),
    ).toBe(false);
    // The tweet itself is still cached for later reference.
    expect(setCache).toHaveBeenCalledWith(
      "twitter/tweets/1000000000000001000",
      expect.objectContaining({
        id: "1000000000000001000",
        userId: "account-a",
        username: "account-a",
      }),
    );
  });

  it("leaves a null mention cursor untouched after publishing", async () => {
    // With no prior mention checkpoint, a send must not seed the cursor either;
    // the interactions loop, not the poster, owns the very first checkpoint.
    const authenticatedProfile = profile("account-a");
    const setCache = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getCache: vi.fn(async () => undefined),
      setCache,
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const client = new ClientBase(runtime, {} as TwitterClientState);
    client.profile = authenticatedProfile;
    expect(client.getLatestCheckedTweetId(authenticatedProfile.id)).toBeNull();
    client.twitterClient = {
      sendTweet: vi.fn().mockResolvedValue({
        data: { data: { id: "1000000000000002000", text: "hello" } },
      }),
    } as unknown as ClientBase["twitterClient"];
    client.withAuthenticatedSession = async (operation) =>
      operation({
        client: {} as never,
        profile: authenticatedProfile,
        revision: 1,
      });
    client.isAuthenticatedSessionCurrent = () => true;

    await sendTweet(client, "hello");

    expect(client.getLatestCheckedTweetId(authenticatedProfile.id)).toBeNull();
    expect(
      setCache.mock.calls.some(([key]) =>
        String(key).endsWith("latest_checked_tweet_id"),
      ),
    ).toBe(false);
  });

  it("reports a local receipt failure without advancing the cursor when tweet caching fails", async () => {
    const authenticatedProfile = profile("account-a");
    const reportError = vi.fn();
    const setCache = vi.fn(async (key: string) => {
      if (key.startsWith("twitter/tweets/")) {
        throw new Error("cache unavailable");
      }
    });
    const runtime = {
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getCache: vi.fn(async () => undefined),
      setCache,
      reportError,
    } as unknown as IAgentRuntime;
    const client = new ClientBase(runtime, {} as TwitterClientState);
    const send = vi.fn().mockResolvedValue({
      data: { data: { id: "123", text: "hello" } },
    });
    client.profile = authenticatedProfile;
    client.twitterClient = {
      sendTweet: send,
    } as unknown as ClientBase["twitterClient"];
    client.withAuthenticatedSession = async (operation) =>
      operation({
        client: {} as never,
        profile: authenticatedProfile,
        revision: 1,
      });
    client.isAuthenticatedSessionCurrent = () => true;

    await expect(sendTweet(client, "hello")).resolves.toMatchObject({
      id: "123",
      text: "hello",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "X.sendTweet.localReceipt",
      expect.any(Error),
      { accountId: "default", tweetId: "123" },
    );
    // Even on the failure path the cursor stays untouched.
    expect(client.getLatestCheckedTweetId(authenticatedProfile.id)).toBeNull();
  });

  it("does not let a delayed account A receipt overwrite account B's cursor", async () => {
    const accepted = deferred<{
      data: { data: { id: string; text: string } };
    }>();
    const setCache = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      setCache,
      getCache: vi.fn(async () => undefined),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const client = new ClientBase(runtime, {} as TwitterClientState);
    const accountA = profile("account-a");
    const accountB = profile("account-b");
    client.profile = accountA;
    client.twitterClient = {
      sendTweet: vi.fn(() => accepted.promise),
    } as unknown as ClientBase["twitterClient"];
    client.withAuthenticatedSession = async (operation) =>
      operation({ client: {} as never, profile: accountA, revision: 1 });
    client.isAuthenticatedSessionCurrent = () => true;

    const pending = sendTweet(client, "sent by A");
    await vi.waitFor(() =>
      expect(client.twitterClient.sendTweet).toHaveBeenCalledOnce(),
    );

    client.profile = accountB;
    client.recordLatestCheckedTweetId(accountB.id, 50n);
    await client.cacheLatestCheckedTweetId(accountB);
    setCache.mockClear();
    accepted.resolve({ data: { data: { id: "100", text: "sent by A" } } });

    await expect(pending).resolves.toMatchObject({ id: "100" });
    expect(client.getLatestCheckedTweetId(accountB.id)).toBe(50n);
    expect(client.getLatestCheckedTweetId(accountA.id)).toBeNull();
    expect(
      setCache.mock.calls.some(([key]) =>
        String(key).endsWith("latest_checked_tweet_id"),
      ),
    ).toBe(false);
    expect(setCache).toHaveBeenCalledWith(
      "twitter/tweets/100",
      expect.objectContaining({
        id: "100",
        userId: "account-a",
        username: "account-a",
      }),
    );
  });

  it("never regresses a same-account cursor when sends settle out of order", () => {
    const runtime = {
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
    } as unknown as IAgentRuntime;
    const client = new ClientBase(runtime, {} as TwitterClientState);
    client.profile = profile("account-a");

    client.recordLatestCheckedTweetId("account-a", 102n);
    client.recordLatestCheckedTweetId("account-a", 101n);

    expect(client.getLatestCheckedTweetId("account-a")).toBe(102n);
  });

  it("keeps a chunked thread on one captured session and captured profile", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
      character: { name: "Agent" },
      getSetting: () => undefined,
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const client = new ClientBase(runtime, {} as TwitterClientState);
    const capturedProfile = {
      ...profile("account-a"),
      username: "captured-a",
    };
    const session = {
      client: {} as never,
      profile: capturedProfile,
      revision: 1,
    };
    let activeSession = false;
    let rootSessionCount = 0;
    client.withAuthenticatedSession = async (operation) => {
      if (activeSession) return operation(session);
      rootSessionCount += 1;
      activeSession = true;
      try {
        return await operation(session);
      } finally {
        activeSession = false;
      }
    };
    client.isAuthenticatedSessionCurrent = () => true;
    const send = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: { id: "201", text: "first" } } })
      .mockResolvedValueOnce({ data: { data: { id: "202", text: "second" } } });
    client.twitterClient = {
      sendTweet: send,
    } as unknown as ClientBase["twitterClient"];

    const memories = await sendChunkedTweet(
      client,
      { text: `${"a".repeat(280)}\n\n${"b".repeat(20)}` },
      "00000000-0000-0000-0000-000000000002" as UUID,
      "stale-caller-username",
      "parent",
    );

    expect(rootSessionCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[1]).toBe("parent");
    expect(send.mock.calls[1]?.[1]).toBe("201");
    expect(memories.map((memory) => memory.content.url)).toEqual([
      "https://x.com/captured-a/status/201",
      "https://x.com/captured-a/status/202",
    ]);
  });

  it("aborts a chunked thread before another egress when its captured session rotates", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
      character: { name: "Agent" },
      getSetting: () => undefined,
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => undefined),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const client = new ClientBase(runtime, {} as TwitterClientState);
    const session = {
      client: {} as never,
      profile: profile("account-a"),
      revision: 1,
    };
    let activeSession = false;
    client.withAuthenticatedSession = async (operation) => {
      if (activeSession) return operation(session);
      activeSession = true;
      try {
        return await operation(session);
      } finally {
        activeSession = false;
      }
    };
    let current = true;
    client.isAuthenticatedSessionCurrent = () => current;
    const send = vi.fn(async () => {
      current = false;
      return { data: { data: { id: "301", text: "first" } } };
    });
    client.twitterClient = {
      sendTweet: send,
    } as unknown as ClientBase["twitterClient"];

    await expect(
      sendChunkedTweet(
        client,
        { text: `${"a".repeat(280)}\n\n${"b".repeat(20)}` },
        "00000000-0000-0000-0000-000000000002" as UUID,
        "account-b",
        "parent",
      ),
    ).rejects.toMatchObject({ code: "X_AUTH_SESSION_ROTATED" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
