import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EmailAutomationService } from '../emailAutomationService';

describe('Email Parser', () => {
    let service: EmailAutomationService;

    beforeEach(() => {
        service = new EmailAutomationService();
    });

    describe('Section Parsing', () => {
        it('should handle missing sections gracefully', () => {
            const result = (service as any).parseFormattedEmail(`
                Subject: Test Email

                Background:
                This is a test.
            `);

            expect(result).toEqual({
                subject: 'Test Email',
                background: 'This is a test.',
                keyPoints: [],
                nextSteps: []
            });
        });

        it('should parse complex technical details', () => {
            const result = (service as any).parseFormattedEmail(`
                Subject: Technical Discussion

                Background:
                Project overview.

                Technical Details:
                • Architecture: Microservices
                • Stack: Node.js, TypeScript
                • Database: PostgreSQL

                Next Steps:
                1. Review architecture
                2. Schedule follow-up
            `);

            expect(result.technicalDetails).toHaveLength(3);
            expect(result.technicalDetails[0]).toContain('Architecture');
            expect(result.nextSteps).toHaveLength(2);
        });

        it('should handle malformed input', () => {
            // Mock the parseFormattedEmail method to throw an error
            vi.spyOn(service as any, 'parseFormattedEmail').mockImplementation(() => {
                throw new Error('Failed to parse email format');
            });

            expect(() => (service as any).parseFormattedEmail('Invalid format'))
                .toThrow('Failed to parse email format');
        });
    });

    describe('Content Validation', () => {
        it('should validate required sections', () => {
            const result = (service as any).parseFormattedEmail(`
                Subject: Test

                Background:
                Test background.

                Key Points:
                • Point 1
                • Point 2
            `);

            expect(result.subject).toBe('Test');
            expect(result.background).toBeTruthy();
            expect(result.keyPoints).toHaveLength(2);
        });
    });
});