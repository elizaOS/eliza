import { describe, it, expect, vi, beforeEach } from 'vitest';
import launchAgent from '../../src/actions/launchAgent';
import axios from 'axios';
import { ModelClass, elizaLogger, composeContext, generateObjectDeprecated } from '@elizaos/core';

vi.mock('axios');
vi.mock('@elizaos/core', () => ({
    elizaLogger: {
        log: vi.fn(),
        error: vi.fn(),
    },
    composeContext: vi.fn().mockReturnValue('mock-context'),
    generateObjectDeprecated: vi.fn(),
    ModelClass: {
        LARGE: 'large',
    },
}));

describe('launchAgent', () => {
    let mockRuntime;
    let mockMessage;
    let mockState;
    let mockCallback;

    beforeEach(() => {
        mockRuntime = {
            composeState: vi.fn().mockResolvedValue({}),
            updateRecentMessageState: vi.fn().mockResolvedValue({}),
            getSetting: vi.fn((key) => {
                if (key === 'AUTONOME_JWT_TOKEN') return 'mock-jwt-token';
                if (key === 'AUTONOME_RPC') return 'mock-rpc-url';
                return null;
            }),
        };

        mockMessage = {};
        mockState = {};
        mockCallback = vi.fn();

        vi.mocked(axios.post).mockReset();
        vi.mocked(generateObjectDeprecated).mockReset();
        vi.mocked(composeContext).mockReset().mockReturnValue('mock-context');
    });

    it('should validate correctly', async () => {
        const result = await launchAgent.validate(mockRuntime, mockMessage);
        expect(result).toBe(true);
    });

    it('should have correct action properties', () => {
        expect(launchAgent.name).toBe('LAUNCH_AGENT');
        expect(launchAgent.description).toBe('Launch an Eliza agent');
        expect(launchAgent.similes).toContain('CREATE_AGENT');
        expect(launchAgent.examples).toBeDefined();
        expect(Array.isArray(launchAgent.examples)).toBe(true);
    });

    it('should handle successful agent launch', async () => {
        const mockContent = {
            name: 'test-agent',
            config: '{"key": "value"}',
        };

        vi.mocked(axios.post).mockResolvedValueOnce({
            data: {
                app: {
                    id: 'mock-app-id',
                },
            },
        });

        vi.mocked(generateObjectDeprecated).mockResolvedValueOnce(mockContent);

        const result = await launchAgent.handler(
            mockRuntime,
            mockMessage,
            mockState,
            {},
            mockCallback
        );

        expect(result).toBe(true);
        expect(mockCallback).toHaveBeenCalledWith({
            text: `Successfully launch agent ${mockContent.name}`,
            content: {
                success: true,
                appId: 'https://dev.autonome.fun/autonome/mock-app-id/details',
            },
        });

        expect(axios.post).toHaveBeenCalledWith(
            'mock-rpc-url',
            {
                name: mockContent.name,
                config: mockContent.config,
                creationMethod: 2,
                envList: {},
                templateId: 'Eliza',
            },
            {
                headers: {
                    Authorization: 'Bearer mock-jwt-token',
                    'Content-Type': 'application/json',
                },
            }
        );
    });

    it('should handle invalid launch content', async () => {
        const mockInvalidContent = {
            invalidField: 'test',
        };

        vi.mocked(generateObjectDeprecated).mockResolvedValueOnce(mockInvalidContent);

        const result = await launchAgent.handler(
            mockRuntime,
            mockMessage,
            mockState,
            {},
            mockCallback
        );

        expect(result).toBe(false);
        expect(mockCallback).toHaveBeenCalledWith({
            text: 'Unable to process launch agent request. Invalid content provided.',
            content: { error: 'Invalid launch agent content' },
        });
    });

    it('should handle API error', async () => {
        const mockContent = {
            name: 'test-agent',
            config: '{"key": "value"}',
        };

        vi.mocked(generateObjectDeprecated).mockResolvedValueOnce(mockContent);
        vi.mocked(axios.post).mockResolvedValueOnce(undefined);

        await launchAgent.handler(
            mockRuntime,
            mockMessage,
            mockState,
            {},
            mockCallback
        );

        expect(mockCallback).toHaveBeenCalledWith({
            text: 'Error launching agent: Cannot read properties of undefined (reading \'data\')',
            content: { error: 'Cannot read properties of undefined (reading \'data\')' },
        });
    });
});
