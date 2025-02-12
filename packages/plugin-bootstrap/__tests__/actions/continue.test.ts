import { describe, expect, it, vi, beforeEach } from 'vitest';
import { continueAction } from '../../src/actions/continue';
import { composeContext, generateMessageResponse, generateTrueOrFalse, ModelClass } from '@elizaos/core';

vi.mock('@elizaos/core', () => ({
    composeContext: vi.fn(),
    generateMessageResponse: vi.fn(),
    generateTrueOrFalse: vi.fn(),
    logger: {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        log: vi.fn()
    },
    messageCompletionFooter: '\nResponse format:\n```\n{"content": {"text": string}}\n```',
    booleanFooter: '\nResponse format: YES or NO',
    ModelClass: {
        SMALL: 'small',
        LARGE: 'large'
    }
}));

describe('continueAction', () => {
    let mockRuntime;
    let mockMessage;
    let mockState;
    let mockCallback;

    beforeEach(() => {
        mockRuntime = {
            character: {
                settings: {},
                name: 'TestBot',
                bio: 'A test bot',
                lore: 'Test lore',
                knowledge: 'Test knowledge',
                templates: {
                    messageHandlerTemplate: 'Test template {{agentName}}'
                }
            },
            messageManager: {
                getLastMessageInRoom: vi.fn().mockResolvedValue({
                    userId: 'test-user',
                    content: { text: 'Hello' }
                }),
                getMemories: vi.fn().mockResolvedValue([{
                    userId: 'test-agent',
                    content: { 
                        text: 'Previous bot message',
                        action: 'CONTINUE'
                    }
                }])
            },
            composeState: vi.fn().mockResolvedValue({
                agentId: 'test-agent',
                roomId: 'test-room'
            }),
            updateRecentMessageState: vi.fn().mockImplementation(state => Promise.resolve({
                ...state,
                recentMessagesData: [{
                    userId: 'test-agent',
                    content: { 
                        text: 'Previous bot message',
                        action: 'CONTINUE'
                    }
                }]
            })),
            agentId: 'test-agent',
            databaseAdapter: {
                log: vi.fn().mockResolvedValue(true)
            }
        };

        mockMessage = {
            id: 'test-message-1',
            content: {
                text: 'Hello, how are you'  // No question mark to avoid early return
            },
            roomId: 'test-room',
            userId: 'test-user',
            createdAt: Date.now()
        };

        mockState = {
            agentId: 'test-agent',
            roomId: 'test-room',
            recentMessagesData: [{
                id: 'test-message-2',
                userId: 'test-agent',
                content: { 
                    text: 'Previous bot message',
                    action: 'NONE',
                    inReplyTo: 'different-message-id'  // Different ID to avoid early return
                },
                createdAt: Date.now() - 1000
            }]
        };

        mockCallback = vi.fn();

        // Reset all mocks
        vi.clearAllMocks();
    });

    describe('validation', () => {
        it('should validate successfully when conditions are met', async () => {
            mockRuntime.messageManager.getMemories.mockResolvedValueOnce([{
                userId: 'test-agent',
                content: { 
                    text: 'Previous bot message',
                    action: 'NONE'
                }
            }]);

            const result = await continueAction.validate(mockRuntime, mockMessage);
            expect(result).toBe(true);
        });

        it('should fail validation when too many continues in a row', async () => {
            mockRuntime.messageManager.getMemories.mockResolvedValueOnce([
                {
                    userId: 'test-agent',
                    content: { 
                        text: 'Message 1',
                        action: 'CONTINUE'
                    }
                },
                {
                    userId: 'test-agent',
                    content: { 
                        text: 'Message 2',
                        action: 'CONTINUE'
                    }
                },
                {
                    userId: 'test-agent',
                    content: { 
                        text: 'Message 3',
                        action: 'CONTINUE'
                    }
                }
            ]);

            const result = await continueAction.validate(mockRuntime, mockMessage);
            expect(result).toBe(false);
        });
    });

    describe('action properties', () => {
        it('should have correct action properties', () => {
            expect(continueAction.name).toBe('CONTINUE');
            expect(continueAction.description).toBeDefined();
            expect(continueAction.examples).toBeDefined();
            expect(Array.isArray(continueAction.examples)).toBe(true);
        });

        it('should have valid examples', () => {
            continueAction.examples.forEach(example => {
                expect(Array.isArray(example)).toBe(true);
                example.forEach(interaction => {
                    expect(interaction).toHaveProperty('user');
                    expect(interaction).toHaveProperty('content');
                });
            });
        });
    });

    describe('message generation', () => {
        it('should generate continuation message', async () => {
            const mockResponse = {
                content: { 
                    text: 'This is a continuation message',
                    action: 'CONTINUE',
                    inReplyTo: 'test-message-1'
                }
            };

            const mockStateWithContext = {
                ...mockState,
                actionExamples: [],
                bio: mockRuntime.character.bio,
                lore: mockRuntime.character.lore,
                knowledge: mockRuntime.character.knowledge,
                agentName: mockRuntime.character.name,
                messageDirections: 'Test directions',
                recentMessages: 'Test recent messages',
                actions: 'Test actions',
                providers: [],
                attachments: []
            };

            mockRuntime.messageManager.getMemories.mockResolvedValueOnce([{
                id: 'test-message-2',
                userId: 'test-agent',
                content: { 
                    text: 'Previous bot message',
                    action: 'NONE',
                    inReplyTo: 'different-message-id'
                },
                createdAt: Date.now() - 1000
            }]);

            mockRuntime.updateRecentMessageState.mockResolvedValueOnce(mockStateWithContext);

            vi.mocked(composeContext).mockReturnValue('mock-context');
            vi.mocked(generateTrueOrFalse).mockResolvedValue(true);
            vi.mocked(generateMessageResponse).mockResolvedValue(mockResponse);

            await continueAction.handler(mockRuntime, mockMessage, mockStateWithContext, {}, mockCallback);

            expect(composeContext).toHaveBeenCalled();
            expect(generateTrueOrFalse).toHaveBeenCalled();
            expect(generateMessageResponse).toHaveBeenCalled();
            expect(mockCallback).toHaveBeenCalledWith(mockResponse);
            expect(mockRuntime.databaseAdapter.log).toHaveBeenCalled();
        });
    });
});
