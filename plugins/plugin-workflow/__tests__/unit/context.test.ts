/**
 * Verifies workflow ownership tags against real, generated-default, and
 * identifier-bearing custom entity names through the runtime lookup seam.
 */
import type { IAgentRuntime, UUID } from '@elizaos/core';
import { describe, expect, it, vi } from 'vitest';
import { getUserTagName } from '../../src/utils/context';

describe('getUserTagName', () => {
  const userId = '12345678-1111-2222-3333-444455556666' as UUID;
  const agentId = '87654321-2222-3333-4444-555566667777' as UUID;

  it('formats userTag with real name when entity has custom name', async () => {
    const runtime = {
      agentId,
      getEntityById: vi.fn().mockResolvedValue({
        id: userId,
        names: ['Alice'],
      }),
    } as unknown as IAgentRuntime;

    const tag = await getUserTagName(runtime, userId);
    expect(tag).toBe('Alice_12345678_agent_87654321222233334444555566667777');
  });

  it('formats userTag as user_shortId when entity has default User + UUID name', async () => {
    const runtime = {
      agentId,
      getEntityById: vi.fn().mockResolvedValue({
        id: userId,
        names: [`User ${userId}`],
      }),
    } as unknown as IAgentRuntime;

    const tag = await getUserTagName(runtime, userId);
    expect(tag).toBe('user_12345678_agent_87654321222233334444555566667777');
  });

  it('does not false-negative on real names that contain short hex prefix', async () => {
    const runtime = {
      agentId,
      getEntityById: vi.fn().mockResolvedValue({
        id: userId,
        names: ['User12345678Special'],
      }),
    } as unknown as IAgentRuntime;

    const tag = await getUserTagName(runtime, userId);
    expect(tag).toBe('User12345678Special_12345678_agent_87654321222233334444555566667777');
  });

  it('preserves a custom name that contains the complete user ID', async () => {
    const runtime = {
      agentId,
      getEntityById: vi.fn().mockResolvedValue({
        id: userId,
        names: [`Customer ${userId}`],
      }),
    } as unknown as IAgentRuntime;

    const tag = await getUserTagName(runtime, userId);
    expect(tag).toBe(
      'Customer 12345678-1111-2222-3333-444455556666_12345678_agent_87654321222233334444555566667777'
    );
  });
});
