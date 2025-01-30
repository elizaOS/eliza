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
      INSTAGRAM_POST_INTERVAL_MIN: '60',
      INSTAGRAM_POST_INTERVAL_MAX: '120',
      INSTAGRAM_ENABLE_ACTION_PROCESSING: false,
      INSTAGRAM_ACTION_INTERVAL: '5',
      INSTAGRAM_MAX_ACTIONS: '1',
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'false';
      if (key === 'INSTAGRAM_ENABLE_ACTION_PROCESSING') return 'false';
      return validConfig[key as keyof typeof validConfig]?.toString() || null;
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
      INSTAGRAM_POST_INTERVAL_MIN: '60',
      INSTAGRAM_POST_INTERVAL_MAX: '120',
      INSTAGRAM_ENABLE_ACTION_PROCESSING: false,
      INSTAGRAM_ACTION_INTERVAL: '5',
      INSTAGRAM_MAX_ACTIONS: '1',
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'false';
      if (key === 'INSTAGRAM_ENABLE_ACTION_PROCESSING') return 'false';
      return validConfig[key as keyof typeof validConfig]?.toString() || null;
    });

    const config = await validateInstagramConfig(mockRuntime);
    expect(config).toEqual(validConfig);
  });

  it('validates configuration with enhanced image settings', async () => {
    const validConfig = {
      INSTAGRAM_DRY_RUN: false,
      INSTAGRAM_USERNAME: 'test_user',
      INSTAGRAM_PASSWORD: 'test_password',
      INSTAGRAM_APP_ID: 'test_app_id',
      INSTAGRAM_APP_SECRET: 'test_app_secret',
      INSTAGRAM_POST_INTERVAL_MIN: '60',
      INSTAGRAM_POST_INTERVAL_MAX: '120',
      INSTAGRAM_ENABLE_ACTION_PROCESSING: false,
      INSTAGRAM_ACTION_INTERVAL: '5',
      INSTAGRAM_MAX_ACTIONS: '1',
      INSTAGRAM_IMAGE_WIDTH: '1920',
      INSTAGRAM_IMAGE_HEIGHT: '1080',
      INSTAGRAM_IMAGE_NEGATIVE_PROMPT: 'blurry, low quality',
      INSTAGRAM_IMAGE_ITERATIONS: '30',
      INSTAGRAM_IMAGE_GUIDANCE_SCALE: '8.5',
      INSTAGRAM_IMAGE_SEED: '12345',
      INSTAGRAM_IMAGE_CFG_SCALE: '9',
      INSTAGRAM_IMAGE_SAFE_MODE: true,
      INSTAGRAM_IMAGE_STYLE_PRESET: 'test-preset',
      INSTAGRAM_IMAGE_HIDE_WATERMARK: true
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'false';
      if (key === 'INSTAGRAM_ENABLE_ACTION_PROCESSING') return 'false';
      if (key === 'INSTAGRAM_IMAGE_SAFE_MODE') return 'true';
      if (key === 'INSTAGRAM_IMAGE_HIDE_WATERMARK') return 'true';
      return validConfig[key as keyof typeof validConfig]?.toString() || null;
    });

    const config = await validateInstagramConfig(mockRuntime);
    expect(config).toEqual(validConfig);
  });

  it('validates configuration with partial image settings', async () => {
    const validConfig = {
      INSTAGRAM_DRY_RUN: false,
      INSTAGRAM_USERNAME: 'test_user',
      INSTAGRAM_PASSWORD: 'test_password',
      INSTAGRAM_APP_ID: 'test_app_id',
      INSTAGRAM_APP_SECRET: 'test_app_secret',
      INSTAGRAM_POST_INTERVAL_MIN: '60',
      INSTAGRAM_POST_INTERVAL_MAX: '120',
      INSTAGRAM_ENABLE_ACTION_PROCESSING: false,
      INSTAGRAM_ACTION_INTERVAL: '5',
      INSTAGRAM_MAX_ACTIONS: '1',
      INSTAGRAM_IMAGE_WIDTH: '1920',
      INSTAGRAM_IMAGE_HEIGHT: '1080',
      INSTAGRAM_IMAGE_NEGATIVE_PROMPT: 'blurry'
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'false';
      if (key === 'INSTAGRAM_ENABLE_ACTION_PROCESSING') return 'false';
      return validConfig[key as keyof typeof validConfig]?.toString() || null;
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
      return invalidConfig[key as keyof typeof invalidConfig]?.toString() || null;
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
      return invalidConfig[key as keyof typeof invalidConfig]?.toString() || null;
    });

    await expect(validateInstagramConfig(mockRuntime)).rejects.toThrow();
  });

  it('throws error for invalid image dimensions', async () => {
    const invalidConfig = {
      INSTAGRAM_DRY_RUN: false,
      INSTAGRAM_USERNAME: 'test_user',
      INSTAGRAM_PASSWORD: 'test_password',
      INSTAGRAM_APP_ID: 'test_app_id',
      INSTAGRAM_APP_SECRET: 'test_app_secret',
      INSTAGRAM_IMAGE_WIDTH: '-100',  // Invalid negative width
      INSTAGRAM_IMAGE_HEIGHT: '0',    // Invalid zero height
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'false';
      return invalidConfig[key as keyof typeof invalidConfig]?.toString() || null;
    });

    await expect(validateInstagramConfig(mockRuntime)).rejects.toThrow();
  });

  it('throws error for invalid numeric image settings', async () => {
    const invalidConfig = {
      INSTAGRAM_DRY_RUN: false,
      INSTAGRAM_USERNAME: 'test_user',
      INSTAGRAM_PASSWORD: 'test_password',
      INSTAGRAM_APP_ID: 'test_app_id',
      INSTAGRAM_APP_SECRET: 'test_app_secret',
      INSTAGRAM_IMAGE_GUIDANCE_SCALE: '-1',    // Invalid negative guidance scale
      INSTAGRAM_IMAGE_CFG_SCALE: '0',         // Invalid zero cfg scale
      INSTAGRAM_IMAGE_ITERATIONS: '-5'        // Invalid negative iterations
    };

    vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
      if (key === 'INSTAGRAM_DRY_RUN') return 'false';
      return invalidConfig[key as keyof typeof invalidConfig]?.toString() || null;
    });

    await expect(validateInstagramConfig(mockRuntime)).rejects.toThrow();
  });
});
