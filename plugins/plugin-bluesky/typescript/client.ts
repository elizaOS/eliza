import { type AppBskyFeedDefs, BskyAgent, RichText } from "@atproto/api";
import { logger } from "@elizaos/core";
import { LRUCache } from "lru-cache";
import type {
  ATProtocolPostRecord,
  ATProtocolProfileViewExtended,
  BlueSkyConversation,
  BlueSkyMessage,
  BlueSkyNotification,
  BlueSkyPost,
  BlueSkyProfile,
  BlueSkySession,
  CreatePostRequest,
  PostEmbed,
  PostFacet,
  SendMessageRequest,
  TimelineRequest,
  TimelineResponse,
} from "./types";
import { BLUESKY_CHAT_SERVICE_DID, BlueSkyError, CACHE_SIZE, CACHE_TTL } from "./types";

function isPostView(
  item:
    | AppBskyFeedDefs.PostView
    | AppBskyFeedDefs.NotFoundPost
    | AppBskyFeedDefs.BlockedPost
    | { $type: string; [k: string]: string | number | boolean | object | null | undefined }
): item is AppBskyFeedDefs.PostView {
  return (
    typeof item === "object" &&
    item !== null &&
    "uri" in item &&
    "cid" in item &&
    "author" in item &&
    "record" in item &&
    "indexedAt" in item &&
    typeof (item as AppBskyFeedDefs.PostView).uri === "string" &&
    typeof (item as AppBskyFeedDefs.PostView).cid === "string"
  );
}

function adaptPostView(postView: AppBskyFeedDefs.PostView): BlueSkyPost {
  const author = postView.author as ATProtocolProfileViewExtended;
  const record = postView.record as ATProtocolPostRecord;

  return {
    uri: postView.uri,
    cid: postView.cid,
    author: {
      did: author.did,
      handle: author.handle,
      displayName: author.displayName,
      description: author.description,
      avatar: author.avatar,
      banner: author.banner,
      followersCount: author.followersCount,
      followsCount: author.followsCount,
      postsCount: author.postsCount,
      indexedAt: author.indexedAt,
      createdAt: author.createdAt,
    },
    record: {
      $type: record.$type ?? "app.bsky.feed.post",
      text: record.text ?? "",
      facets: record.facets as PostFacet[] | undefined,
      embed: record.embed as PostEmbed | undefined,
      createdAt: record.createdAt ?? "",
    },
    embed: postView.embed as PostEmbed | undefined,
    replyCount: postView.replyCount,
    repostCount: postView.repostCount,
    likeCount: postView.likeCount,
    quoteCount: postView.quoteCount,
    indexedAt: postView.indexedAt,
  };
}

export interface BlueSkyClientConfig {
  service: string;
  handle: string;
  password: string;
  dryRun: boolean;
}

export class BlueSkyClient {
  private readonly agent: BskyAgent;
  private session: BlueSkySession | null = null;
  private readonly profileCache: LRUCache<string, BlueSkyProfile>;

  constructor(private readonly config: BlueSkyClientConfig) {
    this.agent = new BskyAgent({ service: config.service });
    this.profileCache = new LRUCache({
      max: CACHE_SIZE.PROFILE,
      ttl: CACHE_TTL.PROFILE,
    });
  }

  async authenticate(): Promise<BlueSkySession> {
    const response = await this.agent.login({
      identifier: this.config.handle,
      password: this.config.password,
    });

    if (!response.success) {
      throw new BlueSkyError("Authentication failed", "AUTH_FAILED");
    }

    this.session = {
      did: response.data.did,
      handle: response.data.handle,
      email: response.data.email,
      accessJwt: response.data.accessJwt,
      refreshJwt: response.data.refreshJwt,
    };

    logger.info(`Authenticated with BlueSky: ${this.session.handle}`);
    return this.session;
  }

  getSession(): BlueSkySession | null {
    return this.session;
  }

  async getProfile(handle: string): Promise<BlueSkyProfile> {
    const cached = this.profileCache.get(handle);
    if (cached) return cached;

    const response = await this.agent.getProfile({ actor: handle });
    const profile: BlueSkyProfile = {
      did: response.data.did,
      handle: response.data.handle,
      displayName: response.data.displayName,
      description: response.data.description,
      avatar: response.data.avatar,
      banner: response.data.banner,
      followersCount: response.data.followersCount,
      followsCount: response.data.followsCount,
      postsCount: response.data.postsCount,
      indexedAt: response.data.indexedAt,
      createdAt: response.data.createdAt,
    };

    this.profileCache.set(handle, profile);
    return profile;
  }

  async getTimeline(params: TimelineRequest = {}): Promise<TimelineResponse> {
    const response = await this.agent.getTimeline({
      algorithm: params.algorithm,
      limit: params.limit ?? 50,
      cursor: params.cursor,
    });

    return {
      cursor: response.data.cursor,
      feed: response.data.feed.map((item) => ({
        post: adaptPostView(item.post),
        reply:
          // @ts-expect-error - AT Proto SDK type narrowing issue with reply posts
          item.reply && isPostView(item.reply.root) && isPostView(item.reply.parent)
            ? {
                root: adaptPostView(item.reply.root as AppBskyFeedDefs.PostView),
                parent: adaptPostView(item.reply.parent as AppBskyFeedDefs.PostView),
              }
            : undefined,
        reason: item.reason as Record<
          string,
          string | number | boolean | object | null | undefined
        >,
      })),
    };
  }

  async sendPost(request: CreatePostRequest): Promise<BlueSkyPost> {
    if (this.config.dryRun) {
      logger.info(`Dry run: would create post with text: ${request.content.text}`);
      return this.mockPost(request.content.text);
    }

    const rt = new RichText({ text: request.content.text });
    await rt.detectFacets(this.agent);

    const record: Record<
      string,
      | string
      | PostFacet[]
      | PostEmbed
      | { root: { uri: string; cid: string }; parent: { uri: string; cid: string } }
    > = {
      $type: "app.bsky.feed.post",
      text: rt.text,
      facets: rt.facets as PostFacet[],
      createdAt: new Date().toISOString(),
    };

    if (request.replyTo) {
      record.reply = { root: request.replyTo, parent: request.replyTo };
    }

    if (request.content.embed) {
      record.embed = request.content.embed;
    }

    const response = await this.agent.post(record);
    const thread = await this.agent.getPostThread({
      uri: response.uri,
      depth: 0,
    });

    if (thread.data.thread.$type !== "app.bsky.feed.defs#threadViewPost") {
      throw new BlueSkyError("Failed to retrieve created post", "POST_CREATE_FAILED");
    }

    const threadViewPost = thread.data.thread as AppBskyFeedDefs.ThreadViewPost;
    return adaptPostView(threadViewPost.post);
  }

  async deletePost(uri: string): Promise<void> {
    if (this.config.dryRun) {
      logger.info(`Dry run: would delete post: ${uri}`);
      return;
    }
    await this.agent.deletePost(uri);
  }

  async likePost(uri: string, cid: string): Promise<void> {
    if (this.config.dryRun) {
      logger.info(`Dry run: would like post: ${uri}`);
      return;
    }
    await this.agent.like(uri, cid);
  }

  async repost(uri: string, cid: string): Promise<void> {
    if (this.config.dryRun) {
      logger.info({ uri }, "Dry run: would repost");
      return;
    }
    await this.agent.repost(uri, cid);
  }

  async getNotifications(
    limit = 50,
    cursor?: string
  ): Promise<{
    notifications: BlueSkyNotification[];
    cursor?: string;
  }> {
    const response = await this.agent.listNotifications({ limit, cursor });
    return {
      notifications: response.data.notifications as BlueSkyNotification[],
      cursor: response.data.cursor,
    };
  }

  async updateSeenNotifications(): Promise<void> {
    await this.agent.updateSeenNotifications();
  }

  async getConversations(
    limit = 50,
    cursor?: string
  ): Promise<{
    conversations: BlueSkyConversation[];
    cursor?: string;
  }> {
    const response = await this.agent.api.chat.bsky.convo.listConvos(
      { limit, cursor },
      { headers: { "atproto-proxy": BLUESKY_CHAT_SERVICE_DID } }
    );
    return {
      conversations: response.data.convos as BlueSkyConversation[],
      cursor: response.data.cursor,
    };
  }

  async getMessages(
    convoId: string,
    limit = 50,
    cursor?: string
  ): Promise<{
    messages: BlueSkyMessage[];
    cursor?: string;
  }> {
    const response = await this.agent.api.chat.bsky.convo.getMessages(
      { convoId, limit, cursor },
      { headers: { "atproto-proxy": BLUESKY_CHAT_SERVICE_DID } }
    );
    return {
      messages: response.data.messages as BlueSkyMessage[],
      cursor: response.data.cursor,
    };
  }

  async sendMessage(request: SendMessageRequest): Promise<BlueSkyMessage> {
    if (this.config.dryRun) {
      logger.info({ convoId: request.convoId }, "Dry run: would send message");
      return this.mockMessage(request.message.text ?? "");
    }

    const response = await this.agent.api.chat.bsky.convo.sendMessage(
      {
        convoId: request.convoId,
        message: { text: request.message.text ?? "" },
      },
      { headers: { "atproto-proxy": BLUESKY_CHAT_SERVICE_DID } }
    );
    return response.data as BlueSkyMessage;
  }

  async cleanup(): Promise<void> {
    this.profileCache.clear();
    this.session = null;
  }

  private mockPost(text: string): BlueSkyPost {
    const now = new Date().toISOString();
    return {
      uri: `mock://post/${Date.now()}`,
      cid: `mock-cid-${Date.now()}`,
      author: {
        did: this.session?.did ?? "did:plc:mock",
        handle: this.session?.handle ?? "mock.handle",
      },
      record: { $type: "app.bsky.feed.post", text, createdAt: now },
      indexedAt: now,
    };
  }

  private mockMessage(text: string): BlueSkyMessage {
    return {
      id: `mock-msg-${Date.now()}`,
      rev: "1",
      text,
      sender: { did: this.session?.did ?? "did:plc:mock" },
      sentAt: new Date().toISOString(),
    };
  }
}
