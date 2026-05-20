import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const mockAuthenticate = mock();
const mockEnsureEngineServices = mock();
const mockCreateCommentPOST = mock();
const mockParsePostId = mock();

mock.module('@babylon/api', () => ({
  authenticate: mockAuthenticate,
  BusinessLogicError: class BusinessLogicError extends Error {},
  ensureUserForAuth: mock(),
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (
    handler: (
      request: NextRequest,
      context: { params: Promise<{ id: string }> }
    ) => Promise<unknown>
  ) => handler,
  checkProgress: async () => ({ completed: true }),
}));

mock.module('@babylon/db', () => ({
  comments: {},
  db: {},
  eq: mock(),
  posts: {},
  users: {},
}));

mock.module('@babylon/engine', () => ({
  FollowingMechanics: {},
  GroupChatService: {},
  MessageQualityChecker: {},
  parsePostId: mockParsePostId,
  ReplyRateLimiter: {},
}));

mock.module('@babylon/shared', () => ({
  generateSnowflakeId: mock(),
  logger: {
    info: mock(),
    warn: mock(),
  },
  PostIdParamSchema: {
    parse: (value: { id: string }) => value,
  },
  ReplyToPostSchema: {
    parse: (value: { content: string }) => value,
  },
}));

mock.module('@/lib/engine/ensure-engine-services', () => ({
  ensureEngineServices: mockEnsureEngineServices,
}));

mock.module('../comments/route', () => ({
  POST: mockCreateCommentPOST,
}));

const { POST } = await import('./route');

describe('POST /api/posts/[id]/reply', () => {
  beforeEach(() => {
    mockAuthenticate.mockReset();
    mockEnsureEngineServices.mockReset();
    mockCreateCommentPOST.mockReset();
    mockParsePostId.mockReset();
  });

  it('delegates to the generic comments handler for standard post IDs', async () => {
    mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
    mockParsePostId.mockReturnValue({
      success: false,
      metadata: {},
    });
    mockCreateCommentPOST.mockResolvedValue(
      new Response(JSON.stringify({ delegated: true }), { status: 201 })
    );

    const request = {
      url: 'https://example.com/api/posts/post-123/reply',
      method: 'POST',
    } as NextRequest;
    const context = {
      params: Promise.resolve({ id: 'post-123' }),
    };

    const response = (await POST(request, context)) as Response;
    const body = await response.json();

    expect(mockEnsureEngineServices).toHaveBeenCalledTimes(1);
    expect(mockCreateCommentPOST).toHaveBeenCalledWith(request, context);
    expect(response.status).toBe(201);
    expect(body).toEqual({ delegated: true });
  });
});
