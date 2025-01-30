// Mock declarations must come first
vi.mock('@elizaos/core');
vi.mock('ai-agent-sdk-js', () => {
    const mockCreateAndRegisterAgent = vi.fn();
    return {
        AgentSDK: vi.fn().mockImplementation(() => ({
            createAndRegisterAgent: mockCreateAndRegisterAgent
        })),
        parseNewAgentAddress: vi.fn().mockReturnValue('test-agent-address')
    };
});
vi.mock('../../src/types', () => ({
    isAgentSettings: vi.fn().mockReturnValue(true),
    AgentSettingsSchema: {}
}));

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { generateObject } from '@elizaos/core';
import { createAndRegisterAgent } from '../../src/actions/createAndRegisterAgent';
import { AgentSDK } from 'ai-agent-sdk-js';

describe('createAndRegisterAgent', () => {
    const mockRuntime: IAgentRuntime = {
        composeState: vi.fn(),
        updateRecentMessageState: vi.fn(),
        getSetting: vi.fn()
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
        userId: 'test-user',
        agentId: 'test-agent',
        roomId: 'test-room',
        content: {
            text: 'create agent'
        }
    } as Memory;

    const mockState: State = {};
    const mockCallback = vi.fn();
    const mockTx = {
        hash: 'test-hash',
        wait: vi.fn().mockResolvedValue({ hash: 'test-hash' })
    };
    const mockAgentSettings = {
        name: 'test-agent',
        description: 'test description',
        settings: {
            key: 'value'
        }
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(mockRuntime.composeState).mockResolvedValue(mockState);
        vi.mocked(mockRuntime.updateRecentMessageState).mockResolvedValue(mockState);
    });

    describe('validate', () => {
        it('should always return true', async () => {
            const result = await createAndRegisterAgent.validate(mockRuntime, mockMessage);
            expect(result).toBe(true);
        });
    });

    describe('handler', () => {
        it('should successfully create and register agent', async () => {
            // Mock generateObject to return agent settings
            vi.mocked(generateObject).mockResolvedValueOnce({
                object: mockAgentSettings
            });

            // Mock successful registration
            const mockAgent = {
                createAndRegisterAgent: vi.fn().mockResolvedValue(mockTx)
            };
            vi.mocked(AgentSDK).mockImplementation(() => mockAgent);

            await createAndRegisterAgent.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Agent created and registered successfully: test-agent-address'
            });
            expect(mockAgent.createAndRegisterAgent).toHaveBeenCalledWith({agentSettings: mockAgentSettings});
        });

        it('should handle agent settings generation failure', async () => {
            // Mock generateObject to throw an error
            vi.mocked(generateObject).mockRejectedValueOnce(
                new Error('Failed to generate settings')
            );

            await createAndRegisterAgent.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Failed to generate Agent settings. Please provide valid input.'
            });
        });

        it('should handle registration failure', async () => {
            // Mock generateObject to return agent settings
            vi.mocked(generateObject).mockResolvedValueOnce({
                object: mockAgentSettings
            });

            // Mock registration failure
            const mockAgent = {
                createAndRegisterAgent: vi.fn().mockRejectedValue(new Error('Registration failed'))
            };
            vi.mocked(AgentSDK).mockImplementation(() => mockAgent);

            await createAndRegisterAgent.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Error creating agent: Registration failed'
            });
        });
    });

    describe('metadata', () => {
        it('should have correct name and description', () => {
            expect(createAndRegisterAgent.name).toBe('CREATE_AND_REGISTER_AGENT');
            expect(createAndRegisterAgent.description).toContain('Create and register an agent with APRO');
        });

        it('should have valid examples', () => {
            expect(Array.isArray(createAndRegisterAgent.examples)).toBe(true);
            expect(createAndRegisterAgent.examples.length).toBeGreaterThan(0);
            
            createAndRegisterAgent.examples.forEach(example => {
                expect(Array.isArray(example)).toBe(true);
                expect(example.length).toBe(2);
                expect(example[1].content.action).toBe('CREATE_AND_REGISTER_AGENT');
            });
        });
    });
});
