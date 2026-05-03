import { beforeEach, describe, expect, it, vi } from "vitest";

const twitterClient = {
  v2: {
    me: vi.fn(),
    tweet: vi.fn(),
    sendDmToParticipant: vi.fn(),
    sendDmInConversation: vi.fn(),
    createDmConversation: vi.fn(),
    listDmEvents: vi.fn(),
    homeTimeline: vi.fn(),
    userMentionTimeline: vi.fn(),
    search: vi.fn(),
  },
};

const servicePricingFindMock = vi.fn();
const creditsDeductMock = vi.fn();
const creditsRefundMock = vi.fn();
const twitterConfiguredMock = vi.fn();
const twitterCredentialsMock = vi.fn();
const twitterApiConstructorMock = vi.fn(() => twitterClient);

vi.mock("@/db/repositories/service-pricing", () => ({
  servicePricingRepository: {
    findByServiceAndMethod: servicePricingFindMock,
  },
}));

vi.mock("@/lib/services/twitter-automation", () => ({
  twitterAutomationService: {
    isConfigured: twitterConfiguredMock,
    getCredentialsForAgent: twitterCredentialsMock,
  },
}));

vi.mock("@/lib/services/credits", () => ({
  creditsService: {
    reserveAndDeductCredits: creditsDeductMock,
    refundCredits: creditsRefundMock,
  },
}));

vi.mock("twitter-api-v2", () => ({
  TwitterApi: twitterApiConstructorMock,
}));

import {
  createXDmGroup,
  createXPost,
  curateXDms,
  getXCloudStatus,
  getXDmDigest,
  getXFeed,
  resolveXOperationCost,
  sendXDm,
  sendXDmToConversation,
} from "@/lib/services/x";

function makeCredentials() {
  return {
    TWITTER_API_KEY: "api-key",
    TWITTER_API_SECRET_KEY: "api-secret",
    TWITTER_ACCESS_TOKEN: "access-token",
    TWITTER_ACCESS_TOKEN_SECRET: "access-secret",
  };
}

function makeOAuth2Credentials() {
  return {
    TWITTER_AUTH_MODE: "oauth2",
    TWITTER_OAUTH_ACCESS_TOKEN: "oauth2-access-token",
    TWITTER_OAUTH_REFRESH_TOKEN: "oauth2-refresh-token",
    TWITTER_USER_ID: "self-1",
  };
}

function makeDmEvent(args: {
  id: string;
  senderId: string;
  participantIds: string[];
  text: string;
  createdAt: string;
}) {
  return {
    id: args.id,
    event_type: "MessageCreate",
    created_at: args.createdAt,
    sender_id: args.senderId,
    participant_ids: args.participantIds,
    text: args.text,
    entities: {},
  };
}

describe("cloud X service", () => {
  beforeEach(() => {
    servicePricingFindMock.mockReset();
    creditsDeductMock.mockReset();
    creditsRefundMock.mockReset();
    twitterConfiguredMock.mockReset();
    twitterCredentialsMock.mockReset();
    twitterApiConstructorMock.mockClear();
    twitterClient.v2.me.mockReset();
    twitterClient.v2.tweet.mockReset();
    twitterClient.v2.sendDmToParticipant.mockReset();
    twitterClient.v2.sendDmInConversation.mockReset();
    twitterClient.v2.createDmConversation.mockReset();
    twitterClient.v2.listDmEvents.mockReset();
    twitterClient.v2.homeTimeline.mockReset();
    twitterClient.v2.userMentionTimeline.mockReset();
    twitterClient.v2.search.mockReset();

    twitterConfiguredMock.mockReturnValue(true);
    twitterCredentialsMock.mockResolvedValue(makeCredentials());
    servicePricingFindMock.mockResolvedValue({
      cost: "0.10",
    });
    creditsDeductMock.mockResolvedValue({
      success: true,
      newBalance: 9.88,
      transaction: { id: "tx-1" },
    });
    creditsRefundMock.mockResolvedValue({
      transaction: { id: "refund-1" },
      newBalance: 10,
    });
    twitterClient.v2.me.mockResolvedValue({
      data: {
        id: "self-1",
        username: "agent",
        name: "Agent",
        description: "local-first operator",
        profile_image_url: "https://example.com/avatar.jpg",
        verified: true,
        public_metrics: {
          followers_count: 100,
          following_count: 20,
          tweet_count: 7,
        },
      },
    });
  });

  it("returns the expected markup cost metadata shape", async () => {
    servicePricingFindMock.mockResolvedValue({
      cost: "0.25",
    });

    const metadata = await resolveXOperationCost("post");

    expect(metadata).toEqual({
      operation: "post",
      service: "x",
      rawCost: 0.25,
      markup: 0.05,
      billedCost: 0.3,
      markupRate: 0.2,
    });
  });

  it("returns 503 when X pricing is missing", async () => {
    servicePricingFindMock.mockResolvedValue(undefined);

    await expect(resolveXOperationCost("status")).rejects.toMatchObject({
      name: "XServiceError",
      status: 503,
    });
  });

  it("rejects cloud X access when the platform integration is not configured", async () => {
    twitterConfiguredMock.mockReturnValue(false);

    await expect(getXCloudStatus("org-1")).rejects.toMatchObject({
      name: "XServiceError",
      status: 503,
    });
  });

  it("returns disconnected status without calling upstream when credentials are missing", async () => {
    twitterCredentialsMock.mockResolvedValue(null);

    const status = await getXCloudStatus("org-1");

    expect(status).toMatchObject({
      configured: true,
      connected: false,
      status: { connected: false },
      me: null,
    });
    expect(creditsDeductMock).not.toHaveBeenCalled();
    expect(twitterApiConstructorMock).not.toHaveBeenCalled();
  });

  it("returns connected status with the upstream authenticated X profile", async () => {
    const status = await getXCloudStatus("org-1");

    expect(twitterApiConstructorMock).toHaveBeenCalledWith({
      appKey: "api-key",
      appSecret: "api-secret",
      accessToken: "access-token",
      accessSecret: "access-secret",
    });
    expect(twitterClient.v2.me).toHaveBeenCalledWith({
      "user.fields": ["description", "profile_image_url", "public_metrics", "verified"],
    });
    expect(creditsDeductMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        amount: 0.12,
        description: "X API status",
        metadata: expect.objectContaining({
          type: "x_status",
          operation: "status",
          rawCost: 0.1,
          billedCost: 0.12,
          markupRate: 0.2,
        }),
      }),
    );
    expect(status).toMatchObject({
      connected: true,
      status: {
        connected: true,
        username: "agent",
        userId: "self-1",
      },
      me: {
        id: "self-1",
        username: "agent",
        profileImageUrl: "https://example.com/avatar.jpg",
      },
      cost: {
        operation: "status",
        service: "x",
      },
    });
    expect(twitterCredentialsMock).toHaveBeenCalledWith("org-1", "owner");
  });

  it("uses OAuth2 user tokens when the connected X account was OAuth2-linked", async () => {
    twitterCredentialsMock.mockResolvedValue(makeOAuth2Credentials());

    const status = await getXCloudStatus("org-1");

    expect(twitterApiConstructorMock).toHaveBeenCalledWith("oauth2-access-token");
    expect(status.connected).toBe(true);
    expect(status.connectionRole).toBe("owner");
  });

  it("resolves cloud X credentials by connection role", async () => {
    const status = await getXCloudStatus("org-1", "agent");

    expect(status.connectionRole).toBe("agent");
    expect(twitterCredentialsMock).toHaveBeenCalledWith("org-1", "agent");
  });

  it("creates a real upstream X post after resolving cost metadata", async () => {
    twitterClient.v2.tweet.mockResolvedValue({
      data: {
        id: "tweet-1",
        text: "hello X",
      },
    });

    const result = await createXPost({
      organizationId: "org-1",
      text: " hello X ",
      replyToTweetId: "123",
    });

    expect(servicePricingFindMock).toHaveBeenCalledWith("x", "post");
    expect(creditsDeductMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        amount: 0.12,
        description: "X API post",
        metadata: expect.objectContaining({
          type: "x_post",
          operation: "post",
        }),
      }),
    );
    expect(twitterClient.v2.tweet).toHaveBeenCalledWith("hello X", {
      reply: { in_reply_to_tweet_id: "123" },
    });
    expect(result).toMatchObject({
      posted: true,
      operation: "post",
      tweet: {
        id: "tweet-1",
        text: "hello X",
        url: "https://x.com/i/status/tweet-1",
      },
      cost: {
        operation: "post",
        service: "x",
      },
    });
  });

  it("does not post when X credentials are missing", async () => {
    twitterCredentialsMock.mockResolvedValue(null);

    await expect(
      createXPost({
        organizationId: "org-1",
        text: "hello",
      }),
    ).rejects.toMatchObject({
      name: "XServiceError",
      status: 401,
    });
    expect(creditsDeductMock).not.toHaveBeenCalled();
    expect(twitterClient.v2.tweet).not.toHaveBeenCalled();
  });

  it("does not call upstream X when credits are insufficient", async () => {
    creditsDeductMock.mockResolvedValue({
      success: false,
      newBalance: 0.01,
      transaction: null,
      reason: "insufficient_balance",
    });

    await expect(
      createXPost({
        organizationId: "org-1",
        text: "hello",
      }),
    ).rejects.toMatchObject({
      name: "XServiceError",
      status: 402,
      message: "Insufficient credits for X post. Required: $0.12.",
    });
    expect(twitterClient.v2.tweet).not.toHaveBeenCalled();
  });

  it("sends a real upstream X direct message", async () => {
    twitterClient.v2.sendDmToParticipant.mockResolvedValue({
      dm_conversation_id: "conversation-1",
      dm_event_id: "dm-1",
    });

    const result = await sendXDm({
      organizationId: "org-1",
      participantId: "123456",
      text: " hello in DM ",
    });

    expect(servicePricingFindMock).toHaveBeenCalledWith("x", "dm.send");
    expect(creditsDeductMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        amount: 0.12,
        description: "X API dm.send",
      }),
    );
    expect(twitterClient.v2.sendDmToParticipant).toHaveBeenCalledWith("123456", {
      text: "hello in DM",
    });
    expect(result).toMatchObject({
      sent: true,
      operation: "dm.send",
      message: {
        id: "dm-1",
        direction: "sent",
        participantId: "123456",
        senderId: "self-1",
      },
      cost: {
        operation: "dm.send",
      },
    });
  });

  it("sends an upstream X direct message to an existing conversation", async () => {
    twitterClient.v2.sendDmInConversation.mockResolvedValue({
      dm_conversation_id: "987654321",
      dm_event_id: "dm-conversation-1",
    });

    const result = await sendXDmToConversation({
      organizationId: "org-1",
      conversationId: "987654321",
      text: " hello group ",
    });

    expect(twitterClient.v2.sendDmInConversation).toHaveBeenCalledWith("987654321", {
      text: "hello group",
    });
    expect(result).toMatchObject({
      sent: true,
      operation: "dm.send",
      message: {
        id: "dm-conversation-1",
        conversationId: "987654321",
        senderId: "self-1",
      },
    });
  });

  it("creates an upstream X group direct message", async () => {
    twitterClient.v2.createDmConversation.mockResolvedValue({
      dm_conversation_id: "777777777",
      dm_event_id: "dm-group-1",
    });

    const result = await createXDmGroup({
      organizationId: "org-1",
      participantIds: ["123456", "789012", "123456"],
      text: " hello group ",
    });

    expect(twitterClient.v2.createDmConversation).toHaveBeenCalledWith({
      conversation_type: "Group",
      participant_ids: ["123456", "789012"],
      message: { text: "hello group" },
    });
    expect(result).toMatchObject({
      created: true,
      operation: "dm.send",
      conversationId: "777777777",
      message: {
        id: "dm-group-1",
        participantIds: ["self-1", "123456", "789012"],
      },
    });
  });

  it("reads the authenticated X home timeline as feed items", async () => {
    const author = {
      id: "author-1",
      username: "author",
      name: "Author",
    };
    twitterClient.v2.homeTimeline.mockResolvedValue({
      tweets: [
        {
          id: "tweet-1",
          text: "important update",
          author_id: "author-1",
          created_at: "2026-04-22T12:00:00.000Z",
          conversation_id: "conversation-tweet-1",
          referenced_tweets: [{ type: "replied_to", id: "tweet-0" }],
          public_metrics: {
            like_count: 4,
            reply_count: 2,
            retweet_count: 1,
            quote_count: 0,
            impression_count: 100,
          },
        },
      ],
      includes: {
        author: vi.fn(() => author),
      },
    });

    const result = await getXFeed({
      organizationId: "org-1",
      feedType: "home_timeline",
      maxResults: 5,
    });

    expect(servicePricingFindMock).toHaveBeenCalledWith("x", "feed.read");
    expect(twitterClient.v2.homeTimeline).toHaveBeenCalledWith(
      expect.objectContaining({
        max_results: 5,
      }),
    );
    expect(result).toMatchObject({
      operation: "feed.read",
      feedType: "home_timeline",
      items: [
        {
          id: "tweet-1",
          authorId: "author-1",
          authorHandle: "author",
          conversationId: "conversation-tweet-1",
        },
      ],
    });
  });

  it("builds a direct-message digest from upstream DM events", async () => {
    twitterClient.v2.listDmEvents.mockResolvedValue({
      events: [
        makeDmEvent({
          id: "dm-in",
          senderId: "sender-1",
          participantIds: ["self-1", "sender-1"],
          text: "can you review this today?",
          createdAt: "2023-11-14T22:13:20.000Z",
        }),
        makeDmEvent({
          id: "dm-out",
          senderId: "self-1",
          participantIds: ["self-1", "sender-1"],
          text: "on it",
          createdAt: "2023-11-14T19:26:40.000Z",
        }),
      ],
    });

    const result = await getXDmDigest({
      organizationId: "org-1",
      maxResults: 10,
    });

    expect(twitterClient.v2.listDmEvents).toHaveBeenCalledWith({
      max_results: 10,
      "dm_event.fields": [
        "id",
        "text",
        "event_type",
        "created_at",
        "sender_id",
        "dm_conversation_id",
        "attachments",
        "participant_ids",
        "entities",
      ],
      event_types: ["MessageCreate"],
      expansions: ["sender_id", "participant_ids"],
    });
    expect(result.digest).toEqual({
      totalMessages: 2,
      receivedCount: 1,
      sentCount: 1,
      participantIds: ["sender-1"],
      latestMessageAt: "2023-11-14T22:13:20.000Z",
    });
    expect(result.messages[0]).toMatchObject({
      id: "dm-in",
      direction: "received",
      participantId: "sender-1",
    });
    expect(creditsDeductMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        amount: 0.12,
        description: "X API dm.digest",
      }),
    );
  });

  it("curates actionable inbound direct messages from upstream events", async () => {
    twitterClient.v2.listDmEvents.mockResolvedValue({
      events: [
        makeDmEvent({
          id: "low",
          senderId: "sender-2",
          participantIds: ["self-1", "sender-2"],
          text: "thanks",
          createdAt: "2023-11-14T19:26:40.000Z",
        }),
        makeDmEvent({
          id: "high",
          senderId: "sender-1",
          participantIds: ["self-1", "sender-1"],
          text: "urgent: can you review this today?",
          createdAt: new Date().toISOString(),
        }),
        makeDmEvent({
          id: "sent",
          senderId: "self-1",
          participantIds: ["self-1", "sender-1"],
          text: "I replied",
          createdAt: new Date().toISOString(),
        }),
      ],
    });

    const result = await curateXDms({
      organizationId: "org-1",
      maxResults: 5,
    });

    expect(result.operation).toBe("dm.curate");
    expect(result.items.map((item) => item.message.id)).toEqual(["high", "low"]);
    expect(result.items[0]).toMatchObject({
      priority: "high",
      recommendedAction: "reply",
    });
    expect(creditsDeductMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        amount: 0.12,
        description: "X API dm.curate",
      }),
    );
  });

  it("maps upstream X authorization errors to service errors", async () => {
    twitterClient.v2.tweet.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        code: 403,
        data: {
          detail: "Missing required permission",
        },
      }),
    );

    await expect(
      createXPost({
        organizationId: "org-1",
        text: "hello",
      }),
    ).rejects.toMatchObject({
      name: "XServiceError",
      status: 403,
      message: "Forbidden - Missing required permission",
    });
    expect(creditsRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        amount: 0.12,
        description: "X API post refund",
        metadata: expect.objectContaining({
          type: "x_post_refund",
          operation: "post",
          reason: "upstream_failure",
        }),
      }),
    );
  });

  it("maps nested upstream X errors without masking the service status", async () => {
    twitterClient.v2.tweet.mockRejectedValue(
      Object.assign(new Error("Forbidden"), {
        code: 403,
        data: {
          title: "Unsupported Authentication",
          errors: [
            {
              errors: [
                {
                  message: "OAuth 1.0a User Context is required for this endpoint",
                },
              ],
            },
          ],
        },
      }),
    );

    await expect(
      createXPost({
        organizationId: "org-1",
        text: "hello",
      }),
    ).rejects.toMatchObject({
      name: "XServiceError",
      status: 403,
      message:
        "Forbidden - Unsupported Authentication - OAuth 1.0a User Context is required for this endpoint",
    });
    expect(creditsRefundMock).toHaveBeenCalled();
  });
});
