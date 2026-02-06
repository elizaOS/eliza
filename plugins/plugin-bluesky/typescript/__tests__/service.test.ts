import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks (hoisted by vitest) ────────────────────────────

vi.mock("@elizaos/core", () => ({
  logger: {
    success: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  Service: class {},
  ModelType: { TEXT_SMALL: "text_small" },
  composePrompt: vi.fn(() => "composed prompt"),
}));

vi.mock("../generated/prompts/typescript/prompts.js", () => ({
  generatePostTemplate: "generate post",
  truncatePostTemplate: "truncate post",
  generateDmTemplate: "generate dm",
}));

vi.mock("../client", () => ({
  BlueSkyClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../managers/agent", () => ({
  BlueSkyAgentManager: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    runtime: { agentId: "test-agent" },
  })),
}));

vi.mock("../utils/config", () => ({
  hasBlueSkyEnabled: vi.fn(),
  validateBlueSkyConfig: vi.fn(),
  getApiKeyOptional: vi.fn(),
  getPollInterval: vi.fn(() => 60000),
  getActionInterval: vi.fn(() => 120000),
  getMaxActionsProcessing: vi.fn(() => 5),
  isPostingEnabled: vi.fn(() => false),
  shouldPostImmediately: vi.fn(() => false),
  getPostIntervalRange: vi.fn(() => ({ min: 1800000, max: 3600000 })),
}));

// ── Imports (resolved after mocks) ──────────────────────────────

import { BlueSkyPostService } from "../services/post";
import { BlueSkyMessageService } from "../services/message";
import { BlueSkyService } from "../services/bluesky";
import { BLUESKY_MAX_POST_LENGTH } from "../types";
import type { BlueSkyPost, BlueSkyMessage } from "../types";
import { hasBlueSkyEnabled } from "../utils/config";

// ── Helpers ─────────────────────────────────────────────────────

function makeMockPost(text = "Test post"): BlueSkyPost {
  return {
    uri: "at://did:plc:test/app.bsky.feed.post/abc",
    cid: "bafytest",
    author: { did: "did:plc:test", handle: "test.bsky.social" },
    record: { $type: "app.bsky.feed.post", text, createdAt: "2024-01-01T00:00:00Z" },
    indexedAt: "2024-01-01T00:00:00Z",
  };
}

function makeMockMessage(text = "Hello"): BlueSkyMessage {
  return {
    id: "msg-1",
    rev: "1",
    text,
    sender: { did: "did:plc:sender" },
    sentAt: "2024-01-01T00:00:00Z",
  };
}

function createMockClient() {
  return {
    getTimeline: vi.fn(),
    sendPost: vi.fn(),
    deletePost: vi.fn(),
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
    getConversations: vi.fn(),
    getNotifications: vi.fn(),
    updateSeenNotifications: vi.fn(),
    authenticate: vi.fn(),
    cleanup: vi.fn(),
    getProfile: vi.fn(),
    likePost: vi.fn(),
    repost: vi.fn(),
  };
}

function createMockRuntime(agentId = "agent-1") {
  return {
    agentId,
    getSetting: vi.fn(),
    useModel: vi.fn().mockResolvedValue("Generated content"),
    emitEvent: vi.fn(),
  };
}

// ── BlueSkyPostService ──────────────────────────────────────────

describe("BlueSkyPostService", () => {
  let client: ReturnType<typeof createMockClient>;
  let runtime: ReturnType<typeof createMockRuntime>;
  let service: BlueSkyPostService;

  beforeEach(() => {
    client = createMockClient();
    runtime = createMockRuntime();
    service = new BlueSkyPostService(client as never, runtime as never);
  });

  afterEach(() => vi.clearAllMocks());

  it("should return posts from the timeline", async () => {
    const post = makeMockPost();
    client.getTimeline.mockResolvedValue({ feed: [{ post }], cursor: "c1" });

    const posts = await service.getPosts(10);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual(post);
    expect(client.getTimeline).toHaveBeenCalledWith({ limit: 10, cursor: undefined });
  });

  it("should create a post with provided text", async () => {
    const post = makeMockPost("Hello BlueSky!");
    client.sendPost.mockResolvedValue(post);

    const result = await service.createPost("Hello BlueSky!");

    expect(result).toEqual(post);
    expect(client.sendPost).toHaveBeenCalledWith({
      content: { text: "Hello BlueSky!" },
      replyTo: undefined,
    });
  });

  it("should include replyTo reference when provided", async () => {
    client.sendPost.mockResolvedValue(makeMockPost("Reply"));
    const replyTo = { uri: "at://did:plc:abc/post/1", cid: "bafyreply" };

    await service.createPost("Reply", replyTo);

    expect(client.sendPost).toHaveBeenCalledWith({
      content: { text: "Reply" },
      replyTo,
    });
  });

  it("should truncate posts exceeding the max length via model", async () => {
    const longText = "A".repeat(BLUESKY_MAX_POST_LENGTH + 100);
    runtime.useModel.mockResolvedValue("Short truncated text");
    client.sendPost.mockResolvedValue(makeMockPost("Short truncated text"));

    await service.createPost(longText);

    expect(runtime.useModel).toHaveBeenCalled();
    expect(client.sendPost).toHaveBeenCalledWith(
      expect.objectContaining({ content: { text: "Short truncated text" } }),
    );
  });

  it("should hard-truncate when model output still exceeds max length", async () => {
    const longText = "A".repeat(BLUESKY_MAX_POST_LENGTH + 50);
    runtime.useModel.mockResolvedValue("B".repeat(BLUESKY_MAX_POST_LENGTH + 20));
    client.sendPost.mockResolvedValue(makeMockPost());

    await service.createPost(longText);

    const sentText = client.sendPost.mock.calls[0][0].content.text as string;
    expect(sentText.length).toBeLessThanOrEqual(BLUESKY_MAX_POST_LENGTH);
    expect(sentText).toMatch(/\.\.\.$/);
  });

  it("should generate content when text is empty", async () => {
    runtime.useModel.mockResolvedValue("Auto-generated post");
    client.sendPost.mockResolvedValue(makeMockPost("Auto-generated post"));

    await service.createPost("");

    expect(runtime.useModel).toHaveBeenCalled();
    expect(client.sendPost).toHaveBeenCalledWith(
      expect.objectContaining({ content: { text: "Auto-generated post" } }),
    );
  });

  it("should generate content when text is only whitespace", async () => {
    runtime.useModel.mockResolvedValue("Auto-generated post");
    client.sendPost.mockResolvedValue(makeMockPost("Auto-generated post"));

    await service.createPost("   ");

    expect(runtime.useModel).toHaveBeenCalled();
  });

  it("should delete a post by URI", async () => {
    client.deletePost.mockResolvedValue(undefined);

    await service.deletePost("at://did:plc:test/post/123");

    expect(client.deletePost).toHaveBeenCalledWith("at://did:plc:test/post/123");
  });
});

// ── BlueSkyMessageService ───────────────────────────────────────

describe("BlueSkyMessageService", () => {
  let client: ReturnType<typeof createMockClient>;
  let runtime: ReturnType<typeof createMockRuntime>;
  let service: BlueSkyMessageService;

  beforeEach(() => {
    client = createMockClient();
    runtime = createMockRuntime();
    service = new BlueSkyMessageService(client as never, runtime as never);
  });

  afterEach(() => vi.clearAllMocks());

  it("should return messages for a conversation", async () => {
    const msg = makeMockMessage("Hey there");
    client.getMessages.mockResolvedValue({ messages: [msg] });

    const messages = await service.getMessages("convo-1", 25);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(msg);
    expect(client.getMessages).toHaveBeenCalledWith("convo-1", 25);
  });

  it("should send a message with provided text", async () => {
    const msg = makeMockMessage("Hello!");
    client.sendMessage.mockResolvedValue(msg);

    const result = await service.sendMessage("convo-1", "Hello!");

    expect(result).toEqual(msg);
    expect(client.sendMessage).toHaveBeenCalledWith({
      convoId: "convo-1",
      message: { text: "Hello!" },
    });
  });

  it("should generate a reply when text is empty", async () => {
    runtime.useModel.mockResolvedValue("Auto reply");
    client.sendMessage.mockResolvedValue(makeMockMessage("Auto reply"));

    await service.sendMessage("convo-1", "");

    expect(runtime.useModel).toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith({
      convoId: "convo-1",
      message: { text: "Auto reply" },
    });
  });

  it("should return conversations", async () => {
    const convo = {
      id: "convo-1",
      rev: "1",
      members: [{ did: "did:plc:user1" }],
      unreadCount: 3,
      muted: false,
    };
    client.getConversations.mockResolvedValue({ conversations: [convo] });

    const conversations = await service.getConversations(10);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toEqual(convo);
  });
});

// ── BlueSkyService ──────────────────────────────────────────────

describe("BlueSkyService", () => {
  afterEach(() => {
    // Reset singleton between tests
    (BlueSkyService as Record<string, unknown>).instance = undefined;
    vi.clearAllMocks();
  });

  it("should have correct service type", () => {
    expect(BlueSkyService.serviceType).toBe("bluesky");
  });

  it("should return service without initializing when not enabled", async () => {
    vi.mocked(hasBlueSkyEnabled).mockReturnValue(false);
    const runtime = createMockRuntime();

    const service = await BlueSkyService.start(runtime as never);

    expect(service).toBeInstanceOf(BlueSkyService);
    expect(service.getPostService(runtime.agentId)).toBeUndefined();
  });

  it("should return undefined from getPostService for unknown agent", () => {
    const service = new (BlueSkyService as unknown as new () => BlueSkyService)();
    expect(service.getPostService("unknown-id")).toBeUndefined();
  });

  it("should return undefined from getMessageService for unknown agent", () => {
    const service = new (BlueSkyService as unknown as new () => BlueSkyService)();
    expect(service.getMessageService("unknown-id")).toBeUndefined();
  });
});
