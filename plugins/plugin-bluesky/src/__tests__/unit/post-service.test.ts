import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlueSkyPostService } from '../../services/PostService.js';
import { BlueSkyClient } from '../../client.js';
import { IAgentRuntime, ModelType, logger, createUniqueUuid } from '@elizaos/core';
import { BlueSkyPost, CreatePostRequest } from '../../common/types.js';
import { BLUESKY_MAX_POST_LENGTH } from '../../common/constants.js';

// Mock dependencies
vi.mock('../../client.js');
vi.mock('@elizaos/core', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  ModelType: {
    TEXT_SMALL: 'text_small',
  },
  createUniqueUuid: vi.fn(() => 'mock-uuid-123'),
}));

describe('BlueSkyPostService', () => {
  let service: BlueSkyPostService;
  let mockClient: BlueSkyClient;
  let mockRuntime: IAgentRuntime;

  const mockPost: BlueSkyPost = {
    uri: 'at://did:plc:test/app.bsky.feed.post/123',
    cid: 'cid123',
    author: {
      did: 'did:plc:test',
      handle: 'test.bsky.social',
      displayName: 'Test User',
    },
    record: {
      text: 'Test post content',
      createdAt: '2024-01-01T00:00:00Z',
    },
    replyCount: 0,
    repostCount: 0,
    likeCount: 0,
    quoteCount: 0,
    indexedAt: '2024-01-01T00:00:00Z',
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock client
    mockClient = {
      getTimeline: vi.fn(),
      sendPost: vi.fn(),
      deletePost: vi.fn(),
    } as any;

    // Mock runtime
    mockRuntime = {
      agentId: '00000000-0000-0000-0000-000000000123' as any,
      useModel: vi.fn(() => 'Generated content from AI'),
      storeMemory: vi.fn(),
      memory: {
        create: vi.fn(),
      },
    } as any;

    service = new BlueSkyPostService(mockClient, mockRuntime);
  });

  describe('getPosts', () => {
    it('should fetch posts from timeline', async () => {
      const mockTimeline = {
        feed: [
          { post: mockPost },
          { post: { ...mockPost, uri: 'at://another-post' } },
        ],
        cursor: 'next-cursor',
      };

      (mockClient.getTimeline as any).mockResolvedValueOnce(mockTimeline);

      const posts = await service.getPosts({
        agentId: mockRuntime.agentId,
        limit: 10,
        cursor: 'cursor',
      });

      expect(mockClient.getTimeline).toHaveBeenCalledWith({
        limit: 10,
        cursor: 'cursor',
      });

      expect(posts).toHaveLength(2);
      expect(posts[0]).toEqual(mockPost);
    });

    it('should use default limit if not provided', async () => {
      const mockTimeline = { feed: [], cursor: null };
      (mockClient.getTimeline as any).mockResolvedValueOnce(mockTimeline);

      await service.getPosts({
        agentId: mockRuntime.agentId,
      });

      expect(mockClient.getTimeline).toHaveBeenCalledWith({
        limit: 50,
        cursor: undefined,
      });
    });

    it('should handle timeline fetch errors', async () => {
      (mockClient.getTimeline as any).mockRejectedValueOnce(new Error('API error'));

      const posts = await service.getPosts({
        agentId: mockRuntime.agentId,
      });

      expect(posts).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith('Failed to get posts', expect.any(Object));
    });
  });

  describe('createPost', () => {
    it('should create post with provided text', async () => {
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      const result = await service.createPost({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
        text: 'Hello BlueSky!',
      });

      expect(mockClient.sendPost).toHaveBeenCalledWith({
        content: { text: 'Hello BlueSky!' },
        replyTo: undefined,
      });

      expect(result).toEqual(mockPost);
      expect((mockRuntime as any).storeMemory).toHaveBeenCalled();
    });

    it('should generate content if text is empty', async () => {
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      await service.createPost({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
        text: '',
      });

      expect(mockRuntime.useModel).toHaveBeenCalledWith(
        ModelType.TEXT_SMALL,
        expect.objectContaining({
          prompt: expect.stringContaining('Generate an interesting and engaging BlueSky post'),
        })
      );

      expect(mockClient.sendPost).toHaveBeenCalledWith({
        content: { text: 'Generated content from AI' },
        replyTo: undefined,
      });
    });

    it('should truncate long posts', async () => {
      const longText = 'A'.repeat(BLUESKY_MAX_POST_LENGTH + 100);
      
      // Mock truncation response
      (mockRuntime.useModel as any).mockResolvedValueOnce('Truncated text');
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      await service.createPost({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
        text: longText,
      });

      expect(mockRuntime.useModel).toHaveBeenCalledWith(
        ModelType.TEXT_SMALL,
        expect.objectContaining({
          prompt: expect.stringContaining('Shorten this text'),
        })
      );

      expect(mockClient.sendPost).toHaveBeenCalledWith({
        content: { text: 'Truncated text' },
        replyTo: undefined,
      });
    });

    it('should handle reply posts', async () => {
      const replyTo = {
        uri: 'at://parent-post',
        cid: 'parent-cid',
      };

      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      await service.createPost({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
        text: 'This is a reply',
        replyTo,
      });

      expect(mockClient.sendPost).toHaveBeenCalledWith({
        content: { text: 'This is a reply' },
        replyTo,
      });
    });

    it('should handle media placeholder', async () => {
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      await service.createPost({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
        text: 'Post with media',
        media: ['image1.jpg', 'image2.jpg'],
      });

      expect(logger.info).toHaveBeenCalledWith(
        'Media upload not yet implemented',
        { media: ['image1.jpg', 'image2.jpg'] }
      );
    });

    it('should handle post creation errors', async () => {
      (mockClient.sendPost as any).mockRejectedValueOnce(new Error('Post failed'));

      await expect(
        service.createPost({
          agentId: mockRuntime.agentId,
          roomId: 'room-123' as any,
          text: 'Test post',
        })
      ).rejects.toThrow('Post failed');

      expect(logger.error).toHaveBeenCalledWith('Failed to create post', expect.any(Object));
    });

    it('should fallback to substring truncation if AI truncation fails', async () => {
      const longText = 'A'.repeat(BLUESKY_MAX_POST_LENGTH + 100);
      
      // Mock truncation failure
      (mockRuntime.useModel as any).mockRejectedValueOnce(new Error('AI error'));
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      await service.createPost({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
        text: longText,
      });

      expect(mockClient.sendPost).toHaveBeenCalledWith({
        content: { 
          text: expect.stringMatching(/A+\.\.\.$/)
        },
        replyTo: undefined,
      });

      const calledText = (mockClient.sendPost as any).mock.calls[0][0].content.text;
      expect(calledText.length).toBe(BLUESKY_MAX_POST_LENGTH);
    });

    it('should ensure AI truncated text is within limit', async () => {
      const longText = 'A'.repeat(BLUESKY_MAX_POST_LENGTH + 100);
      
      // Mock AI returning text that's still too long
      (mockRuntime.useModel as any).mockResolvedValueOnce('B'.repeat(BLUESKY_MAX_POST_LENGTH + 10));
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      await service.createPost({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
        text: longText,
      });

      const calledText = (mockClient.sendPost as any).mock.calls[0][0].content.text;
      expect(calledText.length).toBe(BLUESKY_MAX_POST_LENGTH);
      expect(calledText.endsWith('...')).toBe(true);
    });
  });

  describe('deletePost', () => {
    it('should delete post successfully', async () => {
      await service.deletePost({
        agentId: mockRuntime.agentId,
        postUri: 'at://post-to-delete',
      });

      expect(mockClient.deletePost).toHaveBeenCalledWith('at://post-to-delete');
      expect(logger.info).toHaveBeenCalledWith(
        'Successfully deleted post',
        { postUri: 'at://post-to-delete' }
      );
    });

    it('should handle delete errors', async () => {
      (mockClient.deletePost as any).mockRejectedValueOnce(new Error('Delete failed'));

      await expect(
        service.deletePost({
          agentId: mockRuntime.agentId,
          postUri: 'at://post-to-delete',
        })
      ).rejects.toThrow('Delete failed');

      expect(logger.error).toHaveBeenCalledWith('Failed to delete post', expect.any(Object));
    });
  });

  describe('memory storage', () => {
    it('should store post in memory after creation', async () => {
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      await service.createPost({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
        text: 'Test post',
      });

      expect(createUniqueUuid).toHaveBeenCalledWith(mockRuntime, mockPost.uri);
      expect((mockRuntime as any).storeMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mock-uuid-123',
          agentId: mockRuntime.agentId,
          content: expect.objectContaining({
            text: mockPost.record.text,
            postUri: mockPost.uri,
            postCid: mockPost.cid,
          }),
          roomId: 'room-123',
        })
      );
    });

    it('should use memory.create if storeMemory not available', async () => {
      const runtimeWithMemoryCreate = {
        ...mockRuntime,
        storeMemory: undefined,
        memory: {
          create: vi.fn(),
        },
      };

      const serviceWithMemoryCreate = new BlueSkyPostService(mockClient, runtimeWithMemoryCreate);
      
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      await serviceWithMemoryCreate.createPost({
        agentId: runtimeWithMemoryCreate.agentId,
        roomId: 'room-123' as any,
        text: 'Test post',
      });

      expect(runtimeWithMemoryCreate.memory.create).toHaveBeenCalled();
    });

    it('should log warning if no memory storage available', async () => {
      const runtimeNoMemory = {
        ...mockRuntime,
        storeMemory: undefined,
        memory: undefined,
      };

      const serviceNoMemory = new BlueSkyPostService(mockClient, runtimeNoMemory);
      
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      await serviceNoMemory.createPost({
        agentId: runtimeNoMemory.agentId,
        roomId: 'room-123' as any,
        text: 'Test post',
      });

      expect(logger.warn).toHaveBeenCalledWith('Memory storage method not available in runtime');
    });

    it('should handle memory storage errors gracefully', async () => {
      ((mockRuntime as any).storeMemory as any).mockRejectedValueOnce(new Error('Memory error'));
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      const result = await service.createPost({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
        text: 'Test post',
      });

      // Post should still be created successfully
      expect(result).toEqual(mockPost);
      expect(logger.error).toHaveBeenCalledWith('Failed to store post in memory', expect.any(Object));
    });
  });

  describe('AI content generation', () => {
    it('should handle AI generation errors with fallback', async () => {
      (mockRuntime.useModel as any).mockRejectedValueOnce(new Error('AI error'));
      (mockClient.sendPost as any).mockResolvedValueOnce(mockPost);

      await service.createPost({
        agentId: mockRuntime.agentId,
        roomId: 'room-123' as any,
        text: '',
      });

      expect(mockClient.sendPost).toHaveBeenCalledWith({
        content: { text: 'Hello BlueSky! 👋' },
        replyTo: undefined,
      });

      expect(logger.error).toHaveBeenCalledWith('Failed to generate post content', expect.any(Object));
    });
  });
}); 