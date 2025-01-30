import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IAgentRuntime, ModelClass, elizaLogger, generateObject } from '@elizaos/core';
import { EmailGenerationService } from '../emailGenerationService';
import { EmailGenerationSchema } from '../../schemas/emailGenerationSchema';

// Mock the generateObject function
vi.mock('@elizaos/core', async () => {
    const actual = await vi.importActual('@elizaos/core');
    return {
        ...actual,
        generateObject: vi.fn(),
        elizaLogger: {
            debug: vi.fn(),
            error: vi.fn()
        }
    };
});

describe('EmailGenerationService', () => {
    let service: EmailGenerationService;
    let mockRuntime: IAgentRuntime;

    beforeEach(() => {
        mockRuntime = {
            // Minimal mock implementation
        } as unknown as IAgentRuntime;

        service = new EmailGenerationService(mockRuntime);
        vi.clearAllMocks();
    });

    it('should generate structured email content', async () => {
        const mockEmailContent = {
            subject: 'Test Subject',
            blocks: [{
                type: 'paragraph',
                content: 'Test content',
                metadata: {}
            }],
            metadata: {
                tone: 'professional',
                intent: 'inform',
                priority: 'medium'
            }
        };

        (generateObject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            object: {
                name: 'generateEmail',
                parameters: mockEmailContent
            }
        });

        const result = await service.generateEmail({
            content: 'Write a test email',
            tone: 'professional'
        });

        expect(generateObject).toHaveBeenCalledWith(expect.objectContaining({
            runtime: mockRuntime,
            context: expect.any(String),
            modelClass: ModelClass.LARGE,
            schema: EmailGenerationSchema,
            schemaName: 'generateEmail',
            schemaDescription: "Generate a structured email"
        }));

        expect(result).toEqual(mockEmailContent);
    });

    it('should handle AI generation errors', async () => {
        const testError = new Error('AI generation failed');
        (generateObject as ReturnType<typeof vi.fn>).mockRejectedValueOnce(testError);

        await expect(async () => {
            await service.generateEmail({ content: 'test' });
        }).rejects.toThrow('AI generation failed');

        expect(elizaLogger.error).toHaveBeenCalled();
    });

    it('should validate input options', async () => {
        await expect(async () => {
            await service.generateEmail({ content: '' });
        }).rejects.toThrow();
    });
});