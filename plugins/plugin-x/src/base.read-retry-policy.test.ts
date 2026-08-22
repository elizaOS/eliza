import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientBase, RequestQueue, type TwitterProfile } from "./base";
import { SearchMode } from "./client";
import type { TwitterAuth } from "./client/auth";
import { getProfile } from "./client/profile";
import type { TwitterClientState } from "./types";
import { TwitterError, TwitterErrorType } from "./utils/error-handler";

const PROFILE = {
  userId: "user-1",
  username: "alice",
  name: "Alice",
  biography: "",
  location: "",
};

function makeClient() {
  const reportError = vi.fn();
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    character: { name: "Agent" },
    getSetting: () => undefined,
    getCache: vi.fn(async () => undefined),
    setCache: vi.fn(async () => true),
    reportError,
  } as unknown as IAgentRuntime;
  const client = new ClientBase(runtime, {
    accountId: "default",
  } as TwitterClientState);
  client.requestQueue = new RequestQueue({
    backoff: async () => undefined,
    jitter: async () => undefined,
  });
  return { client, reportError };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ClientBase typed read retry boundaries", () => {
  it.each([
    ["structured 429", { response: { status: 429 } }],
    [
      "network errno",
      Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
    ],
  ])(
    "retries a transient %s provider failure",
    async (_label, providerError) => {
      const { client } = makeClient();
      const getProfileMock = vi
        .fn()
        .mockRejectedValueOnce(providerError)
        .mockResolvedValue(PROFILE);
      client.twitterClient = {
        getProfile: getProfileMock,
      } as unknown as ClientBase["twitterClient"];

      await expect(client.fetchProfile("alice")).resolves.toMatchObject({
        id: "user-1",
      });
      expect(getProfileMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["authentication", { response: { status: 401 } }, TwitterErrorType.AUTH],
    ["validation", { response: { status: 400 } }, TwitterErrorType.VALIDATION],
  ])(
    "types and does not retry a structured %s failure",
    async (_label, providerError, errorType) => {
      const { client } = makeClient();
      const getProfileMock = vi.fn().mockRejectedValue(providerError);
      client.twitterClient = {
        getProfile: getProfileMock,
      } as unknown as ClientBase["twitterClient"];

      await expect(client.fetchProfile("alice")).rejects.toMatchObject({
        type: errorType,
      });
      expect(getProfileMock).toHaveBeenCalledOnce();
    },
  );

  it("does not retry arbitrary prose that resembles a rate limit", async () => {
    const { client } = makeClient();
    const getProfileMock = vi
      .fn()
      .mockRejectedValue(new Error("HTTP 429 rate limited"));
    client.twitterClient = {
      getProfile: getProfileMock,
    } as unknown as ClientBase["twitterClient"];

    await expect(client.fetchProfile("alice")).rejects.toThrow(
      "HTTP 429 rate limited",
    );
    expect(getProfileMock).toHaveBeenCalledOnce();
  });

  it("gives every provider retry its own timeout without overlapping a timed-out read", async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    const fetchSearchTweets = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () =>
                reject(
                  new TwitterError(
                    TwitterErrorType.NETWORK,
                    "temporary network failure",
                  ),
                ),
              10_000,
            );
          }),
      )
      .mockImplementationOnce(() => new Promise(() => undefined));
    client.twitterClient = {
      fetchSearchTweets,
    } as unknown as ClientBase["twitterClient"];

    const search = client.fetchSearchTweets("query", 10, SearchMode.Latest);
    let settled = false;
    void search.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSearchTweets).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(search).rejects.toMatchObject({ code: "X_SEARCH_TIMEOUT" });
    expect(fetchSearchTweets).toHaveBeenCalledTimes(2);
  });

  it("reports and throws an exhausted interactions read instead of returning an empty list", async () => {
    const { client, reportError } = makeClient();
    const providerError = new TwitterError(
      TwitterErrorType.AUTH,
      "credentials rejected",
    );
    client.twitterClient = {
      fetchSearchTweets: vi.fn().mockRejectedValue(providerError),
    } as unknown as ClientBase["twitterClient"];
    client.withAuthenticatedSession = vi.fn(async (operation) =>
      operation({
        profile: {
          id: "bot-1",
          username: "bot",
          screenName: "Bot",
          bio: "",
          nicknames: [],
        } satisfies TwitterProfile,
      } as never),
    );

    await expect(client.fetchInteractions()).rejects.toMatchObject({
      code: "X_INTERACTIONS_FAILED",
      cause: providerError,
    });
    expect(reportError).toHaveBeenCalledWith(
      "XClientBase.getInteractions",
      providerError,
    );
  });
});

describe("profile provider error preservation", () => {
  it("returns a typed error that retains the original structured provider failure", async () => {
    const providerError = { response: { status: 429 }, detail: "quota" };
    const auth = {
      getV2Client: vi.fn(async () => ({
        v2: {
          userByUsername: vi.fn().mockRejectedValue(providerError),
        },
      })),
    } as unknown as TwitterAuth;

    const result = await getProfile("alice", auth);

    expect(result).toMatchObject({
      success: false,
      err: {
        type: TwitterErrorType.RATE_LIMIT,
        originalError: providerError,
      },
    });
    if (!result.success) {
      expect(result.err).toBeInstanceOf(TwitterError);
    }
  });
});
