import { describe, it, expect, vi } from 'vitest';
import { validateInstagramConfig, instagramEnvSchema } from '../src/environment';
import type { IAgentRuntime } from '@elizaos/core';

describe('Instagram Environment Configuration', () => {
  const mockRuntime: IAgentRuntime = {
    getSetting: vi.fn(),
  } as unknown as IAgentRuntime;

  it('validates correct Instagram configuration', async () => {
    const validConfig = {
      INSTAGRAM_DRY_RUN: false,
      INSTAGRAM_USERNAME: 'test_user',
      INSTAGRAM_PASSWORD: 'test_password',
      INSTAGRAM_APP_ID: 'test_app_id',
      INSTAGRAM_APP_SECRET: 'test_app_secret',
      INSTAGRAM_POST_INTERVAL_MIN: 60,
      INSTAGRAM_POST_INTERVAL_MAX: 120,
      INSTAGRAM_ENABLE_ACTION_PROCESSING: false,
      INSTAGRAM_ACTION_INTERVAL: 5,
      INSTAGRAM_MAX_ACTIONS: 1,
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'false';
      if (key === 'INSTAGRAM_ENABLE_ACTION_PROCESSING') return 'false';
      return validConfig[key as keyof typeof validConfig];
    });

    const config = await validateInstagramConfig(mockRuntime);
    expect(config).toEqual(validConfig);
  });

  it('validates configuration with optional business account', async () => {
    const validConfig = {
      INSTAGRAM_DRY_RUN: false,
      INSTAGRAM_USERNAME: 'test_user',
      INSTAGRAM_PASSWORD: 'test_password',
      INSTAGRAM_APP_ID: 'test_app_id',
      INSTAGRAM_APP_SECRET: 'test_app_secret',
      INSTAGRAM_BUSINESS_ACCOUNT_ID: 'business_123',
      INSTAGRAM_POST_INTERVAL_MIN: 60,
      INSTAGRAM_POST_INTERVAL_MAX: 120,
      INSTAGRAM_ENABLE_ACTION_PROCESSING: false,
      INSTAGRAM_ACTION_INTERVAL: 5,
      INSTAGRAM_MAX_ACTIONS: 1,
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'false';
      if (key === 'INSTAGRAM_ENABLE_ACTION_PROCESSING') return 'false';
      return validConfig[key as keyof typeof validConfig];
    });

    const config = await validateInstagramConfig(mockRuntime);
    expect(config).toEqual(validConfig);
  });

  it('throws error for invalid username format', async () => {
    const invalidConfig = {
      INSTAGRAM_DRY_RUN: false,
      INSTAGRAM_USERNAME: 'invalid@username',  // Invalid characters
      INSTAGRAM_PASSWORD: 'test_password',
      INSTAGRAM_APP_ID: 'test_app_id',
      INSTAGRAM_APP_SECRET: 'test_app_secret',
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'false';
      return invalidConfig[key as keyof typeof invalidConfig];
    });

    await expect(validateInstagramConfig(mockRuntime)).rejects.toThrow();
  });

  it('throws error for missing required fields', async () => {
    const invalidConfig = {
      INSTAGRAM_DRY_RUN: false,
      INSTAGRAM_USERNAME: 'test_user',
      // Missing password and other required fields
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'false';
      return invalidConfig[key as keyof typeof invalidConfig];
    });

    await expect(validateInstagramConfig(mockRuntime)).rejects.toThrow();
  });
});
