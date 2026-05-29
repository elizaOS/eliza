import { describe, expect, test } from "bun:test";
import { normalizeDecisionAction } from "../action-normalization";
import { extractFirstJsonObject } from "../decision-json";
import { MultiStepExecutor } from "../MultiStepExecutor";
import { normalizeSocialDecisionParameters } from "../social-parameter-normalization";
import { normalizeTradeDecisionParameters } from "../trade-parameter-normalization";

describe("normalizeDecisionAction", () => {
  test("preserves valid actions", () => {
    expect(normalizeDecisionAction("TRADE")).toBe("TRADE");
    expect(normalizeDecisionAction("reply_chat")).toBe("REPLY_CHAT");
  });

  test("selects the first valid action from combined labels", () => {
    expect(normalizeDecisionAction("TRADE | REPLY_CHAT")).toBe("TRADE");
    expect(
      normalizeDecisionAction("TRADE | REPLY_COMMENT | GROUP_MESSAGE | FINISH"),
    ).toBe("TRADE");
  });

  test("normalizes whitespace and hyphenated labels", () => {
    expect(normalizeDecisionAction("group message")).toBe("GROUP_MESSAGE");
    expect(normalizeDecisionAction("reply-chat")).toBe("REPLY_CHAT");
  });

  test("rescues short action aliases and unique prefixes", () => {
    expect(normalizeDecisionAction("TR")).toBe("TRADE");
    expect(normalizeDecisionAction("trad")).toBe("TRADE");
    expect(normalizeDecisionAction("POS")).toBe("POST");
  });
});

describe("normalizeTradeDecisionParameters", () => {
  const context = {
    predictionMarkets: [
      {
        id: "123456",
        question: "Will AIlon Musk ship FSD 14.0 by May 1, 2026?",
        yesPrice: 0.5,
        noPrice: 0.5,
        volume: 1000,
        endDate: "2026-05-01T00:00:00.000Z",
      },
    ],
    perpMarkets: [
      {
        ticker: "NVDAI",
        name: "NVIDAI",
        currentPrice: 1650,
        initialPrice: 1250,
        changePercent: 32,
      },
    ],
    agentPositions: {
      predictions: [
        {
          marketId: "123456",
          question: "Will AIlon Musk ship FSD 14.0 by May 1, 2026?",
          side: "NO",
          shares: 42,
          avgPrice: 0.61,
          currentPrice: 0.58,
          pnlPercent: -4.9,
          timeHeld: "2h",
          timeHeldMs: 7200000,
        },
      ],
      perps: [],
    },
  } as const;

  test("maps decorated perp labels back to tickers", () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: "perp",
          marketId: "NVDAI: NVIDAI @ $1650.00",
          side: "open_long",
        },
        context as never,
      ),
    ).toMatchObject({
      marketType: "perp",
      marketId: "NVDAI",
      side: "open_long",
    });
  });

  test("converts mislabeled prediction-style perp trades to perp semantics", () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: "prediction",
          marketId: "NVDAI: NVIDAI @ $1650.00",
          side: "buy_yes",
        },
        context as never,
      ),
    ).toMatchObject({
      marketType: "perp",
      marketId: "NVDAI",
      side: "open_long",
    });
  });

  test("resolves numeric prediction market ids from question-like text", () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: "prediction",
          marketId: "Will AIlon Musk ship FSD 14.0 by May 1, 2026?",
          side: "buy_yes",
        },
        context as never,
      ),
    ).toMatchObject({
      marketType: "prediction",
      marketId: "123456",
      side: "buy_yes",
    });
  });

  test("rescues slightly hallucinated numeric market ids when there is a unique near match", () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: "prediction",
          marketId: "123458",
          side: "buy_yes",
        },
        context as never,
      ),
    ).toMatchObject({
      marketType: "prediction",
      marketId: "123456",
      side: "buy_yes",
    });
  });

  test("removes noop trade sides instead of leaving executable garbage", () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: "prediction",
          marketId: "123456",
          side: "none",
        },
        context as never,
      ),
    ).toEqual({
      marketType: "prediction",
      marketId: "123456",
    });
  });

  test("reconciles sell side to the held prediction position side", () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: "prediction",
          marketId: "123456",
          side: "sell_yes",
        },
        context as never,
      ),
    ).toMatchObject({
      marketType: "prediction",
      marketId: "123456",
      side: "sell_no",
    });
  });

  test("normalizes market type aliases instead of preserving bogus values", () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: "perception",
          marketId: "123456",
          side: "sell_no",
        },
        context as never,
      ),
    ).toMatchObject({
      marketType: "prediction",
      marketId: "123456",
      side: "sell_no",
    });
  });

  test("rescues numeric market ids emitted as JSON numbers", () => {
    expect(
      normalizeTradeDecisionParameters(
        {
          marketType: "prediction",
          marketId: 123458,
          side: "buy_yes",
        },
        context as never,
      ),
    ).toMatchObject({
      marketType: "prediction",
      marketId: "123456",
      side: "buy_yes",
    });
  });
});

describe("normalizeSocialDecisionParameters", () => {
  const context = {
    recentPosts: [
      {
        id: "post-1",
        authorId: "user-1",
        authorName: "alpha",
        authorCanContact: true,
        content: "first post",
        commentCount: 4,
        likeCount: 10,
        repostCount: 1,
        timeAgo: "1m",
      },
      {
        id: "post-2",
        authorId: "user-2",
        authorName: "beta",
        authorCanContact: true,
        content: "second post",
        commentCount: 3,
        likeCount: 5,
        repostCount: 0,
        timeAgo: "2m",
        agentComment: "already replied",
      },
    ],
    pendingCommentReplies: [
      {
        id: "comment-1",
        postId: "post-1",
      },
    ],
    pendingChatMessages: [
      {
        chatId: "chat-1",
      },
    ],
    groupChats: [
      {
        id: "group-1",
      },
    ],
  } as const;

  test("fills comment targets from feed context when placeholder ids are provided", () => {
    expect(
      normalizeSocialDecisionParameters(
        "COMMENT",
        {
          postId: "none",
          parentCommentId: "none",
          content: "hello",
        },
        context as never,
        "agent-1",
      ),
    ).toMatchObject({
      postId: "post-1",
      content: "hello",
    });
  });

  test("maps ordinal reply references to pending comment ids and post ids", () => {
    expect(
      normalizeSocialDecisionParameters(
        "REPLY_COMMENT",
        {
          commentId: "1",
          postId: "none",
          content: "reply",
        },
        context as never,
        "agent-1",
      ),
    ).toMatchObject({
      commentId: "comment-1",
      postId: "post-1",
      content: "reply",
    });
  });

  test("fills DM and reply-chat ids from available context", () => {
    expect(
      normalizeSocialDecisionParameters(
        "DM",
        {
          recipientId: "none",
          content: "ping",
        },
        context as never,
        "agent-1",
      ),
    ).toMatchObject({
      recipientId: "user-1",
      content: "ping",
    });

    expect(
      normalizeSocialDecisionParameters(
        "REPLY_CHAT",
        {
          chatId: "none",
          content: "pong",
        },
        context as never,
        "agent-1",
      ),
    ).toMatchObject({
      chatId: "chat-1",
      content: "pong",
    });
  });

  test("does not fill DM ids from stale recent post authors", () => {
    expect(
      normalizeSocialDecisionParameters(
        "DM",
        {
          recipientId: "none",
          content: "ping",
        },
        {
          ...context,
          recentPosts: [
            {
              id: "post-stale",
              authorId: "stale-user",
              authorName: "stale",
              content: "old post",
              commentCount: 0,
              likeCount: 0,
              repostCount: 0,
              timeAgo: "1m",
              authorCanContact: false,
            },
          ],
        } as never,
        "agent-1",
      ),
    ).not.toHaveProperty("recipientId");
  });

  test("rescues numeric social ids emitted as JSON numbers", () => {
    expect(
      normalizeSocialDecisionParameters(
        "COMMENT",
        {
          postId: 1,
          content: "hello",
        },
        context as never,
        "agent-1",
      ),
    ).toMatchObject({
      postId: "post-1",
      content: "hello",
    });
  });
});

describe("extractFirstJsonObject", () => {
  test("extracts JSON from responses wrapped in think tags and code fences", () => {
    expect(
      extractFirstJsonObject(
        '<think>internal</think>\n```json\n{"action":"TRADE","isFinish":false,"parameters":{}}\n```',
      ),
    ).toBe('{"action":"TRADE","isFinish":false,"parameters":{}}');
  });

  test("returns null when no JSON object exists", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
  });
});

describe("getDecisionValidationError", () => {
  const executor = new MultiStepExecutor();
  const context = {
    predictionMarkets: [],
    perpMarkets: [],
    agentPositions: { predictions: [], perps: [] },
    recentPosts: [
      {
        id: "post-1",
        authorId: "user-1",
        authorName: "alpha",
        content: "first post",
        commentCount: 4,
        likeCount: 10,
        repostCount: 1,
        timeAgo: "1m",
        agentComment: "existing comment",
        agentLiked: true,
        agentReposted: true,
      },
    ],
    pendingCommentReplies: [],
    pendingChatMessages: [],
    groupChats: [],
    openPositions: 0,
  } as const;

  test("rejects duplicate social actions before direct execution", () => {
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      (executor as any).getDecisionValidationError(
        "COMMENT",
        { postId: "post-1", content: "new comment" },
        context,
      ),
    ).toContain("already made a top-level comment");

    expect(
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      (executor as any).getDecisionValidationError(
        "LIKE",
        { postId: "post-1" },
        context,
      ),
    ).toContain("already liked");

    expect(
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      (executor as any).getDecisionValidationError(
        "REPOST",
        { postId: "post-1" },
        context,
      ),
    ).toContain("already reposted");
  });

  test("builds a deterministic fallback action when parsing fails before any action", () => {
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      (executor as any).buildFallbackDecision(
        {
          predictionMarkets: [],
          perpMarkets: [],
          agentPositions: { predictions: [], perps: [] },
          recentPosts: [
            {
              id: "post-2",
              authorId: "user-2",
              authorName: "beta",
              content: "fresh post",
              commentCount: 0,
              likeCount: 0,
              repostCount: 0,
              timeAgo: "1m",
            },
          ],
          pendingCommentReplies: [
            {
              id: "comment-2",
              postId: "post-2",
            },
          ],
          pendingChatMessages: [],
          groupChats: [],
          openPositions: 0,
        },
        ["commenting"],
        "agent-1",
      ),
    ).toMatchObject({
      action: "REPLY_COMMENT",
      isFinish: false,
      parameters: {
        commentId: "comment-2",
        postId: "post-2",
      },
    });
  });
});
