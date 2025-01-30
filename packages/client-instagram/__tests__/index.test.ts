import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstagramClientInterface } from '../src';
import { type IAgentRuntime, elizaLogger } from '@elizaos/core';
import { InstagramInteractionService } from '../src/services/interaction';
import { InstagramPostService } from '../src/services/post';

// Mock dependencies
vi.mock('@elizaos/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    elizaLogger: {
      log: vi.fn(),
      error: vi.fn(),
    },
    parseBooleanFromText: (value: string | undefined) => value === 'true',
  };
});

// Mock service instances
const mockPostService = {
  start: vi.fn().mockResolvedValue(undefined),
};

const mockInteractionService = {
  start: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../src/lib/auth', () => ({
  initializeClient: vi.fn().mockResolvedValue({
    ig: {},
    config: {
      INSTAGRAM_DRY_RUN: false,
      INSTAGRAM_ENABLE_ACTION_PROCESSING: true,
    },
  }),
}));

vi.mock('../src/services/post', () => ({
  InstagramPostService: vi.fn().mockImplementation(() => mockPostService),
}));

vi.mock('../src/services/interaction', () => ({
  InstagramInteractionService: vi.fn().mockImplementation(() => mockInteractionService),
}));

describe('InstagramClientInterface', () => {
  let mockRuntime: IAgentRuntime;
  const mockConfig = {
    INSTAGRAM_DRY_RUN: false,
    INSTAGRAM_USERNAME: 'test_user',
    INSTAGRAM_PASSWORD: 'test_password',
    INSTAGRAM_APP_ID: 'test_app_id',
    INSTAGRAM_APP_SECRET: 'test_app_secret',
    INSTAGRAM_POST_INTERVAL_MIN: 60,
    INSTAGRAM_POST_INTERVAL_MAX: 120,
    INSTAGRAM_ENABLE_ACTION_PROCESSING: true,
    INSTAGRAM_ACTION_INTERVAL: 5,
    INSTAGRAM_MAX_ACTIONS: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        if (key === 'INSTAGRAM_DRY_RUN' || key === 'INSTAGRAM_ENABLE_ACTION_PROCESSING') {
          return String(mockConfig[key as keyof typeof mockConfig]);
        }
        return mockConfig[key as keyof typeof mockConfig];
      }),
    } as unknown as IAgentRuntime;
  });

  it('starts successfully with all services', async () => {
    const result = await InstagramClientInterface.start(mockRuntime);

    expect(result).toBeDefined();
    expect(result.post).toBeDefined();
    expect(result.interaction).toBeDefined();
    expect(InstagramPostService).toHaveBeenCalled();
    expect(InstagramInteractionService).toHaveBeenCalled();
    expect(result.post.start).toHaveBeenCalled();
    expect(result.interaction.start).toHaveBeenCalled();
    expect(elizaLogger.log).toHaveBeenCalledWith('Instagram client configuration validated');
    expect(elizaLogger.log).toHaveBeenCalledWith('Instagram client initialized');
    expect(elizaLogger.log).toHaveBeenCalledWith('Instagram post service started');
    expect(elizaLogger.log).toHaveBeenCalledWith('Instagram interaction service started');
  });

  it('starts in dry-run mode', async () => {
    const dryRunConfig = { ...mockConfig, INSTAGRAM_DRY_RUN: true };
    mockRuntime.getSetting = vi.fn((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'true';
      if (key === 'INSTAGRAM_ENABLE_ACTION_PROCESSING') return String(dryRunConfig.INSTAGRAM_ENABLE_ACTION_PROCESSING);
      return dryRunConfig[key as keyof typeof dryRunConfig];
    });

    const result = await InstagramClientInterface.start(mockRuntime);

    expect(result).toBeDefined();
    expect(elizaLogger.log).toHaveBeenCalledWith('Instagram client running in dry-run mode');
    expect(mockPostService.start).not.toHaveBeenCalled();
    expect(mockInteractionService.start).not.toHaveBeenCalled();
  });

  it('handles errors during startup', async () => {
    const error = new Error('Startup failed');
    vi.mocked(mockRuntime.getSetting).mockImplementation(() => {
      throw error;
    });

    await expect(InstagramClientInterface.start(mockRuntime)).rejects.toThrow('Startup failed');
    expect(elizaLogger.error).toHaveBeenCalledWith('Failed to start Instagram client:', error);
  });

  it('stops gracefully', async () => {
    await InstagramClientInterface.stop(mockRuntime);
    expect(elizaLogger.log).toHaveBeenCalledWith('Stopping Instagram client services...');
  });
});
