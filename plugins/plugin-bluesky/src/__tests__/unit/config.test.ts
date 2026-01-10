import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateBlueSkyConfig,
  hasBlueSkyEnabled,
  getPollInterval,
  getActionInterval,
  getPostIntervalRange,
  getMaxActionsProcessing,
  isPostingEnabled,
  shouldPostImmediately,
  isDMsEnabled,
} from '../../common/config.js';
import { IAgentRuntime } from '@elizaos/core';
import { BlueSkyError } from '../../common/types.js';

vi.mock('@elizaos/core', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('BlueSky Configuration', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockRuntime = {
      agentId: '00000000-0000-0000-0000-000000000123' as any,
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, any> = {
          BLUESKY_ENABLED: 'true',
          BLUESKY_HANDLE: 'test.bsky.social',
          BLUESKY_PASSWORD: 'test-password',
          BLUESKY_SERVICE: 'https://bsky.social',
          BLUESKY_DRY_RUN: 'false',
          BLUESKY_POLL_INTERVAL: '60',
          BLUESKY_ACTION_INTERVAL: '120',
          BLUESKY_POST_INTERVAL_MIN: '300',
          BLUESKY_POST_INTERVAL_MAX: '600',
          BLUESKY_MAX_ACTIONS_PROCESSING: '10',
          BLUESKY_ENABLE_POSTING: 'true',
          BLUESKY_POST_IMMEDIATELY: 'false',
          BLUESKY_ENABLE_DMS: 'true',
        };
        return settings[key];
      }),
    } as any;
  });

  describe('validateBlueSkyConfig', () => {
    it('should validate valid configuration', () => {
      const config = validateBlueSkyConfig(mockRuntime);

      expect(config).toEqual({
        handle: 'test.bsky.social',
        password: 'test-password',
        service: 'https://bsky.social',
        dryRun: false,
        maxPostLength: 300,
        pollInterval: 60,
        enablePost: true,
        postIntervalMin: 300,
        postIntervalMax: 600,
        enableActionProcessing: true,
        actionInterval: 120,
        postImmediately: false,
        maxActionsProcessing: 10,
        enableDMs: true,
      });
    });

    it('should throw error when handle is missing', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_HANDLE') return undefined;
        return 'value';
      });

      expect(() => validateBlueSkyConfig(mockRuntime)).toThrow('Invalid BlueSky configuration');
    });

    it('should throw error when password is missing', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_PASSWORD') return undefined;
        if (key === 'BLUESKY_HANDLE') return 'test.bsky.social';
        return 'value';
      });

      expect(() => validateBlueSkyConfig(mockRuntime)).toThrow('Invalid BlueSky configuration');
    });

    it('should use default service if not provided', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_SERVICE') return undefined;
        if (key === 'BLUESKY_HANDLE') return 'test.bsky.social';
        if (key === 'BLUESKY_PASSWORD') return 'test-password';
        return undefined;
      });

      const config = validateBlueSkyConfig(mockRuntime);

      expect(config.service).toBe('https://bsky.social');
    });

    it('should parse boolean dry run correctly', () => {
      // Test 'true' string
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_DRY_RUN') return 'true';
        if (key === 'BLUESKY_HANDLE') return 'test.bsky.social';
        if (key === 'BLUESKY_PASSWORD') return 'test-password';
        return undefined;
      });

      let config = validateBlueSkyConfig(mockRuntime);
      expect(config.dryRun).toBe(true);

      // Test 'false' string
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_DRY_RUN') return 'false';
        if (key === 'BLUESKY_HANDLE') return 'test.bsky.social';
        if (key === 'BLUESKY_PASSWORD') return 'test-password';
        return undefined;
      });

      config = validateBlueSkyConfig(mockRuntime);
      expect(config.dryRun).toBe(false);

      // Test undefined
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_DRY_RUN') return undefined;
        if (key === 'BLUESKY_HANDLE') return 'test.bsky.social';
        if (key === 'BLUESKY_PASSWORD') return 'test-password';
        return undefined;
      });

      config = validateBlueSkyConfig(mockRuntime);
      expect(config.dryRun).toBe(false);
    });
  });

  describe('hasBlueSkyEnabled', () => {
    it('should return true when enabled', () => {
      expect(hasBlueSkyEnabled(mockRuntime)).toBe(true);
    });

    it('should return false when disabled', () => {
      mockRuntime.getSetting = vi.fn(() => 'false');
      expect(hasBlueSkyEnabled(mockRuntime)).toBe(false);
    });

    it('should return false when not set', () => {
      mockRuntime.getSetting = vi.fn(() => undefined);
      expect(hasBlueSkyEnabled(mockRuntime)).toBe(false);
    });
  });

  describe('getPollInterval', () => {
    it('should return configured interval in milliseconds', () => {
      expect(getPollInterval(mockRuntime)).toBe(60000);
    });

    it('should return default when not configured', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_POLL_INTERVAL') return undefined;
        return undefined;
      });

      expect(getPollInterval(mockRuntime)).toBe(60000); // Default
    });

    it('should handle invalid number', () => {
      mockRuntime.getSetting = vi.fn(() => 'invalid');
      expect(getPollInterval(mockRuntime)).toBe(60000); // Default
    });
  });

  describe('getActionInterval', () => {
    it('should return configured interval in milliseconds', () => {
      expect(getActionInterval(mockRuntime)).toBe(120000);
    });

    it('should return default when not configured', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_ACTION_INTERVAL') return undefined;
        return undefined;
      });

      expect(getActionInterval(mockRuntime)).toBe(120000); // Default - 120 seconds in ms
    });
  });

  describe('getPostIntervalRange', () => {
    it('should return configured range in milliseconds', () => {
      const range = getPostIntervalRange(mockRuntime);
      expect(range.min).toBe(300000);
      expect(range.max).toBe(600000);
    });

    it('should return defaults when not configured', () => {
      mockRuntime.getSetting = vi.fn(() => undefined);
      const range = getPostIntervalRange(mockRuntime);
      expect(range.min).toBe(1800000); // 30 minutes
      expect(range.max).toBe(3600000); // 60 minutes
    });

    it('should handle partial configuration', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_POST_INTERVAL_MIN') return '300';
        return undefined;
      });

      const range = getPostIntervalRange(mockRuntime);
      expect(range.min).toBe(300000);
      expect(range.max).toBe(3600000); // Default max
    });
  });

  describe('getMaxActionsProcessing', () => {
    it('should return configured value', () => {
      expect(getMaxActionsProcessing(mockRuntime)).toBe(10);
    });

    it('should return default when not configured', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_MAX_ACTIONS_PROCESSING') return undefined;
        return '10';
      });

      expect(getMaxActionsProcessing(mockRuntime)).toBe(5); // Default
    });

    it('should handle invalid number', () => {
      mockRuntime.getSetting = vi.fn(() => 'invalid');
      expect(getMaxActionsProcessing(mockRuntime)).toBe(5); // Default
    });
  });

  describe('isPostingEnabled', () => {
    it('should return true when enabled', () => {
      expect(isPostingEnabled(mockRuntime)).toBe(true);
    });

    it('should return false when disabled', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_ENABLE_POSTING') return 'false';
        return 'true';
      });

      expect(isPostingEnabled(mockRuntime)).toBe(false);
    });

    it('should return true by default', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_ENABLE_POSTING') return undefined;
        return 'true';
      });

      expect(isPostingEnabled(mockRuntime)).toBe(true);
    });
  });

  describe('shouldPostImmediately', () => {
    it('should return true when enabled', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_POST_IMMEDIATELY') return 'true';
        return 'false';
      });

      expect(shouldPostImmediately(mockRuntime)).toBe(true);
    });

    it('should return false when disabled', () => {
      expect(shouldPostImmediately(mockRuntime)).toBe(false);
    });

    it('should return false by default', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_POST_IMMEDIATELY') return undefined;
        return 'false';
      });

      expect(shouldPostImmediately(mockRuntime)).toBe(false);
    });
  });

  describe('isDMsEnabled', () => {
    it('should return true when enabled', () => {
      expect(isDMsEnabled(mockRuntime)).toBe(true);
    });

    it('should return false when disabled', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_ENABLE_DMS') return 'false';
        return 'true';
      });

      expect(isDMsEnabled(mockRuntime)).toBe(false);
    });

    it('should return true by default', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_ENABLE_DMS') return undefined;
        return 'true';
      });

      expect(isDMsEnabled(mockRuntime)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty strings', () => {
      mockRuntime.getSetting = vi.fn(() => '');
      
      expect(hasBlueSkyEnabled(mockRuntime)).toBe(false);
      expect(isPostingEnabled(mockRuntime)).toBe(true); // Default to true when empty
      expect(shouldPostImmediately(mockRuntime)).toBe(false);
      expect(isDMsEnabled(mockRuntime)).toBe(true); // Default to true when empty
    });

    it('should handle whitespace strings', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_POLL_INTERVAL') return '  60  ';
        if (key === 'BLUESKY_HANDLE') return 'test.bsky.social';
        if (key === 'BLUESKY_PASSWORD') return 'test-password';
        return '  ';
      });

      expect(getPollInterval(mockRuntime)).toBe(60000);
    });

    it('should handle case variations', () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === 'BLUESKY_ENABLED') return 'TRUE';
        if (key === 'BLUESKY_ENABLE_POSTING') return 'True';
        if (key === 'BLUESKY_ENABLE_DMS') return 'FALSE';
        return 'test';
      });

      expect(hasBlueSkyEnabled(mockRuntime)).toBe(true);
      expect(isPostingEnabled(mockRuntime)).toBe(true);
      expect(isDMsEnabled(mockRuntime)).toBe(false);
    });
  });
}); 