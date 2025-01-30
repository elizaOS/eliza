import { describe, it, expect, vi } from 'vitest';
import { validateAsteraiConfig } from '../src/environment';
import type { IAgentRuntime } from '@elizaos/core';

describe('environment configuration', () => {
    const mockRuntime: IAgentRuntime = {
        getSetting: vi.fn(),
    } as unknown as IAgentRuntime;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should validate correct configuration', async () => {
        vi.mocked(mockRuntime.getSetting)
            .mockImplementation((key: string) => {
                const settings = {
                    ASTERAI_AGENT_ID: 'test-agent-id',
                    ASTERAI_PUBLIC_QUERY_KEY: 'test-query-key'
                };
                return settings[key as keyof typeof settings] || null;
            });

        const config = await validateAsteraiConfig(mockRuntime);
        expect(config).toEqual({
            ASTERAI_AGENT_ID: 'test-agent-id',
            ASTERAI_PUBLIC_QUERY_KEY: 'test-query-key'
        });
    });

    it('should throw error for missing ASTERAI_AGENT_ID', async () => {
        vi.mocked(mockRuntime.getSetting)
            .mockImplementation((key: string) => {
                const settings = {
                    ASTERAI_PUBLIC_QUERY_KEY: 'test-query-key'
                };
                return settings[key as keyof typeof settings] || null;
            });

        await expect(validateAsteraiConfig(mockRuntime))
            .rejects
            .toThrow('Asterai plugin configuration validation failed');
    });

    it('should throw error for missing ASTERAI_PUBLIC_QUERY_KEY', async () => {
        vi.mocked(mockRuntime.getSetting)
            .mockImplementation((key: string) => {
                const settings = {
                    ASTERAI_AGENT_ID: 'test-agent-id'
                };
                return settings[key as keyof typeof settings] || null;
            });

        await expect(validateAsteraiConfig(mockRuntime))
            .rejects
            .toThrow('Asterai plugin configuration validation failed');
    });
});
