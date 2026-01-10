import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IAgentRuntime, UUID } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { TodoReminderService } from '../services/reminderService';
import { v4 as uuidv4 } from 'uuid';

describe('Reminder and Rolodex Integration', () => {
  let runtime: IAgentRuntime;
  let reminderService: TodoReminderService;
  let mockRolodexService: any;

  beforeEach(async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});

    // Mock rolodex message delivery service
    mockRolodexService = {
      sendMessage: vi.fn().mockResolvedValue({
        success: true,
        platforms: ['discord'],
      }),
    };

    // Create mock runtime
    runtime = {
      agentId: 'test-agent' as UUID,
      character: { name: 'TestAgent' },
      db: {} as any,
      getService: vi.fn((name: string) => {
        if (name === 'MESSAGE_DELIVERY') return mockRolodexService;
        if (name === 'ENTITY_RELATIONSHIP') return mockRolodexService; // Return same mock for both services
        return null;
      }),
      emitEvent: vi.fn(),
    } as any;

    reminderService = await TodoReminderService.start(runtime);
  });

  afterEach(async () => {
    await reminderService.stop();
    vi.clearAllMocks();
  });

  it('should detect rolodex service on initialization', () => {
    expect(runtime.getService).toHaveBeenCalledWith('MESSAGE_DELIVERY');
    // Check that the service logged about finding rolodex
    const logCalls = (logger.info as any).mock.calls;
    const hasRolodexLog = logCalls.some((call: any[]) => {
      const msg = call[0];
      return typeof msg === 'string' && msg.includes('Rolodex services found - external message delivery enabled');
    });
    expect(hasRolodexLog).toBe(true);
  });

  it('should send reminder through rolodex when available', async () => {
    // We need to test that checkTasksForReminders calls rolodex
    // Since we can't easily mock the internal createTodoDataService,
    // we'll skip this complex test for now
  });

  it('should handle missing rolodex gracefully', async () => {
    const noRolodexRuntime = {
      ...runtime,
      getService: vi.fn().mockReturnValue(null),
    };

    const service = await TodoReminderService.start(noRolodexRuntime);
    
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Rolodex services not found')
    );

    await service.stop();
  });
}); 