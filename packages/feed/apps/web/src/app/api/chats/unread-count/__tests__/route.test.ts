import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockAuthenticate = mock();
const mockAsUser = mock();

mock.module('@babylon/api', () => ({
  authenticate: mockAuthenticate,
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

mock.module('@babylon/db', () => ({
  asUser: mockAsUser,
}));

import { GET } from '../route';

describe('GET /api/chats/unread-count', () => {
  beforeEach(() => {
    mockAuthenticate.mockReset();
    mockAsUser.mockReset();
  });

  it('returns separate pending request and unread message counts', async () => {
    mockAuthenticate.mockResolvedValue({ userId: 'user-1' });
    mockAsUser.mockImplementation(
      async (
        user: { userId: string },
        callback: (db: {
          dmAcceptance: { count: (input: unknown) => Promise<number> };
          notification: { count: (input: unknown) => Promise<number> };
        }) => Promise<unknown>
      ) =>
        callback({
          dmAcceptance: {
            count: async () => 2,
          },
          notification: {
            count: async () => 3,
          },
        })
    );

    const response = (await GET({} as never)) as Response;
    const body = await response.json();

    expect(body).toEqual({
      pendingDMs: 5,
      pendingDMRequests: 2,
      unreadMessages: 3,
      hasNewMessages: true,
    });
  });
});
