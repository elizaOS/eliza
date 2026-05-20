import { describe, expect, test } from 'bun:test';
import {
  type MultiChatSeedSlot,
  type MultiChatSeedUser,
  planMultiChatSeedAssignments,
} from '../services/npc-group-chat-onboarding-service';

describe('planMultiChatSeedAssignments', () => {
  test('assigns a user into multiple unique NPC chats when capacity allows', () => {
    const users: MultiChatSeedUser[] = [
      { userId: 'user-1', activeGroupCount: 0 },
    ];
    const chatSlots: MultiChatSeedSlot[] = [
      { chatId: 'chat-1', groupId: 'group-1', ownerId: 'npc-1', slots: 1 },
      { chatId: 'chat-2', groupId: 'group-2', ownerId: 'npc-2', slots: 1 },
      { chatId: 'chat-3', groupId: 'group-3', ownerId: 'npc-3', slots: 1 },
    ];

    const assignments = planMultiChatSeedAssignments({
      users,
      chatSlots,
      targetChatsPerUser: 3,
      rng: () => 0,
    });

    expect(assignments).toHaveLength(3);
    expect(
      new Set(assignments.map((assignment) => assignment.chatId)).size
    ).toBe(3);
    expect(
      assignments.every((assignment) => assignment.userId === 'user-1')
    ).toBe(true);
  });

  test('skips chats the user is already in and only fills remaining slots', () => {
    const users: MultiChatSeedUser[] = [
      { userId: 'user-1', activeGroupCount: 1 },
    ];
    const chatSlots: MultiChatSeedSlot[] = [
      { chatId: 'chat-1', groupId: 'group-1', ownerId: 'npc-1', slots: 1 },
      { chatId: 'chat-2', groupId: 'group-2', ownerId: 'npc-2', slots: 1 },
      { chatId: 'chat-3', groupId: 'group-3', ownerId: 'npc-3', slots: 1 },
    ];

    const assignments = planMultiChatSeedAssignments({
      users,
      chatSlots,
      existingMemberships: [{ userId: 'user-1', chatId: 'chat-1' }],
      targetChatsPerUser: 3,
      rng: () => 0,
    });

    expect(assignments).toHaveLength(2);
    expect(assignments.map((assignment) => assignment.chatId)).not.toContain(
      'chat-1'
    );
  });
});
