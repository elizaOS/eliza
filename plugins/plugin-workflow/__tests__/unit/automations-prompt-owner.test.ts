import { describe, expect, test } from 'bun:test';
import { type AgentRuntime, deterministicOwnerEntityId, type Task } from '@elizaos/core';
import { buildAutomationListResponse } from '../../src/lib/automations-builder';

describe('Automations prompt ownership', () => {
  test.each([undefined, 'legacy-owner-label', '00000000-0000-4000-8000-000000000011'])(
    'uses canonical owner derivation for setting %s',
    async (configuredOwner) => {
      const agentId = '00000000-0000-4000-8000-000000000001';
      const owner = configuredOwner?.startsWith('00000000-')
        ? configuredOwner
        : deterministicOwnerEntityId(agentId);
      const triggerTask = (id: string, entityId?: string): Task =>
        ({
          id,
          name: 'TRIGGER_DISPATCH',
          tags: ['queue', 'repeat', 'trigger'],
          ...(entityId ? { entityId } : {}),
          metadata: {
            trigger: {
              triggerId: id,
              displayName: id,
              instructions: 'A saved prompt',
              triggerType: 'cron',
              cronExpression: '0 12 28 9 *',
              enabled: false,
              wakeMode: 'inject_now',
              createdBy: 'api',
              kind: 'prompt',
              runCount: 0,
            },
          },
        }) as Task;
      const tasks = [
        triggerTask('legacy-prompt'),
        triggerTask('owned-prompt', owner),
        triggerTask('foreign-prompt', 'owner-foreign'),
        {
          id: 'system-heartbeat',
          name: 'heartbeat',
          agentId,
          entityId: agentId,
          tags: ['queue', 'repeat', 'heartbeat'],
          metadata: { updateInterval: 60_000 },
        } as Task,
      ];
      const runtime = {
        agentId,
        character: { name: 'QA' },
        getSetting: (key: string) =>
          key === 'ELIZA_ADMIN_ENTITY_ID' ? configuredOwner : undefined,
        getRooms: async () => [],
        getTasks: async () => tasks,
        getService: () => null,
      } as unknown as AgentRuntime;

      const response = await buildAutomationListResponse(runtime, owner);
      expect(response.automations.map((item) => item.triggerId).sort()).toEqual([
        'legacy-prompt',
        'owned-prompt',
        'system-heartbeat',
      ]);
      expect(response.automations.find((item) => item.triggerId === 'legacy-prompt')?.status).toBe(
        'paused'
      );
      expect(
        response.automations.find((item) => item.triggerId === 'system-heartbeat')
      ).toMatchObject({
        system: true,
        status: 'system',
      });
    }
  );
});
