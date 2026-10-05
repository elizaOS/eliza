import { describe, expect, test } from 'bun:test';
import type { Task } from '@elizaos/core';
import { isAgentOwnedHeartbeat, isTriggerTaskOwnedBy } from '../../src/lib/trigger-ownership';

const localOwner = 'owner-local';
const foreignOwner = 'owner-foreign';

describe('trigger task ownership', () => {
  test('binds explicit owners independently of caller-controlled creator labels', () => {
    const owned = {
      entityId: localOwner,
      metadata: {
        ownership: { ownerId: localOwner },
        trigger: { createdBy: foreignOwner },
      },
    } as Task;
    expect(isTriggerTaskOwnedBy(owned, localOwner, localOwner)).toBe(true);
    expect(isTriggerTaskOwnedBy(owned, foreignOwner, localOwner)).toBe(false);

    const conflicting = {
      ...owned,
      metadata: { ownership: { ownerId: foreignOwner }, trigger: { createdBy: 'api' } },
    } as Task;
    expect(isTriggerTaskOwnedBy(conflicting, localOwner, localOwner)).toBe(false);
    expect(isTriggerTaskOwnedBy(conflicting, foreignOwner, localOwner)).toBe(false);
  });

  test('permits ownerless legacy tasks only on the canonical local owner surface', () => {
    const legacy = { metadata: { trigger: { createdBy: 'api' } } } as Task;
    expect(isTriggerTaskOwnedBy(legacy, localOwner, localOwner)).toBe(true);
    expect(isTriggerTaskOwnedBy(legacy, foreignOwner, localOwner)).toBe(false);

    const explicitForeign = {
      entityId: foreignOwner,
      metadata: { trigger: { createdBy: 'api' } },
    } as Task;
    expect(isTriggerTaskOwnedBy(explicitForeign, localOwner, localOwner)).toBe(false);
  });

  test('keeps an explicitly agent-owned heartbeat for the local owner only', () => {
    const agentId = 'agent-id';
    const heartbeat = {
      entityId: agentId,
      agentId,
      tags: ['queue', 'repeat', 'heartbeat'],
    } as Task;
    expect(isTriggerTaskOwnedBy(heartbeat, localOwner, localOwner, agentId)).toBe(true);
    expect(isTriggerTaskOwnedBy(heartbeat, foreignOwner, localOwner, agentId)).toBe(false);
    expect(
      isTriggerTaskOwnedBy(
        { ...heartbeat, entityId: foreignOwner },
        localOwner,
        localOwner,
        agentId
      )
    ).toBe(false);
    expect(
      isTriggerTaskOwnedBy(
        { ...heartbeat, metadata: { ownership: { ownerId: foreignOwner } } },
        localOwner,
        localOwner,
        agentId
      )
    ).toBe(false);
  });
  test.each([undefined, null])(
    'protects legacy heartbeat entity %s and rejects conflicting agents',
    (entityId) => {
      const heartbeat = {
        agentId: 'agent-id',
        entityId,
        tags: ['queue', 'repeat', 'heartbeat'],
      } as Task;
      expect(isAgentOwnedHeartbeat(heartbeat, 'agent-id')).toBe(true);
      expect(isTriggerTaskOwnedBy(heartbeat, localOwner, localOwner, 'agent-id')).toBe(true);
      expect(isTriggerTaskOwnedBy(heartbeat, foreignOwner, localOwner, 'agent-id')).toBe(false);
      expect(
        isTriggerTaskOwnedBy(
          { ...heartbeat, agentId: 'foreign-agent' },
          localOwner,
          localOwner,
          'agent-id'
        )
      ).toBe(false);
      expect(isAgentOwnedHeartbeat({ ...heartbeat, entityId: foreignOwner }, 'agent-id')).toBe(
        false
      );
    }
  );
});
