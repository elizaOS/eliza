import {
  type IAgentRuntime,
  type Content,
  type UUID,
  Service,
  logger,
  asUUID,
  type Memory,
} from '@elizaos/core';
import { v4 as uuid } from 'uuid';

export interface Post extends Omit<Memory, 'id' | 'createdAt'> {
  id: UUID;
  createdAt: number;
  likes: number;
  replies: Post[];
  reposts: number;
}

// Based on example_highlevel_services/tests/messaging-service.test.ts
export interface IPostService extends Service {
  post(content: Content): Promise<Post>;
  replyToPost(postId: UUID, content: Content): Promise<Post>;
  likePost(postId: UUID): Promise<boolean>;
  repost(postId: UUID): Promise<boolean>;
  getTimeline(limit?: number): Promise<Post[]>;
}

export class DummyPostService extends Service implements IPostService {
  static readonly serviceName = 'POST';
  static readonly serviceType = 'post';
  readonly capabilityDescription = 'Provides a dummy posting service for testing.';

  private posts: Map<UUID, Post> = new Map();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    logger.info('DummyPostService initialized');
  }

  async post(content: Content): Promise<Post> {
    const newPost: Post = {
      id: asUUID(uuid()),
      content,
      entityId: this.runtime.agentId,
      roomId: asUUID(uuid()), // Each post is like its own "room"
      createdAt: Date.now(),
      likes: 0,
      replies: [],
      reposts: 0,
    };
    this.posts.set(newPost.id, newPost);
    logger.debug(`[DummyPostService] Created post ${newPost.id}:`, content);
    return newPost;
  }

  async replyToPost(postId: UUID, content: Content): Promise<Post> {
    const parentPost = this.posts.get(postId);
    if (!parentPost || !parentPost.roomId) {
      throw new Error(`Post with id ${postId} not found or has no room.`);
    }
    const replyPost: Post = {
      id: asUUID(uuid()),
      content,
      entityId: this.runtime.agentId,
      roomId: parentPost.roomId,
      createdAt: Date.now(),
      likes: 0,
      replies: [],
      reposts: 0,
    };
    parentPost.replies.push(replyPost);
    this.posts.set(replyPost.id, replyPost);
    logger.debug(`[DummyPostService] Replied to post ${postId}`);
    return replyPost;
  }

  async likePost(postId: UUID): Promise<boolean> {
    const post = this.posts.get(postId);
    if (!post) {
      return false;
    }
    post.likes += 1;
    return true;
  }

  async repost(postId: UUID): Promise<boolean> {
    const post = this.posts.get(postId);
    if (!post) {
      return false;
    }
    post.reposts += 1;
    return true;
  }

  async getTimeline(limit = 20): Promise<Post[]> {
    const allPosts = Array.from(this.posts.values()).sort((a, b) => b.createdAt - a.createdAt);
    return allPosts.slice(0, limit);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyPostService> {
    const service = new DummyPostService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService<DummyPostService>(DummyPostService.serviceType);
    if (service) {
      await service.stop();
    }
  }

  async start(): Promise<void> {
    logger.info(`[${DummyPostService.serviceName}] Service started.`);
  }

  async stop(): Promise<void> {
    logger.info(`[${DummyPostService.serviceName}] Service stopped.`);
  }
}
