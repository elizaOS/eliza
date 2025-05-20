import type { IAgentRuntime } from '@elizaos/core';
import { describe, expect, it } from 'vitest';
import { validateDiscordConfig } from '../src/environment';

// Mock runtime environment
const mockRuntime: IAgentRuntime = {
  env: {
    DISCORD_API_TOKEN: 'mocked-discord-token',
  },
  getEnv: function (key: string) {
    return this.env[key] || null;
  },
  getSetting: function (key: string) {
    return this.env[key] || null;
  },
} as unknown as IAgentRuntime;

describe('Discord Environment Configuration', () => {
  it('should validate correct configuration', async () => {
    const config = await validateDiscordConfig(mockRuntime);
    expect(config).toBeDefined();
    expect(config.DISCORD_API_TOKEN).toBe('mocked-discord-token');
  });

  it('should throw an error when DISCORD_API_TOKEN is missing', async () => {
    const invalidRuntime = {
      ...mockRuntime,
      env: {
        DISCORD_API_TOKEN: undefined,
      },
    } as IAgentRuntime;

    await expect(validateDiscordConfig(invalidRuntime)).rejects.toThrowError(
      'Discord configuration validation failed:\nDISCORD_API_TOKEN: Expected string, received null'
    );
  });

  it('should parse CHANNEL_IDS into an array when provided', async () => {
    const runtimeWithChannels = {
      ...mockRuntime,
      env: {
        DISCORD_API_TOKEN: 'mocked-discord-token',
        CHANNEL_IDS: '123, 456,789',
      },
      getEnv: function (key: string) {
        return this.env[key] || null;
      },
      getSetting: function (key: string) {
        return this.env[key] || null;
      },
    } as unknown as IAgentRuntime;

    const config = await validateDiscordConfig(runtimeWithChannels);
    expect(config.CHANNEL_IDS).toEqual(['123', '456', '789']);
  });

  it('should leave CHANNEL_IDS undefined when not provided', async () => {
    const config = await validateDiscordConfig(mockRuntime);
    expect(config.CHANNEL_IDS).toBeUndefined();
  });
});
