/**
 * Exercises fail-closed GitHub boundaries, low-cost query shapes, adaptive
 * search primitives, and atomic write gating before live data is published.
 */

import { parse } from "graphql";
import { describe, expect, it, vi } from "vitest";
import type { GitHubActor, LeaderboardSnapshot } from "../src/lib/leaderboard";
import {
  buildUtcDaySlices,
  deriveCurrentHeadReviewDecision,
  deriveSourceUpdatedAt,
  estimateFirstPageDetailCost,
  GitHubGraphqlClient,
  type GraphqlExecutor,
  LEADERBOARD_QUERY_DOCUMENTS,
  resolveGitHubToken,
  runGenerator,
  SEARCH_SAFE_RESULT_LIMIT,
  sameReferenceSet,
} from "./generate-leaderboard";

function actor(login: string, kind: GitHubActor["kind"] = "User"): GitHubActor {
  return {
    id: `ACTOR_${login}`,
    login,
    avatarUrl: `https://avatars.example/${login}`,
    url: `https://github.com/${login}`,
    kind,
  };
}

function successResponse(
  data: Record<string, unknown> = { viewer: { login: "eliza" } },
  rateLimit: {
    cost: number;
    limit: number;
    remaining: number;
    resetAt: string;
  } = {
    cost: 1,
    limit: 5_000,
    remaining: 4_999,
    resetAt: "2026-07-30T13:00:00.000Z",
  },
): Response {
  return new Response(JSON.stringify({ data: { ...data, rateLimit } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function unusedClient(): GraphqlExecutor {
  return {
    execute: async () => {
      throw new Error("not used");
    },
    getRequestCount: () => 0,
    getRateLimit: () => ({
      cost: 0,
      consumedDuringRun: 0,
      limit: 5_000,
      remaining: 5_000,
      resetAt: "2026-07-30T13:00:00.000Z",
    }),
  };
}

describe("GitHub authentication", () => {
  it("uses GITHUB_TOKEN without invoking the gh fallback", async () => {
    const fallback = vi.fn(async () => "fallback-token");

    await expect(
      resolveGitHubToken({ GITHUB_TOKEN: " environment-token " }, fallback),
    ).resolves.toBe("environment-token");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("fails when the authenticated gh fallback fails", async () => {
    await expect(
      resolveGitHubToken({}, async () => {
        throw new Error("gh is not authenticated");
      }),
    ).rejects.toThrow("gh is not authenticated");
  });
});

describe("GitHub GraphQL boundary", () => {
  it("propagates GraphQL errors instead of returning empty data", async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          data: null,
          errors: [{ message: "API rate limit exceeded" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    const client = new GitHubGraphqlClient("secret-token", fetcher);

    await expect(client.execute("query { viewer { login } }")).rejects.toThrow(
      "GitHub GraphQL rejected the leaderboard query: API rate limit exceeded",
    );
  });

  it("retries transient gateway failures and records actual API cost", async () => {
    let attempts = 0;
    const fetcher = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        });
      }
      return successResponse();
    };
    const client = new GitHubGraphqlClient("secret-token", fetcher, {
      retryBaseDelayMs: 0,
    });

    await expect(
      client.execute("query { viewer { login } }"),
    ).resolves.toMatchObject({ viewer: { login: "eliza" } });
    expect(client.getRequestCount()).toBe(2);
    expect(client.getRateLimit().consumedDuringRun).toBe(1);
  });

  it("retries transient network failures before returning validated data", async () => {
    let attempts = 0;
    const fetcher = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new TypeError("socket disconnected");
      }
      return successResponse();
    };
    const client = new GitHubGraphqlClient("secret-token", fetcher, {
      retryBaseDelayMs: 0,
    });

    await expect(
      client.execute("query { viewer { login } }"),
    ).resolves.toMatchObject({ viewer: { login: "eliza" } });
    expect(attempts).toBe(3);
    expect(client.getRequestCount()).toBe(3);
  });

  it("aborts, retries, and fails closed when every request times out", async () => {
    let attempts = 0;
    const fetcher = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      attempts += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    };
    const client = new GitHubGraphqlClient("secret-token", fetcher, {
      requestTimeoutMs: 5,
      retryBaseDelayMs: 0,
    });

    await expect(client.execute("query { viewer { login } }")).rejects.toThrow(
      "timed out after 5ms (3/3)",
    );
    expect(attempts).toBe(3);
    expect(client.getRequestCount()).toBe(3);
  });

  it("stops before returning data that exceeds the run cost budget", async () => {
    let attempts = 0;
    const fetcher = async () => {
      attempts += 1;
      return successResponse(
        { viewer: { login: "eliza" } },
        {
          cost: 400,
          limit: 5_000,
          remaining: 5_000 - attempts * 400,
          resetAt: "2026-07-30T13:00:00.000Z",
        },
      );
    };
    const client = new GitHubGraphqlClient("secret-token", fetcher, {
      maxGenerationCost: 750,
      minimumRateLimitReserve: 0,
    });

    await expect(
      client.execute("query { viewer { login } }"),
    ).resolves.toBeDefined();
    await expect(client.execute("query { viewer { login } }")).rejects.toThrow(
      "safety budget exceeded (800/750 points consumed",
    );
  });

  it("adapts its run cap to a 1,000-point Actions token", async () => {
    let attempts = 0;
    const fetcher = async () => {
      attempts += 1;
      return successResponse(
        { viewer: { login: "eliza" } },
        {
          cost: 450,
          limit: 1_000,
          remaining: 1_000 - attempts * 450,
          resetAt: "2026-07-30T13:00:00.000Z",
        },
      );
    };
    const client = new GitHubGraphqlClient("actions-token", fetcher, {
      retryBaseDelayMs: 0,
    });

    await expect(
      client.execute("query { viewer { login } }"),
    ).resolves.toBeDefined();
    await expect(
      client.execute("query { viewer { login } }"),
    ).resolves.toBeDefined();
    await expect(client.execute("query { viewer { login } }")).rejects.toThrow(
      "900/900 points consumed",
    );
    expect(attempts).toBe(2);
  });

  it("does not call the writer after live generation fails", async () => {
    const write = vi.fn(async (_snapshot: LeaderboardSnapshot) => undefined);
    const generate = vi.fn(async () => {
      throw new Error("GitHub connection failed");
    });

    await expect(
      runGenerator("/tmp/should-not-exist.json", {
        getToken: async () => "token",
        createClient: unusedClient,
        generate,
        write,
      }),
    ).rejects.toThrow("GitHub connection failed");
    expect(write).not.toHaveBeenCalled();
  });
});

describe("rate-efficient query plan", () => {
  it("parses every production GraphQL document", () => {
    for (const [name, document] of Object.entries(
      LEADERBOARD_QUERY_DOCUMENTS,
    )) {
      expect(() => parse(document), name).not.toThrow();
    }
  });

  it("keeps search and open listings free of nested item connections", () => {
    for (const document of [
      LEADERBOARD_QUERY_DOCUMENTS.searchReferences,
      LEADERBOARD_QUERY_DOCUMENTS.openIssueReferences,
      LEADERBOARD_QUERY_DOCUMENTS.openPullRequestReferences,
    ]) {
      for (const forbiddenConnection of [
        "assignees(",
        "comments(",
        "files(",
        "labels(",
        "reviews(",
        "closingIssuesReferences(",
        "closedByPullRequestsReferences(",
      ]) {
        expect(document).not.toContain(forbiddenConnection);
      }
    }
  });

  it("loads bounded detail batches and review comments in separate queries", () => {
    expect(LEADERBOARD_QUERY_DOCUMENTS.searchReferences).toContain("mergedAt");
    expect(LEADERBOARD_QUERY_DOCUMENTS.searchReferences).toContain("additions");
    for (const forbiddenConnection of [
      "assignees(",
      "comments(",
      "files(",
      "labels(",
      "reviews(",
    ]) {
      expect(LEADERBOARD_QUERY_DOCUMENTS.searchReferences).not.toContain(
        forbiddenConnection,
      );
    }
    expect(LEADERBOARD_QUERY_DOCUMENTS.pullRequestDetails).toContain(
      "nodes(ids: $ids)",
    );
    expect(LEADERBOARD_QUERY_DOCUMENTS.issueDetails).toContain(
      "nodes(ids: $ids)",
    );
    expect(LEADERBOARD_QUERY_DOCUMENTS.pullRequestDetails).toContain(
      "reviews(first: 100)",
    );
    expect(LEADERBOARD_QUERY_DOCUMENTS.pullRequestDetails).toContain(
      "headRefOid",
    );
    expect(LEADERBOARD_QUERY_DOCUMENTS.pullRequestDetails).toContain(
      "commit { oid }",
    );
    expect(LEADERBOARD_QUERY_DOCUMENTS.moreReviews).toContain("headRefOid");
    expect(LEADERBOARD_QUERY_DOCUMENTS.openPullRequestReferences).toContain(
      "nodes { id updatedAt headRefOid }",
    );
    expect(LEADERBOARD_QUERY_DOCUMENTS.pullRequestDetails).not.toMatch(
      /author\s*\{[^}]+}\s*comments\s*\{/,
    );
    expect(LEADERBOARD_QUERY_DOCUMENTS.reviewInlineComments).toContain(
      "comments(first: 100)",
    );
  });

  it("estimates normalized first-page connection costs by detail batch", () => {
    expect(estimateFirstPageDetailCost(0, 0)).toBe(0);
    expect(estimateFirstPageDetailCost(25, 25)).toBe(3);
    expect(estimateFirstPageDetailCost(26, 0)).toBe(3);
    expect(() => estimateFirstPageDetailCost(-1, 0)).toThrow(
      "non-negative integers",
    );
  });

  it("invalidates an open snapshot when a node changes version", () => {
    const before = [
      {
        id: "PR_1",
        kind: "PullRequest" as const,
        outcome: null,
        openVersion: `2026-07-30T10:00:00.000Z:${"a".repeat(40)}`,
      },
    ];
    expect(sameReferenceSet(before, structuredClone(before))).toBe(true);
    expect(
      sameReferenceSet(before, [
        {
          ...before[0],
          openVersion: `2026-07-30T10:01:00.000Z:${"b".repeat(40)}`,
        },
      ]),
    ).toBe(false);
  });
});

describe("current-head review selection", () => {
  it("ignores stale-head, bot, and self reviews while honoring each reviewer's latest state", () => {
    const head = "a".repeat(40);
    const previousHead = "b".repeat(40);
    const author = actor("author");
    const reviewer = actor("reviewer");
    const secondReviewer = actor("second-reviewer");
    const reviews = [
      {
        id: "REVIEW_STALE_CHANGES",
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-30T10:00:00.000Z",
        commitId: previousHead,
        author: reviewer,
      },
      {
        id: "REVIEW_CURRENT_APPROVAL",
        state: "APPROVED",
        submittedAt: "2026-07-30T11:00:00.000Z",
        commitId: head,
        author: secondReviewer,
      },
      {
        id: "REVIEW_BOT_CHANGES",
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-30T12:00:00.000Z",
        commitId: head,
        author: actor("review-bot", "Bot"),
      },
      {
        id: "REVIEW_SELF_CHANGES",
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-30T12:30:00.000Z",
        commitId: head,
        author,
      },
    ];

    expect(deriveCurrentHeadReviewDecision(head, author, reviews)).toBe(
      "APPROVED",
    );
    expect(
      deriveCurrentHeadReviewDecision(head, author, [
        ...reviews,
        {
          id: "REVIEW_CURRENT_CHANGES",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-07-30T13:00:00.000Z",
          commitId: head,
          author: reviewer,
        },
      ]),
    ).toBe("CHANGES_REQUESTED");
    expect(
      deriveCurrentHeadReviewDecision(head, author, [
        ...reviews,
        {
          id: "REVIEW_APPROVAL_SUPERSEDED",
          state: "COMMENTED",
          submittedAt: "2026-07-30T14:00:00.000Z",
          commitId: head,
          author: secondReviewer,
        },
      ]),
    ).toBe("APPROVED");
    expect(
      deriveCurrentHeadReviewDecision(head, author, [
        {
          id: "REVIEW_CHANGES_BEFORE_DISMISSAL",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-07-30T13:00:00.000Z",
          commitId: head,
          author: reviewer,
        },
        {
          id: "REVIEW_DISMISSED",
          state: "DISMISSED",
          submittedAt: "2026-07-30T14:00:00.000Z",
          commitId: head,
          author: reviewer,
        },
      ]),
    ).toBeNull();
  });

  it("rejects a malformed head revision", () => {
    expect(() =>
      deriveCurrentHeadReviewDecision("not-a-full-sha", actor("author"), []),
    ).toThrow("full commit SHA");
  });

  it("fails closed for deleted reviewers and same-timestamp decisions", () => {
    const head = "a".repeat(40);
    const submittedAt = "2026-07-30T10:00:00.000Z";
    const reviewer = actor("reviewer");
    expect(
      deriveCurrentHeadReviewDecision(head, actor("author"), [
        {
          id: "REVIEW_GHOST_APPROVAL",
          state: "APPROVED",
          submittedAt,
          commitId: head,
          author: null,
        },
      ]),
    ).toBe("APPROVED");
    expect(
      deriveCurrentHeadReviewDecision(head, actor("author"), [
        {
          id: "REVIEW_GHOST_CHANGES",
          state: "CHANGES_REQUESTED",
          submittedAt,
          commitId: head,
          author: null,
        },
        {
          id: "REVIEW_OTHER_GHOST_APPROVAL",
          state: "APPROVED",
          submittedAt: "2026-07-30T11:00:00.000Z",
          commitId: head,
          author: null,
        },
      ]),
    ).toBe("CHANGES_REQUESTED");
    const tiedReviews = [
      {
        id: "REVIEW_TIED_APPROVAL",
        state: "APPROVED",
        submittedAt,
        commitId: head,
        author: reviewer,
      },
      {
        id: "REVIEW_TIED_CHANGES",
        state: "CHANGES_REQUESTED",
        submittedAt,
        commitId: head,
        author: reviewer,
      },
    ];
    expect(
      deriveCurrentHeadReviewDecision(head, actor("author"), tiedReviews),
    ).toBe("CHANGES_REQUESTED");
    expect(
      deriveCurrentHeadReviewDecision(
        head,
        actor("author"),
        tiedReviews.toReversed(),
      ),
    ).toBe("CHANGES_REQUESTED");
  });

  it("rejects malformed non-null review commit revisions", () => {
    expect(() =>
      deriveCurrentHeadReviewDecision("a".repeat(40), actor("author"), [
        {
          id: "REVIEW_MALFORMED_COMMIT",
          state: "APPROVED",
          submittedAt: "2026-07-30T10:00:00.000Z",
          commitId: "short-sha",
          author: actor("reviewer"),
        },
      ]),
    ).toThrow(
      "Review REVIEW_MALFORMED_COMMIT commitId must be a full commit SHA",
    );
  });

  it("rejects decision reviews without enough current-head provenance", () => {
    const head = "a".repeat(40);
    const base = {
      id: "REVIEW_INCOMPLETE",
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-07-30T10:00:00.000Z" as string | null,
      commitId: head as string | null,
      author: actor("reviewer"),
    };
    expect(() =>
      deriveCurrentHeadReviewDecision(head, actor("author"), [
        { ...base, commitId: null },
      ]),
    ).toThrow("cannot prove a current-head CHANGES_REQUESTED decision");
    expect(() =>
      deriveCurrentHeadReviewDecision(head, actor("author"), [
        { ...base, submittedAt: null },
      ]),
    ).toThrow("cannot prove a current-head CHANGES_REQUESTED decision");
  });
});

describe("rolling-window slicing", () => {
  it("splits a rolling range at UTC day boundaries", () => {
    const slices = buildUtcDaySlices(
      new Date("2026-07-28T12:34:56.000Z"),
      new Date("2026-07-30T01:02:03.000Z"),
    );

    expect(slices).toEqual([
      {
        from: new Date("2026-07-28T12:34:56.000Z"),
        to: new Date("2026-07-29T00:00:00.000Z"),
      },
      {
        from: new Date("2026-07-29T00:00:00.000Z"),
        to: new Date("2026-07-30T00:00:00.000Z"),
      },
      {
        from: new Date("2026-07-30T00:00:00.000Z"),
        to: new Date("2026-07-30T01:02:03.000Z"),
      },
    ]);
    expect(SEARCH_SAFE_RESULT_LIMIT).toBeLessThan(1_000);
  });

  it("uses the latest record update instead of the collection cutoff", () => {
    expect(
      deriveSourceUpdatedAt(
        [
          { updatedAt: "2026-07-20T00:00:00.000Z" },
          { updatedAt: "2026-07-29T10:00:00.000Z" },
          { updatedAt: "2026-07-25T00:00:00.000Z" },
        ],
        "2026-07-30T00:00:00.000Z",
      ),
    ).toBe("2026-07-29T10:00:00.000Z");
    expect(deriveSourceUpdatedAt([], "2026-07-28T00:00:00.000Z")).toBe(
      "2026-07-28T00:00:00.000Z",
    );
  });
});
