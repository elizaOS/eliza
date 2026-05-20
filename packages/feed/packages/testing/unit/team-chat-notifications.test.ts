import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockCreateNotification = mock(async () => ({ created: true }));
const mockLogger = {
  warn: mock(),
};

const selectBuilders: Array<() => { from: (...args: unknown[]) => unknown }> =
  [];

const mockDbSelect = mock(() => {
  const nextBuilder = selectBuilders.shift();
  if (!nextBuilder) {
    throw new Error('Unexpected db.select() call');
  }

  return nextBuilder();
});

const _actualFeedApi = await import('@feed/api');
mock.module('@feed/api', () => ({
  ..._actualFeedApi,
  createNotification: mockCreateNotification,
}));

const _actualDb = await import('@feed/db');
mock.module('@feed/db', () => ({
  ..._actualDb,
  and: (...conditions: unknown[]) => conditions,
  chatParticipants: {
    chatId: 'chatParticipants.chatId',
    isActive: 'chatParticipants.isActive',
    userId: 'chatParticipants.userId',
  },
  chats: {
    id: 'chats.id',
    name: 'chats.name',
  },
  db: {
    select: mockDbSelect,
  },
  eq: (left: unknown, right: unknown) => ({ left, right }),
  users: {
    displayName: 'users.displayName',
    id: 'users.id',
    isAgent: 'users.isAgent',
    username: 'users.username',
  },
}));

const _actualShared = await import('@feed/shared');
mock.module('@feed/shared', () => ({
  ..._actualShared,
  logger: mockLogger,
}));

const { notifyTeamChatMessage } = await import(
  '../../agents/src/services/team-chat-notifications'
);

function queueSenderSelect(
  rows: Array<{ displayName: string | null; username: string | null }>
) {
  selectBuilders.push(() => ({
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  }));
}

function queueParticipantsSelect(
  rows: Array<{ userId: string; isAgent: boolean }>
) {
  selectBuilders.push(() => ({
    from: () => ({
      innerJoin: () => ({
        where: async () => rows,
      }),
    }),
  }));
}

function queueChatSelect(rows: Array<{ name: string | null }>) {
  selectBuilders.push(() => ({
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  }));
}

describe('notifyTeamChatMessage', () => {
  beforeEach(() => {
    selectBuilders.length = 0;
    mockDbSelect.mockClear();
    mockCreateNotification.mockClear();
    mockCreateNotification.mockResolvedValue({ created: true });
    mockLogger.warn.mockClear();
  });

  it('notifies only human team chat participants with a per-message dedupe key', async () => {
    queueSenderSelect([
      { displayName: 'Apex Force', username: 'apexforce890569' },
    ]);
    queueParticipantsSelect([
      { userId: 'owner-1', isAgent: false },
      { userId: 'agent-1', isAgent: true },
      { userId: 'agent-2', isAgent: true },
    ]);
    queueChatSelect([{ name: 'Close NVDAI' }]);

    await notifyTeamChatMessage({
      chatId: 'chat-1',
      messageId: 'message-1',
      senderId: 'agent-1',
      messagePreview: 'Closed NVDAI and realized +$12.50 in profit.',
    });

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith({
      userId: 'owner-1',
      type: 'system',
      actorId: 'agent-1',
      chatId: 'chat-1',
      title: 'New Group Message',
      message:
        'Apex Force in "Close NVDAI": Closed NVDAI and realized +$12.50 in profit.',
      dedupeKey: 'team-chat-message:message-1:owner-1',
    });
  });

  it('skips notification creation when no human recipients remain', async () => {
    queueSenderSelect([
      { displayName: 'Apex Force', username: 'apexforce890569' },
    ]);
    queueParticipantsSelect([
      { userId: 'agent-1', isAgent: true },
      { userId: 'agent-2', isAgent: true },
    ]);
    queueChatSelect([{ name: null }]);

    await notifyTeamChatMessage({
      chatId: 'chat-1',
      messageId: 'message-1',
      senderId: 'agent-1',
      messagePreview: 'Closed NVDAI.',
    });

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('logs and swallows notification failures', async () => {
    queueSenderSelect([
      { displayName: 'Apex Force', username: 'apexforce890569' },
    ]);
    queueParticipantsSelect([{ userId: 'owner-1', isAgent: false }]);
    queueChatSelect([{ name: 'Agents' }]);
    mockCreateNotification.mockRejectedValueOnce(new Error('db unavailable'));

    await notifyTeamChatMessage({
      chatId: 'chat-1',
      messageId: 'message-1',
      senderId: 'agent-1',
      messagePreview: 'Closed NVDAI.',
    });

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to notify team chat message',
      {
        chatId: 'chat-1',
        messageId: 'message-1',
        senderId: 'agent-1',
        error: 'db unavailable',
      },
      'TeamChatNotifications'
    );
  });
});
