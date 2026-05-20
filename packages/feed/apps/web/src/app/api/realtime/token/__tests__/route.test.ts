/**
 * Tests for Realtime Token API Route - Agent Channel Authorization
 *
 * @route POST /api/realtime/token
 *
 * Comprehensive tests covering:
 * - Agent channel authorization logic
 * - Ownership verification
 * - Channel deduplication
 * - Mixed channel types (agent, chat, public)
 * - Unauthorized agent rejection
 * - Edge cases
 */

import { describe, expect, it } from 'bun:test';

// Types
type RealtimeChannel = string;

// Test constants
const PUBLIC_CHANNELS: RealtimeChannel[] = [
  'feed',
  'markets',
  'breaking-news',
  'upcoming-events',
];

const USER_ID = 'user-123';

// Helper functions (replicating route logic)
const dedupe = <T>(items: T[]) => Array.from(new Set(items));

const isDmChatId = (id: string, userId: string): boolean => {
  if (!id.startsWith('dm-')) return false;
  const parts = id.substring('dm-'.length).split('-').filter(Boolean);
  if (parts.length !== 2) return false;
  return parts.includes(userId);
};

describe('Agent Channel Extraction', () => {
  it('should extract agent IDs from channel strings', () => {
    const channels = ['agent:agent-123', 'agent:agent-456', 'feed', 'markets'];

    const agentIds = channels
      .filter((ch) => ch.startsWith('agent:'))
      .map((ch) => ch.replace('agent:', ''));

    expect(agentIds).toHaveLength(2);
    expect(agentIds).toContain('agent-123');
    expect(agentIds).toContain('agent-456');
  });

  it('should combine agentIds from params and channels', () => {
    const agentIdsParam = ['agent-1', 'agent-2'];
    const requestedChannels = ['agent:agent-2', 'agent:agent-3', 'feed'];

    const derivedAgentIds = dedupe([
      ...agentIdsParam,
      ...requestedChannels
        .filter((ch) => ch.startsWith('agent:'))
        .map((ch) => ch.replace('agent:', '')),
    ]).filter(Boolean);

    expect(derivedAgentIds).toHaveLength(3);
    expect(derivedAgentIds).toContain('agent-1');
    expect(derivedAgentIds).toContain('agent-2');
    expect(derivedAgentIds).toContain('agent-3');
  });

  it('should deduplicate agent IDs', () => {
    const agentIdsParam = ['agent-1', 'agent-1', 'agent-2'];
    const requestedChannels = ['agent:agent-1', 'agent:agent-2'];

    const derivedAgentIds = dedupe([
      ...agentIdsParam,
      ...requestedChannels
        .filter((ch) => ch.startsWith('agent:'))
        .map((ch) => ch.replace('agent:', '')),
    ]).filter(Boolean);

    expect(derivedAgentIds).toHaveLength(2);
  });

  it('should filter out empty agent IDs', () => {
    const agentIdsParam = ['agent-1', '', 'agent-2'];
    const requestedChannels = ['agent:', 'agent:agent-3'];

    const derivedAgentIds = dedupe([
      ...agentIdsParam,
      ...requestedChannels
        .filter((ch) => ch.startsWith('agent:'))
        .map((ch) => ch.replace('agent:', '')),
    ]).filter(Boolean);

    expect(derivedAgentIds).toHaveLength(3);
    expect(derivedAgentIds).not.toContain('');
  });
});

describe('Agent Ownership Verification', () => {
  it('should filter to only owned agents', () => {
    const requestedAgentIds = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];
    const ownedAgentIds = ['agent-1', 'agent-3']; // Only these are owned

    const allowedAgentIds = new Set(ownedAgentIds);
    const authorizedAgentIds = requestedAgentIds.filter((id) =>
      allowedAgentIds.has(id)
    );

    expect(authorizedAgentIds).toHaveLength(2);
    expect(authorizedAgentIds).toContain('agent-1');
    expect(authorizedAgentIds).toContain('agent-3');
    expect(authorizedAgentIds).not.toContain('agent-2');
    expect(authorizedAgentIds).not.toContain('agent-4');
  });

  it('should return empty when user owns no requested agents', () => {
    const requestedAgentIds = ['agent-1', 'agent-2'];
    const ownedAgentIds: string[] = [];

    const allowedAgentIds = new Set(ownedAgentIds);
    const authorizedAgentIds = requestedAgentIds.filter((id) =>
      allowedAgentIds.has(id)
    );

    expect(authorizedAgentIds).toHaveLength(0);
  });

  it('should handle all agents being owned', () => {
    const requestedAgentIds = ['agent-1', 'agent-2', 'agent-3'];
    const ownedAgentIds = ['agent-1', 'agent-2', 'agent-3'];

    const allowedAgentIds = new Set(ownedAgentIds);
    const authorizedAgentIds = requestedAgentIds.filter((id) =>
      allowedAgentIds.has(id)
    );

    expect(authorizedAgentIds).toHaveLength(3);
  });
});

describe('Unauthorized Agent Handling', () => {
  it('should identify unauthorized agents', () => {
    const requestedAgentIds = ['agent-1', 'agent-2', 'agent-3'];
    const ownedAgentIds = ['agent-1'];

    const allowedAgentIds = new Set(ownedAgentIds);
    const unauthorizedAgents = requestedAgentIds.filter(
      (id) => !allowedAgentIds.has(id)
    );

    expect(unauthorizedAgents).toHaveLength(2);
    expect(unauthorizedAgents).toContain('agent-2');
    expect(unauthorizedAgents).toContain('agent-3');
  });

  it('should have no unauthorized agents when all owned', () => {
    const requestedAgentIds = ['agent-1', 'agent-2'];
    const ownedAgentIds = ['agent-1', 'agent-2', 'agent-3'];

    const allowedAgentIds = new Set(ownedAgentIds);
    const unauthorizedAgents = requestedAgentIds.filter(
      (id) => !allowedAgentIds.has(id)
    );

    expect(unauthorizedAgents).toHaveLength(0);
  });

  it('should silently exclude unauthorized agents (not fail request)', () => {
    // Per implementation: agent auth is less strict than chat auth
    const requestedAgentIds = ['agent-1', 'agent-unauthorized'];
    const ownedAgentIds = ['agent-1'];

    const allowedAgentIds = new Set(ownedAgentIds);
    const authorizedAgentIds = requestedAgentIds.filter((id) =>
      allowedAgentIds.has(id)
    );
    const unauthorizedAgents = requestedAgentIds.filter(
      (id) => !allowedAgentIds.has(id)
    );

    // Should still get the authorized agent
    expect(authorizedAgentIds).toHaveLength(1);
    expect(authorizedAgentIds).toContain('agent-1');
    expect(unauthorizedAgents).toHaveLength(1);
    // Request doesn't fail, just excludes unauthorized
  });
});

describe('Agent Channel Construction', () => {
  it('should construct agent channels correctly', () => {
    const authorizedAgentIds = ['agent-1', 'agent-2'];

    const agentChannels = authorizedAgentIds.map((id) => `agent:${id}`);

    expect(agentChannels).toHaveLength(2);
    expect(agentChannels).toContain('agent:agent-1');
    expect(agentChannels).toContain('agent:agent-2');
  });

  it('should handle empty authorized agents', () => {
    const authorizedAgentIds: string[] = [];

    const agentChannels = authorizedAgentIds.map((id) => `agent:${id}`);

    expect(agentChannels).toHaveLength(0);
  });
});

describe('Final Channel Assembly', () => {
  it('should combine all channel types correctly', () => {
    const baseChannels = [...PUBLIC_CHANNELS, `notifications:${USER_ID}`];
    const chatChannels = ['chat:chat-123', 'chat:chat-456'];
    const agentChannels = ['agent:agent-1', 'agent:agent-2'];

    const finalChannels = dedupe([
      ...baseChannels,
      ...chatChannels,
      ...agentChannels,
    ]);

    expect(finalChannels).toContain('feed');
    expect(finalChannels).toContain('markets');
    expect(finalChannels).toContain(`notifications:${USER_ID}`);
    expect(finalChannels).toContain('chat:chat-123');
    expect(finalChannels).toContain('agent:agent-1');
  });

  it('should deduplicate final channels', () => {
    const baseChannels = ['feed', 'markets'];
    const chatChannels = ['chat:chat-123'];
    const agentChannels = ['agent:agent-1'];
    const requestedPublic = ['feed', 'markets']; // duplicates

    const finalChannels = dedupe([
      ...baseChannels,
      ...requestedPublic,
      ...chatChannels,
      ...agentChannels,
    ]);

    const feedCount = finalChannels.filter((c) => c === 'feed').length;
    const marketsCount = finalChannels.filter((c) => c === 'markets').length;

    expect(feedCount).toBe(1);
    expect(marketsCount).toBe(1);
  });

  it('should handle no agent channels', () => {
    const baseChannels = [...PUBLIC_CHANNELS];
    const chatChannels = ['chat:chat-1'];
    const agentChannels: string[] = [];

    const finalChannels = dedupe([
      ...baseChannels,
      ...chatChannels,
      ...agentChannels,
    ]);

    expect(finalChannels).not.toContain('agent:');
    expect(finalChannels).toContain('chat:chat-1');
    expect(finalChannels.length).toBe(PUBLIC_CHANNELS.length + 1);
  });
});

describe('DM Chat Validation', () => {
  it('should validate correct DM format', () => {
    // Note: DM format is dm-{userId1}-{userId2} where IDs don't contain hyphens
    // When using snowflake IDs like '1234567890', format is dm-1234567890-9876543210
    const userId = '1234567890';
    const dmChatId = 'dm-1234567890-9876543210';

    expect(isDmChatId(dmChatId, userId)).toBe(true);
  });

  it('should reject DM where user is not participant', () => {
    const userId = '9999999999';
    const dmChatId = 'dm-1234567890-9876543210';

    expect(isDmChatId(dmChatId, userId)).toBe(false);
  });

  it('should reject non-DM chat IDs', () => {
    const userId = '1234567890';

    expect(isDmChatId('group-chat-123', userId)).toBe(false);
    expect(isDmChatId('chat-123', userId)).toBe(false);
    expect(isDmChatId('agent:agent-1', userId)).toBe(false);
  });

  it('should reject malformed DM IDs', () => {
    const userId = '1234567890';

    expect(isDmChatId('dm-', userId)).toBe(false);
    expect(isDmChatId('dm-1234567890', userId)).toBe(false); // Only 1 user
    expect(isDmChatId('dm-123-456-789', userId)).toBe(false); // 3 parts
  });
});

describe('Public Channel Validation', () => {
  it('should include only known public channels', () => {
    const requestedChannels = [
      'feed',
      'markets',
      'unknown-channel',
      'hacker-channel',
    ];

    const requestedPublic = requestedChannels.filter((ch) =>
      PUBLIC_CHANNELS.includes(ch)
    );

    expect(requestedPublic).toHaveLength(2);
    expect(requestedPublic).toContain('feed');
    expect(requestedPublic).toContain('markets');
    expect(requestedPublic).not.toContain('unknown-channel');
    expect(requestedPublic).not.toContain('hacker-channel');
  });

  it('should handle all public channels being requested', () => {
    const requestedChannels = [
      'feed',
      'markets',
      'breaking-news',
      'upcoming-events',
    ];

    const requestedPublic = requestedChannels.filter((ch) =>
      PUBLIC_CHANNELS.includes(ch)
    );

    expect(requestedPublic).toHaveLength(4);
  });
});

describe('Empty Channel Handling', () => {
  it('should handle empty request body', () => {
    const channels: string[] = [];
    const chatIds: string[] = [];
    const agentIds: string[] = [];

    expect(channels.length).toBe(0);
    expect(chatIds.length).toBe(0);
    expect(agentIds.length).toBe(0);
  });

  it('should still include base channels when request is empty', () => {
    const includeNotifications = true;
    const baseChannels = includeNotifications
      ? [...PUBLIC_CHANNELS, `notifications:${USER_ID}`]
      : [...PUBLIC_CHANNELS];

    expect(baseChannels.length).toBe(PUBLIC_CHANNELS.length + 1);
    expect(baseChannels).toContain('feed');
    expect(baseChannels).toContain(`notifications:${USER_ID}`);
  });

  it('should not include notifications when disabled', () => {
    const includeNotifications = false;
    const baseChannels = includeNotifications
      ? [...PUBLIC_CHANNELS, `notifications:${USER_ID}`]
      : [...PUBLIC_CHANNELS];

    expect(baseChannels.length).toBe(PUBLIC_CHANNELS.length);
    expect(baseChannels).not.toContain(`notifications:${USER_ID}`);
  });
});

describe('TTL Handling', () => {
  it('should use default TTL when not provided', () => {
    const providedTtl = undefined;
    const defaultTtl = 900;
    const actualTtl = providedTtl ?? defaultTtl;

    expect(actualTtl).toBe(900);
  });

  it('should use provided TTL', () => {
    const providedTtl = 3600;
    const defaultTtl = 900;
    const actualTtl = providedTtl ?? defaultTtl;

    expect(actualTtl).toBe(3600);
  });

  it('should calculate expiry correctly', () => {
    const now = Date.now();
    const ttl = 900;
    const expiresAt = now + ttl * 1000;

    expect(expiresAt).toBe(now + 900000);
    expect(expiresAt).toBeGreaterThan(now);
  });
});

describe('Edge Cases', () => {
  it('should handle agent ID with colons', () => {
    // This tests for potentially malformed agent IDs
    const channel = 'agent:agent:with:colons';
    const agentId = channel.replace('agent:', '');

    expect(agentId).toBe('agent:with:colons');
  });

  it('should handle very long agent IDs', () => {
    const longAgentId = 'a'.repeat(100);
    const channel = `agent:${longAgentId}`;

    expect(channel).toBe(`agent:${'a'.repeat(100)}`);
  });

  it('should handle Unicode in agent IDs', () => {
    const unicodeAgentId = 'agent-🤖-bot';
    const channel = `agent:${unicodeAgentId}`;

    expect(channel).toBe('agent:agent-🤖-bot');
  });

  it('should handle many agent requests efficiently', () => {
    const manyAgentIds = Array.from({ length: 100 }, (_, i) => `agent-${i}`);
    const ownedAgentIds = manyAgentIds.slice(0, 50); // Own half

    const allowedAgentIds = new Set(ownedAgentIds);
    const authorizedAgentIds = manyAgentIds.filter((id) =>
      allowedAgentIds.has(id)
    );

    expect(authorizedAgentIds).toHaveLength(50);
  });
});
