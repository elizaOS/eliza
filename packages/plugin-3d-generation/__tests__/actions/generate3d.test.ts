import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreeDGenerationPlugin } from '../../src';
import type { Memory, State, IAgentRuntime, HandlerCallback } from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';
import { fal } from '@fal-ai/client';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Mock external dependencies
vi.mock('@elizaos/core', () => ({
    elizaLogger: {
        log: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('@fal-ai/client', () => ({
    fal: {
        subscribe: vi.fn(),
    },
}));

vi.mock('fs', () => ({
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
}));

vi.mock('path', () => ({
    dirname: vi.fn().mockReturnValue('content_cache'),
}));

vi.mock('crypto', () => ({
    randomUUID: vi.fn().mockReturnValue('db98fb20-1f1f-4017-8314-7cc61e66c4e6'),
}));

// Get the ThreeDGeneration action from the plugin
const ThreeDGeneration = ThreeDGenerationPlugin.actions[0];

describe('ThreeDGeneration Action', () => {
    const mockRuntime: Required<Pick<IAgentRuntime, 'getSetting'>> = {
        getSetting: vi.fn(),
    };

    const mockMessage: Required<Pick<Memory, 'id' | 'content'>> = {
        id: 'test-message-id',
        content: {
            text: 'Generate a 3D model of a cute cat',
        },
    };

    const mockState: Required<Pick<State, 'messages' | 'context'>> = {
        messages: [],
        context: {},
    };

    const mockCallback: HandlerCallback = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn();
        mockRuntime.getSetting.mockReturnValue('test-fal-api-key');
    });

    describe('validate', () => {
        it('should validate successfully with API key', async () => {
            const result = await ThreeDGeneration.validate(mockRuntime, mockMessage);
            expect(result).toBe(true);
            expect(elizaLogger.log).toHaveBeenCalledWith('FAL_API_KEY present:', true);
        });

        it('should fail validation without API key', async () => {
            mockRuntime.getSetting.mockReturnValue(undefined);
            const result = await ThreeDGeneration.validate(mockRuntime, mockMessage);
            expect(result).toBe(false);
            expect(elizaLogger.log).toHaveBeenCalledWith('FAL_API_KEY present:', false);
        });
    });

    describe('handler', () => {
        beforeEach(() => {
            vi.mocked(fal.subscribe).mockResolvedValue({
                data: {
                    model_mesh: {
                        url: 'https://example.com/3d-model.glb',
                        file_name: 'model.glb',
                    },
                },
            });

            vi.mocked(global.fetch).mockResolvedValue({
                arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
            } as unknown as Response);
        });

        it('should handle successful 3D generation', async () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            await ThreeDGeneration.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            // Check initial message
            expect(mockCallback).toHaveBeenCalledWith({
                text: expect.stringContaining('I\'ll generate a 3D object based on your prompt'),
            });

            // Verify FAL API call
            expect(fal.subscribe).toHaveBeenCalledWith(expect.any(String), {
                input: expect.objectContaining({
                    prompt: expect.stringContaining('cute cat'),
                }),
                logs: true,
                onQueueUpdate: expect.any(Function),
            });

            // Verify file handling
            expect(fs.mkdirSync).toHaveBeenCalledWith('content_cache', { recursive: true });
            expect(fs.writeFileSync).toHaveBeenCalled();

            // Verify final callback
            expect(mockCallback).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    text: 'Here\'s your generated 3D object!',
                    attachments: [expect.objectContaining({
                        url: 'https://example.com/3d-model.glb',
                        title: 'Generated 3D',
                        source: 'ThreeDGeneration',
                        description: expect.stringContaining('cute cat'),
                        text: expect.stringContaining('cute cat'),
                    })],
                }),
                ['content_cache/generated_3d_model.glb']
            );
        });

        it('should handle empty or short prompts', async () => {
            const shortMessage: Memory = {
                id: 'test-message-id',
                content: {
                    text: 'hi',
                },
            };

            await ThreeDGeneration.handler(
                mockRuntime,
                shortMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith({
                text: expect.stringContaining('Could you please provide more details'),
            });
            expect(fal.subscribe).not.toHaveBeenCalled();
        });

        it('should handle FAL API errors', async () => {
            vi.mocked(fal.subscribe).mockRejectedValue(new Error('API Error'));

            await ThreeDGeneration.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenLastCalledWith({
                text: expect.stringContaining('3D generation failed'),
                error: true,
            });
        });

        it('should handle file system errors', async () => {
            vi.mocked(fs.writeFileSync).mockImplementation(() => {
                throw new Error('File system error');
            });

            await ThreeDGeneration.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenLastCalledWith({
                text: expect.stringContaining('3D generation failed'),
                error: true,
            });
        });

        it('should clean up prompt by removing mentions and commands', async () => {
            const messageWithMentions: Memory = {
                id: 'test-message-id',
                content: {
                    text: '<@123456> generate 3D a cute cat render 3D',
                },
            };

            await ThreeDGeneration.handler(
                mockRuntime,
                messageWithMentions,
                mockState,
                {},
                mockCallback
            );

            expect(fal.subscribe).toHaveBeenCalledWith(expect.any(String), {
                input: expect.objectContaining({
                    prompt: 'a cute cat',
                }),
                logs: true,
                onQueueUpdate: expect.any(Function),
            });
        });
    });
});
