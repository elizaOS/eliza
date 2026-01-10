import { BskyAgent, AppBskyFeedPost, RichText } from '@atproto/api';
import { logger } from '@elizaos/core';
import { LRUCache } from 'lru-cache';
import {
  BlueSkyPost,
  BlueSkyProfile,
  BlueSkyTimelineRequest,
  BlueSkyTimelineResponse,
  CreatePostRequest,
  BlueSkyError,
  BlueSkySession,
  BlueSkyNotification,
  BlueSkyConversation,
  BlueSkyMessage,
  SendMessageRequest,
} from './common/types.js';
import {
  CACHE_TTLS,
  CACHE_SIZES,
  ERROR_MESSAGES,
  BLUESKY_CHAT_SERVICE_DID,
} from './common/constants.js';

export class BlueSkyClient {
  private agent: BskyAgent;
  private session: BlueSkySession | null = null;
  private caches: Map<string, LRUCache<string, any>>;
  private isAuthenticated = false;

  constructor(
    private readonly config: {
      service: string;
      handle: string;
      password: string;
      dryRun?: boolean;
    }
  ) {
    this.agent = new BskyAgent({
      service: config.service,
    });

    // Initialize caches
    this.caches = new Map();
    Object.entries(CACHE_SIZES).forEach(([key, size]) => {
      this.caches.set(
        key.toLowerCase(),
        new LRUCache({
          max: size,
          ttl: CACHE_TTLS[key as keyof typeof CACHE_TTLS],
        })
      );
    });
  }

  /**
   * Authenticate with BlueSky
   */
  async authenticate(): Promise<void> {
    try {
      logger.debug('Authenticating with BlueSky', {
        handle: this.config.handle,
        service: this.config.service,
      });

      const response = await this.agent.login({
        identifier: this.config.handle,
        password: this.config.password,
      });

      if (!response.success) {
        throw new BlueSkyError(ERROR_MESSAGES.NOT_AUTHENTICATED);
      }

      this.session = {
        did: response.data.did,
        handle: response.data.handle,
        email: response.data.email,
        emailConfirmed: response.data.emailConfirmed,
        emailAuthFactor: response.data.emailAuthFactor,
        accessJwt: response.data.accessJwt,
        refreshJwt: response.data.refreshJwt,
        active: response.data.active,
      };

      this.isAuthenticated = true;
      logger.info('Successfully authenticated with BlueSky', {
        did: this.session.did,
        handle: this.session.handle,
      });
    } catch (error: any) {
      logger.error('Failed to authenticate with BlueSky', error);
      throw new BlueSkyError(ERROR_MESSAGES.NOT_AUTHENTICATED, 'AUTH_FAILED', error.status, error);
    }
  }

  /**
   * Get current session
   */
  getSession(): BlueSkySession | null {
    return this.session;
  }

  /**
   * Get profile
   */
  async getProfile(handle: string): Promise<BlueSkyProfile> {
    const cacheKey = `profile:${handle}`;
    const cache = this.caches.get('profile')!;
    const cached = cache.get(cacheKey);

    if (cached) {
      return cached;
    }

    try {
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
        associated: response.data.associated,
        indexedAt: response.data.indexedAt,
        createdAt: response.data.createdAt,
        viewer: response.data.viewer,
        labels: response.data.labels,
      };

      cache.set(cacheKey, profile);
      return profile;
    } catch (error: any) {
      logger.error('Failed to get profile', { handle, error });
      throw new BlueSkyError('Failed to get profile', 'PROFILE_FETCH_FAILED', error.status, error);
    }
  }

  /**
   * Get timeline
   */
  async getTimeline(params: BlueSkyTimelineRequest): Promise<BlueSkyTimelineResponse> {
    try {
      const response = await this.agent.getTimeline({
        algorithm: params.algorithm,
        limit: params.limit || 50,
        cursor: params.cursor,
      });

      return {
        cursor: response.data.cursor,
        feed: response.data.feed.map((item) => ({
          post: this.mapPost(item.post),
          reply: item.reply
            ? {
                root: this.mapPost(item.reply.root),
                parent: this.mapPost(item.reply.parent),
                grandparentAuthor: item.reply.grandparentAuthor,
              }
            : undefined,
          reason: item.reason,
          feedContext: item.feedContext,
        })),
      };
    } catch (error: any) {
      logger.error('Failed to get timeline', { params, error });
      throw new BlueSkyError(
        'Failed to get timeline',
        'TIMELINE_FETCH_FAILED',
        error.status,
        error
      );
    }
  }

  /**
   * Create a post
   */
  async sendPost(request: CreatePostRequest): Promise<BlueSkyPost> {
    if (this.config.dryRun) {
      logger.info('Dry run: would create post', request);
      return this.createMockPost(request.content.text);
    }

    try {
      // Create RichText to properly handle mentions and links
      const rt = new RichText({ text: request.content.text });
      await rt.detectFacets(this.agent);

      const postRecord: Partial<AppBskyFeedPost.Record> = {
        $type: 'app.bsky.feed.post',
        text: rt.text,
        facets: rt.facets,
        createdAt: new Date().toISOString(),
      };

      // Add reply reference if provided
      if (request.replyTo) {
        postRecord.reply = {
          root: request.replyTo,
          parent: request.replyTo,
        };
      }

      // Add embed if provided
      if (request.content.embed) {
        postRecord.embed = request.content.embed;
      }

      const response = await this.agent.post(postRecord);

      // Fetch the created post to return full details
      const postUri = response.uri;
      const postThread = await this.agent.getPostThread({ uri: postUri, depth: 0 });

      if (postThread.data.thread.$type === 'app.bsky.feed.defs#threadViewPost') {
        return this.mapPost(postThread.data.thread.post);
      }

      throw new Error('Failed to retrieve created post');
    } catch (error: any) {
      logger.error('Failed to create post', { request, error });
      throw new BlueSkyError('Failed to create post', 'POST_CREATE_FAILED', error.status, error);
    }
  }

  /**
   * Delete a post
   */
  async deletePost(uri: string): Promise<void> {
    if (this.config.dryRun) {
      logger.info('Dry run: would delete post', { uri });
      return;
    }

    try {
      await this.agent.deletePost(uri);
      logger.info('Successfully deleted post', { uri });
    } catch (error: any) {
      logger.error('Failed to delete post', { uri, error });
      throw new BlueSkyError('Failed to delete post', 'POST_DELETE_FAILED', error.status, error);
    }
  }

  /**
   * Like a post
   */
  async likePost(uri: string, cid: string): Promise<void> {
    if (this.config.dryRun) {
      logger.info('Dry run: would like post', { uri, cid });
      return;
    }

    try {
      await this.agent.like(uri, cid);
      logger.info('Successfully liked post', { uri });
    } catch (error: any) {
      logger.error('Failed to like post', { uri, error });
      throw new BlueSkyError('Failed to like post', 'LIKE_FAILED', error.status, error);
    }
  }

  /**
   * Repost a post
   */
  async repost(uri: string, cid: string): Promise<void> {
    if (this.config.dryRun) {
      logger.info('Dry run: would repost', { uri, cid });
      return;
    }

    try {
      await this.agent.repost(uri, cid);
      logger.info('Successfully reposted', { uri });
    } catch (error: any) {
      logger.error('Failed to repost', { uri, error });
      throw new BlueSkyError('Failed to repost', 'REPOST_FAILED', error.status, error);
    }
  }

  /**
   * Get notifications
   */
  async getNotifications(
    limit: number = 50,
    cursor?: string
  ): Promise<{
    notifications: BlueSkyNotification[];
    cursor?: string;
  }> {
    try {
      const response = await this.agent.listNotifications({
        limit,
        cursor,
      });

      return {
        notifications: response.data.notifications.map((notif) => ({
          uri: notif.uri,
          cid: notif.cid,
          author: notif.author,
          reason: notif.reason,
          reasonSubject: notif.reasonSubject,
          record: notif.record,
          isRead: notif.isRead,
          indexedAt: notif.indexedAt,
          labels: notif.labels,
        })),
        cursor: response.data.cursor,
      };
    } catch (error: any) {
      logger.error('Failed to get notifications', { error });
      throw new BlueSkyError(
        'Failed to get notifications',
        'NOTIFICATIONS_FETCH_FAILED',
        error.status,
        error
      );
    }
  }

  /**
   * Mark notifications as read
   */
  async updateSeenNotifications(): Promise<void> {
    try {
      await this.agent.updateSeenNotifications();
      logger.info('Successfully marked notifications as seen');
    } catch (error: any) {
      logger.error('Failed to update seen notifications', { error });
      throw new BlueSkyError(
        'Failed to update seen notifications',
        'UPDATE_SEEN_FAILED',
        error.status,
        error
      );
    }
  }

  /**
   * Get conversations (DMs)
   */
  async getConversations(
    limit: number = 50,
    cursor?: string
  ): Promise<{
    conversations: BlueSkyConversation[];
    cursor?: string;
  }> {
    try {
      // Set the chat service proxy header
      const response = await this.agent.api.chat.bsky.convo.listConvos(
        {
          limit,
          cursor,
        },
        {
          headers: {
            'atproto-proxy': BLUESKY_CHAT_SERVICE_DID,
          },
        }
      );

      return {
        conversations: response.data.convos.map((convo: any) => ({
          id: convo.id,
          rev: convo.rev,
          members: convo.members,
          lastMessage: convo.lastMessage,
          unreadCount: convo.unreadCount,
          muted: convo.muted,
          opened: convo.opened,
        })),
        cursor: response.data.cursor,
      };
    } catch (error: any) {
      logger.error('Failed to get conversations', { error });
      throw new BlueSkyError(
        'Failed to get conversations',
        'CONVERSATIONS_FETCH_FAILED',
        error.status,
        error
      );
    }
  }

  /**
   * Get messages from a conversation
   */
  async getMessages(
    convoId: string,
    limit: number = 50,
    cursor?: string
  ): Promise<{
    messages: BlueSkyMessage[];
    cursor?: string;
  }> {
    try {
      const response = await this.agent.api.chat.bsky.convo.getMessages(
        {
          convoId,
          limit,
          cursor,
        },
        {
          headers: {
            'atproto-proxy': BLUESKY_CHAT_SERVICE_DID,
          },
        }
      );

      return {
        messages: response.data.messages.map((msg: any) => ({
          id: msg.id,
          rev: msg.rev,
          text: msg.text,
          embed: msg.embed,
          sender: msg.sender,
          sentAt: msg.sentAt,
        })),
        cursor: response.data.cursor,
      };
    } catch (error: any) {
      logger.error('Failed to get messages', { convoId, error });
      throw new BlueSkyError(
        'Failed to get messages',
        'MESSAGES_FETCH_FAILED',
        error.status,
        error
      );
    }
  }

  /**
   * Send a message
   */
  async sendMessage(request: SendMessageRequest): Promise<BlueSkyMessage> {
    if (this.config.dryRun) {
      logger.info('Dry run: would send message', request);
      return this.createMockMessage(request.message.text || '');
    }

    try {
      const response = await this.agent.api.chat.bsky.convo.sendMessage(
        {
          convoId: request.convoId,
          message: {
            text: request.message.text || '',
            ...request.message,
          },
        },
        {
          headers: {
            'atproto-proxy': BLUESKY_CHAT_SERVICE_DID,
          },
        }
      );

      return {
        id: response.data.id,
        rev: response.data.rev,
        text: response.data.text,
        embed: response.data.embed,
        sender: response.data.sender,
        sentAt: response.data.sentAt,
      };
    } catch (error: any) {
      logger.error('Failed to send message', { request, error });
      throw new BlueSkyError('Failed to send message', 'MESSAGE_SEND_FAILED', error.status, error);
    }
  }

  /**
   * Helper method to map post data
   */
  private mapPost(post: any): BlueSkyPost {
    return {
      uri: post.uri,
      cid: post.cid,
      author: post.author,
      record: post.record,
      embed: post.embed,
      replyCount: post.replyCount,
      repostCount: post.repostCount,
      likeCount: post.likeCount,
      quoteCount: post.quoteCount,
      indexedAt: post.indexedAt,
      viewer: post.viewer,
      labels: post.labels,
    };
  }

  /**
   * Create mock post for dry run
   */
  private createMockPost(text: string): BlueSkyPost {
    const timestamp = Date.now();
    return {
      uri: `mock://post/${timestamp}`,
      cid: `mock-cid-${timestamp}`,
      author: {
        did: this.session?.did || 'did:plc:mock',
        handle: this.session?.handle || 'mock.handle',
        displayName: 'Mock User',
      },
      record: {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
      },
      indexedAt: new Date().toISOString(),
    };
  }

  /**
   * Create mock message for dry run
   */
  private createMockMessage(text: string): BlueSkyMessage {
    return {
      id: `mock-msg-${Date.now()}`,
      rev: '1',
      text,
      sender: {
        did: this.session?.did || 'did:plc:mock',
      },
      sentAt: new Date().toISOString(),
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.caches.clear();
    this.isAuthenticated = false;
    this.session = null;
  }
}
