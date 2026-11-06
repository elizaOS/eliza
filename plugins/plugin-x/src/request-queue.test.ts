/**
 * Real `ClientBase.requestQueue` coverage: a swallowed wrapper catch used to
 * reject `add()` on the first failure and skip retry/backoff. The queue now
 * retries, then rejects only after the budget is exhausted.
 */
import { Agent as HttpsAgent } from "node:https";
import { connect, createServer, type Socket } from "node:net";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { ApiRequestError, TwitterApi } from "twitter-api-v2";
import { describe, expect, it } from "vitest";
import {
  ClientBase,
  NO_REQUEST_RETRY,
  RETRY_TRANSIENT_X_READ,
  RequestQueue,
} from "./base";
import type { TwitterAuth } from "./client/auth";
import { getTweet } from "./client/tweets";
import type { TwitterClientState } from "./types";
import {
  normalizeTwitterProviderError,
  TwitterError,
  TwitterErrorType,
} from "./utils/error-handler";

function makeClient(): ClientBase {
  const client = new ClientBase(
    {
      agentId: "00000000-0000-0000-0000-000000000001",
      character: { name: "Agent" },
      getSetting: () => undefined,
    } as unknown as IAgentRuntime,
    { accountId: "default" } as TwitterClientState,
  );
  client.requestQueue = new RequestQueue({
    backoff: async () => undefined,
    jitter: async () => undefined,
  });
  return client;
}

describe("RequestQueue retries provider failures", () => {
  it("retries a failed request and resolves when a later attempt succeeds", async () => {
    const client = makeClient();
    let calls = 0;
    await expect(
      client.requestQueue.add(async () => {
        calls += 1;
        if (calls < 2) {
          throw new TwitterError(
            TwitterErrorType.RATE_LIMIT,
            "HTTP 429 rate limited",
          );
        }
        return "ok";
      }, RETRY_TRANSIENT_X_READ),
    ).resolves.toBe("ok");
    expect(calls).toBe(2);
  }, 20_000);

  it("rejects after the retry budget instead of hanging or skipping", async () => {
    const client = makeClient();
    let calls = 0;
    await expect(
      client.requestQueue.add(async () => {
        calls += 1;
        throw new TwitterError(
          TwitterErrorType.RATE_LIMIT,
          "HTTP 429 rate limited",
        );
      }, RETRY_TRANSIENT_X_READ),
    ).rejects.toThrow("HTTP 429 rate limited");
    expect(calls).toBe(3);
  }, 20_000);

  it("still resolves a first-try success without extra attempts", async () => {
    const client = makeClient();
    let calls = 0;
    await expect(
      client.requestQueue.add(async () => {
        calls += 1;
        return 42;
      }),
    ).resolves.toBe(42);
    expect(calls).toBe(1);
  });

  it("retries an explicitly retryable read only for a typed transient failure", async () => {
    const queue = new RequestQueue({
      backoff: async () => undefined,
      jitter: async () => undefined,
    });
    let calls = 0;

    await expect(
      queue.add(async () => {
        calls += 1;
        if (calls === 1) {
          throw new TwitterError(
            TwitterErrorType.RATE_LIMIT,
            "X read was rate limited",
          );
        }
        return "ok";
      }, RETRY_TRANSIENT_X_READ),
    ).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("finds a typed transient provider failure through a contextual cause chain", async () => {
    const queue = new RequestQueue({
      backoff: async () => undefined,
      jitter: async () => undefined,
    });
    let calls = 0;

    await expect(
      queue.add(async () => {
        calls += 1;
        if (calls === 1) {
          throw new ElizaError("X search failed", {
            code: "X_SEARCH_FAILED",
            cause: new TwitterError(
              TwitterErrorType.NETWORK,
              "provider connection failed",
            ),
          });
        }
        return "ok";
      }, RETRY_TRANSIENT_X_READ),
    ).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries a twitter-api-v2 read whose connection was reset before a response", async () => {
    // A local socket stands in for api.x.com: the first connection is reset
    // before any HTTP response, the second one answers with the tweet.
    const body = JSON.stringify({ data: { id: "1", text: "hello" } });
    let connections = 0;
    const server = createServer((socket: Socket) => {
      connections += 1;
      if (connections === 1) {
        socket.resetAndDestroy();
        return;
      }
      socket.once("data", () => {
        socket.end(
          `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    class LocalAgent extends HttpsAgent {
      override createConnection(): Socket {
        return connect(port, "127.0.0.1");
      }
    }
    const api = new TwitterApi("bearer-token", {
      httpAgent: new LocalAgent(),
    });
    const auth = { getV2Client: async () => api } as unknown as TwitterAuth;
    const queue = new RequestQueue({
      backoff: async () => undefined,
      jitter: async () => undefined,
    });

    try {
      await expect(
        queue.add(() => getTweet("1", auth), RETRY_TRANSIENT_X_READ),
      ).resolves.toMatchObject({ id: "1", text: "hello" });
      expect(connections).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("leaves a twitter-api-v2 request error without a transient network code untyped", () => {
    // twitter-api-v2 builds this error when its own request timeout fires.
    const timedOut = new ApiRequestError("Request failed.", {
      request: undefined as never,
      error: new Error("Request timeout."),
    });

    expect(normalizeTwitterProviderError(timedOut)).toBeNull();
  });

  it("does not retry an untyped error that merely resembles a transient failure", async () => {
    const queue = new RequestQueue({
      backoff: async () => undefined,
      jitter: async () => undefined,
    });
    let calls = 0;

    await expect(
      queue.add(async () => {
        calls += 1;
        throw new Error("HTTP 429 rate limited");
      }, RETRY_TRANSIENT_X_READ),
    ).rejects.toThrow("HTTP 429 rate limited");
    expect(calls).toBe(1);
  });

  it.each([TwitterErrorType.AUTH, TwitterErrorType.VALIDATION])(
    "does not retry a permanent %s failure even for a read",
    async (errorType) => {
      const queue = new RequestQueue({
        backoff: async () => undefined,
        jitter: async () => undefined,
      });
      let calls = 0;

      await expect(
        queue.add(async () => {
          calls += 1;
          throw new TwitterError(errorType, `permanent ${errorType} failure`);
        }, RETRY_TRANSIENT_X_READ),
      ).rejects.toThrow(`permanent ${errorType} failure`);
      expect(calls).toBe(1);
    },
  );

  it("never replays a quote-tweet write after an ambiguous accepted-then-throw failure", async () => {
    const queue = new RequestQueue({
      backoff: async () => undefined,
      jitter: async () => undefined,
    });
    let publicPosts = 0;

    await expect(
      queue.add(async () => {
        publicPosts += 1;
        throw new TwitterError(
          TwitterErrorType.NETWORK,
          "connection reset after provider acceptance",
        );
      }, NO_REQUEST_RETRY),
    ).rejects.toThrow("connection reset after provider acceptance");
    expect(publicPosts).toBe(1);
  });

  it("fails closed when no retry policy is supplied", async () => {
    const queue = new RequestQueue({
      backoff: async () => undefined,
      jitter: async () => undefined,
    });
    let calls = 0;

    await expect(
      queue.add(async () => {
        calls += 1;
        throw new TwitterError(
          TwitterErrorType.RATE_LIMIT,
          "unclassified operation",
        );
      }),
    ).rejects.toThrow("unclassified operation");
    expect(calls).toBe(1);
  });

  it("rejects the affected read and continues the queue when retry scheduling fails", async () => {
    const queue = new RequestQueue({
      backoff: async () => {
        throw new Error("backoff unavailable");
      },
      jitter: async () => undefined,
    });

    const failedRead = queue.add(async () => {
      throw new TwitterError(TwitterErrorType.NETWORK, "transient read");
    }, RETRY_TRANSIENT_X_READ);
    const followingRead = queue.add(async () => "next", RETRY_TRANSIENT_X_READ);

    await expect(
      Promise.race([
        failedRead,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("queue stalled")), 100),
        ),
      ]),
    ).rejects.toMatchObject({ code: "X_REQUEST_RETRY_DELAY_FAILED" });
    await expect(followingRead).resolves.toBe("next");
  });

  it("rejects pending callers when queue pacing cannot be enforced", async () => {
    const queue = new RequestQueue({
      backoff: async () => undefined,
      jitter: async () => {
        throw new Error("pacing unavailable");
      },
    });

    const firstRead = queue.add(async () => "first", RETRY_TRANSIENT_X_READ);
    const pendingRead = queue.add(
      async () => "must not dispatch",
      RETRY_TRANSIENT_X_READ,
    );

    await expect(firstRead).resolves.toBe("first");
    await expect(pendingRead).rejects.toMatchObject({
      code: "X_REQUEST_PACING_DELAY_FAILED",
    });
  });
});
