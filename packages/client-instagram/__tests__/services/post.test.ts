import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstagramPostService } from '../../src/services/post';
import { type IAgentRuntime, elizaLogger, generateImage } from '@elizaos/core';
import type { InstagramState } from '../../src/types';
import path from 'path';
import { promises as fs } from 'fs';

// Mock dependencies
vi.mock('@elizaos/core', () => ({
    elizaLogger: {
        log: vi.fn(),
        error: vi.fn(),
    },
    generateImage: vi.fn(),
    stringToUuid: vi.fn().mockReturnValue('mock-uuid'),
    getEmbeddingZeroVector: vi.fn().mockReturnValue([]),
}));

vi.mock('fs', () => ({
    promises: {
        mkdir: vi.fn(),
        writeFile: vi.fn(),
    },
}));

describe('InstagramPostService', () => {
    let service: InstagramPostService;
    let mockRuntime: IAgentRuntime;
    let mockState: InstagramState;

    beforeEach(() => {
        // Initialize mockRuntime with required properties for testing
        mockRuntime = {
            getSetting: vi.fn(),
            agentId: 'mock-agent-id',
            character: {
                settings: {
                    imageSettings: {
                        width: 1920,
                        height: 1080,
                        hideWatermark: true,
                        stylePreset: 'test-preset',
                    },
                },
                system: '',
                name: 'test-character',
                modelEndpointOverride: null,
            },
            cacheManager: {
                get: vi.fn(),
                set: vi.fn(),
            },
            messageManager: {
                createMemory: vi.fn(),
            },
            // Add minimal required properties for the test
            serverUrl: 'http://test.com',
            token: 'test-token',
            modelProvider: 'test-provider',
            imageModelProvider: 'test-image-provider',
            databaseAdapter: null,
            verifiableInferenceAdapter: null,
            fetch: vi.fn(),
            getService: vi.fn(),
        } as unknown as IAgentRuntime;

        mockState = {
            profile: {
                username: 'test_user',
            },
        } as InstagramState;

        service = new InstagramPostService(mockRuntime, mockState);
    });

    describe('Post Intervals', () => {
        it('uses Instagram-specific interval settings when available', async () => {
            vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
                switch (key) {
                    case 'INSTAGRAM_POST_INTERVAL_MIN':
                        return '120';
                    case 'INSTAGRAM_POST_INTERVAL_MAX':
                        return '240';
                    default:
                        return null;
                }
            });

            vi.mocked(mockRuntime.cacheManager.get).mockResolvedValue(null);

            await service.start();

            expect(mockRuntime.getSetting).toHaveBeenCalledWith('INSTAGRAM_POST_INTERVAL_MIN');
            expect(mockRuntime.getSetting).toHaveBeenCalledWith('INSTAGRAM_POST_INTERVAL_MAX');
        });

        it('falls back to generic interval settings when Instagram-specific ones are not set', async () => {
            vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
                switch (key) {
                    case 'POST_INTERVAL_MIN':
                        return '90';
                    case 'POST_INTERVAL_MAX':
                        return '180';
                    default:
                        return null;
                }
            });

            vi.mocked(mockRuntime.cacheManager.get).mockResolvedValue(null);

            await service.start();

            expect(mockRuntime.getSetting).toHaveBeenCalledWith('INSTAGRAM_POST_INTERVAL_MIN');
            expect(mockRuntime.getSetting).toHaveBeenCalledWith('POST_INTERVAL_MIN');
        });

        it('uses default intervals when no settings are available', async () => {
            vi.mocked(mockRuntime.getSetting).mockReturnValue(null);
            vi.mocked(mockRuntime.cacheManager.get).mockResolvedValue(null);

            await service.start();

            expect(mockRuntime.getSetting).toHaveBeenCalledWith('INSTAGRAM_POST_INTERVAL_MIN');
            expect(mockRuntime.getSetting).toHaveBeenCalledWith('POST_INTERVAL_MIN');
            // Default values should be used (60 and 120)
            expect(elizaLogger.log).toHaveBeenCalledWith(expect.stringContaining('Post interval:'));
        });
    });

    describe('Image Generation', () => {
        it('uses character image settings for generation', async () => {
            vi.mocked(generateImage).mockResolvedValue({
                success: true,
                data: ['data:image/png;base64,test123'],
            });

            await service['getOrGenerateImage']('test content');

            expect(generateImage).toHaveBeenCalledWith(
                expect.objectContaining({
                    width: 1920,
                    height: 1080,
                    hideWatermark: true,
                    stylePreset: 'test-preset',
                }),
                mockRuntime
            );
        });

        it('uses default values when image settings are not provided', async () => {
            // Ensure character and settings are defined before modifying
            mockRuntime.character = {
                ...mockRuntime.character,
                settings: {
                    imageSettings: {}
                }
            };

            vi.mocked(generateImage).mockResolvedValue({
                success: true,
                data: ['data:image/png;base64,test123'],
            });

            await service['getOrGenerateImage']('test content');

            expect(generateImage).toHaveBeenCalledWith(
                expect.objectContaining({
                    width: 1024,
                    height: 1024,
                    count: 1,
                    numIterations: 50,
                    guidanceScale: 7.5,
                }),
                mockRuntime
            );
        });

        it('handles image generation failure', async () => {
            vi.mocked(generateImage).mockResolvedValue({
                success: false,
                error: 'Generation failed',
            });

            await expect(service['getOrGenerateImage']('test content')).rejects.toThrow('Failed to generate image');
        });

        it('saves generated image to temp directory', async () => {
            vi.mocked(generateImage).mockResolvedValue({
                success: true,
                data: ['data:image/png;base64,test123'],
            });

            await service['getOrGenerateImage']('test content');

            expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('temp'), { recursive: true });
            expect(fs.writeFile).toHaveBeenCalledWith(
                expect.stringContaining('instagram-post-'),
                expect.any(Buffer)
            );
        });

        it('uses enhanced image generation settings when provided', async () => {
            // Ensure character and settings are defined before modifying
            mockRuntime.character = {
                ...mockRuntime.character,
                settings: {
                    imageSettings: {
                        width: 1920,
                        height: 1080,
                        hideWatermark: true,
                        stylePreset: 'test-preset',
                        negativePrompt: 'blurry, low quality',
                        numIterations: 30,
                        guidanceScale: 8.5,
                        seed: 12345,
                        cfgScale: 9,
                        safeMode: true
                    }
                }
            };

            vi.mocked(generateImage).mockResolvedValue({
                success: true,
                data: ['data:image/png;base64,test123'],
            });

            await service['getOrGenerateImage']('test content');

            expect(generateImage).toHaveBeenCalledWith(
                expect.objectContaining({
                    width: 1920,
                    height: 1080,
                    hideWatermark: true,
                    stylePreset: 'test-preset',
                    negativePrompt: 'blurry, low quality',
                    numIterations: 30,
                    guidanceScale: 8.5,
                    seed: 12345,
                    cfgScale: 9,
                    safeMode: true
                }),
                mockRuntime
            );
        });

        it('handles partial enhanced image settings', async () => {
            // Ensure character and settings are defined before modifying
            mockRuntime.character = {
                ...mockRuntime.character,
                settings: {
                    imageSettings: {
                        width: 1920,
                        height: 1080,
                        negativePrompt: 'blurry',
                        seed: 12345
                    }
                }
            };

            vi.mocked(generateImage).mockResolvedValue({
                success: true,
                data: ['data:image/png;base64,test123'],
            });

            await service['getOrGenerateImage']('test content');

            expect(generateImage).toHaveBeenCalledWith(
                expect.objectContaining({
                    width: 1920,
                    height: 1080,
                    negativePrompt: 'blurry',
                    seed: 12345,
                    count: 1,
                    numIterations: 50,
                    guidanceScale: 7.5
                }),
                mockRuntime
            );
        });
    });
});
