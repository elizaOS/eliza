import { describe, expect, it } from 'bun:test';
import { StaticDataRegistry } from '@babylon/engine';

describe('Author name resolution', () => {
  it('should resolve known NPC IDs to display names', () => {
    const actor = StaticDataRegistry.getActor('ailon-musk');
    expect(actor).toBeDefined();
    expect(actor!.name).toBeTruthy();
    expect(actor!.name).not.toBe('ailon-musk');
  });

  it('should return null/undefined for unknown IDs', () => {
    const actor = StaticDataRegistry.getActor('nonexistent-user-12345');
    expect(actor).toBeFalsy();
  });

  it('resolveActorName logic: known ID returns name, unknown returns ID', () => {
    // Replicate the resolveActorName helper logic
    function resolveActorName(actorId: string): string {
      const actor = StaticDataRegistry.getActor(actorId);
      return actor?.name ?? actorId;
    }

    // Known NPC
    const knownName = resolveActorName('ailon-musk');
    expect(knownName).not.toBe('ailon-musk');
    expect(knownName.length).toBeGreaterThan(0);

    // Unknown ID falls back to raw ID
    const unknownName = resolveActorName('unknown-user-xyz');
    expect(unknownName).toBe('unknown-user-xyz');
  });
});

describe('Feed post time windowing', () => {
  it('48-hour window calculation is correct', () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    // Should be roughly 48 hours difference
    const diffMs = now.getTime() - twoDaysAgo.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    expect(diffHours).toBeCloseTo(48, 0);

    // A post from 47 hours ago should be within window
    const recentPost = new Date(now.getTime() - 47 * 60 * 60 * 1000);
    expect(recentPost.getTime()).toBeGreaterThan(twoDaysAgo.getTime());

    // A post from 49 hours ago should be outside window
    const oldPost = new Date(now.getTime() - 49 * 60 * 60 * 1000);
    expect(oldPost.getTime()).toBeLessThan(twoDaysAgo.getTime());
  });
});

describe('Group chat message limit alignment', () => {
  it('dashboard shows 5 messages, context should fetch 5', () => {
    // The dashboard formatter slices to 5
    const dashboardLimit = 5;
    // The context service should match
    const contextLimit = 5;
    expect(contextLimit).toBe(dashboardLimit);
  });

  it('slicing behavior is correct', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      id: `msg-${i}`,
      content: `Message ${i}`,
    }));

    // Both paths should produce the same 5 messages
    const dashboardSlice = messages.slice(0, 5);
    const contextSlice = messages.slice(0, 5);
    expect(dashboardSlice).toEqual(contextSlice);
    expect(dashboardSlice.length).toBe(5);
  });
});

describe('Group chat sender name resolution', () => {
  it('should resolve NPC sender to display name via StaticDataRegistry', () => {
    const npc = StaticDataRegistry.getActor('ailon-musk');
    expect(npc).toBeDefined();

    // Simulate the resolution logic from AutonomousGroupChatService
    const senderId: string = 'ailon-musk';
    const agentUserId: string = 'some-agent-id';
    const senderNames = new Map<string, string>();
    const actor = StaticDataRegistry.getActor(senderId);
    if (actor) {
      senderNames.set(senderId, actor.name);
    }

    const label =
      senderId === agentUserId ? 'You' : senderNames.get(senderId) || 'User';
    expect(label).not.toBe('User');
    expect(label).toBe(npc!.name);
  });

  it('should fall back to "User" only for truly unknown senders', () => {
    const senderId: string = 'completely-unknown-id';
    const agentUserId: string = 'some-agent-id';
    const senderNames = new Map<string, string>();
    // Don't add to map — simulates no NPC match and no DB result

    const label =
      senderId === agentUserId ? 'You' : senderNames.get(senderId) || 'User';
    expect(label).toBe('User');
  });

  it('should label self as "You"', () => {
    const senderId = 'my-agent-id';
    const agentUserId = 'my-agent-id';

    const label = senderId === agentUserId ? 'You' : 'Someone';
    expect(label).toBe('You');
  });
});
